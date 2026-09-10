-- transaction: yes
-- impact: instant-exclusive

-- t10: every reservation write declares an actor (DA007)
create function dastar.trg_actor_required() returns trigger
language plpgsql as $$
begin
  perform dastar.require_actor();
  return new;
end $$;

-- t20: transitions are an allowlist evaluated only when status changes (invariant 7, D41, D44)
create function dastar.trg_transition() returns trigger
language plpgsql as $$
declare
  pair text := old.status::text || '>' || new.status::text;
begin
  if new.status is distinct from old.status then
    if not (pair = any (array['held>confirmed', 'held>cancelled', 'held>expired',
                              'confirmed>seated', 'confirmed>cancelled',
                              'seated>completed', 'seated>cancelled'])) then
      raise exception 'illegal transition %', pair
        using errcode = 'DA005', detail = format('reservation=%s', old.id), hint = 'invariant 7 invalid_transition';
    end if;
    if new.status = 'expired' and old.hold_expires_at > dastar.dastar_now() then
      raise exception 'hold has not expired yet'
        using errcode = 'DA005', detail = format('reservation=%s expires_at=%s', old.id, old.hold_expires_at), hint = 'invariant 7 invalid_transition';
    end if;
    if new.status = 'cancelled' and coalesce(new.cancel_reason, '') = '' then
      raise exception 'cancel requires a reason'
        using errcode = 'DA005', detail = format('reservation=%s', old.id), hint = 'invariant 7 invalid_transition';
    end if;
    if old.status = 'held' then
      new.confirm_token_hash := null;
    end if;
  end if;
  return new;
end $$;

-- t30: an expired hold cannot be confirmed (invariant 2)
create function dastar.trg_expiry_guard() returns trigger
language plpgsql as $$
begin
  if old.status = 'held' and new.status = 'confirmed' and old.hold_expires_at <= dastar.dastar_now() then
    raise exception 'hold expired at %', old.hold_expires_at
      using errcode = 'DA001', detail = format('reservation=%s', old.id), hint = 'invariant 2 hold_expired';
  end if;
  return new;
end $$;

-- t40: the party fits the assignment; takes the unit locks first (invariant 4, D39)
create function dastar.trg_fit() returns trigger
language plpgsql as $$
declare
  cmin int; cmax int; members uuid[]; sorted uuid[]; u uuid;
begin
  if new.assignment_kind = 'unit' then
    select capacity_min, capacity_max, array[id] into cmin, cmax, members
      from dastar.unit where id = new.assignment_id and venue_id = new.venue_id;
  else
    select capacity_min, capacity_max, unit_ids into cmin, cmax, members
      from dastar.unit_combo where id = new.assignment_id and venue_id = new.venue_id;
  end if;
  if cmin is null then
    raise exception 'assignment % not found in venue %', new.assignment_id, new.venue_id
      using errcode = 'DA003', detail = format('reservation=%s', new.id), hint = 'invariant 4 party_does_not_fit';
  end if;
  select array_agg(x order by x) into sorted from unnest(members) x;
  foreach u in array sorted loop
    perform pg_advisory_xact_lock(dastar.unit_lock_key(u));
  end loop;
  -- re-read after the locks: a capacity edit may have committed while this transaction waited
  if new.assignment_kind = 'unit' then
    select capacity_min, capacity_max into cmin, cmax from dastar.unit where id = new.assignment_id;
  else
    select capacity_min, capacity_max into cmin, cmax from dastar.unit_combo where id = new.assignment_id;
  end if;
  if new.party_size < cmin or new.party_size > cmax then
    raise exception 'party of % does not fit assignment % (% to %)', new.party_size, new.assignment_id, cmin, cmax
      using errcode = 'DA003', detail = format('reservation=%s', new.id), hint = 'invariant 4 party_does_not_fit';
  end if;
  return new;
end $$;

-- t45: capacity edits take the unit lock and refuse to strand a live party (invariant 4, D40)
create function dastar.trg_capacity_guard() returns trigger
language plpgsql as $$
begin
  if new.capacity_min = old.capacity_min and new.capacity_max = old.capacity_max then
    return new;
  end if;
  perform pg_advisory_xact_lock(dastar.unit_lock_key(old.id));
  if exists (
    select 1 from dastar.reservation r
     where r.assignment_kind = 'unit' and r.assignment_id = old.id
       and dastar.effective_status(r.status, r.hold_expires_at) in ('held', 'confirmed', 'seated')
       and (r.party_size < new.capacity_min or r.party_size > new.capacity_max)) then
    raise exception 'capacity change would strand a live reservation on unit %', old.id
      using errcode = 'DA012', detail = format('unit=%s new_range=%s..%s', old.id, new.capacity_min, new.capacity_max), hint = 'invariant 4 capacity_conflict';
  end if;
  return new;
end $$;

-- t46: config version bumps on unit and combo writes, never on reservations (D17)
create function dastar.trg_config_version() returns trigger
language plpgsql as $$
begin
  update dastar.venue set config_version = config_version + 1
   where id = coalesce(new.venue_id, old.venue_id);
  return null;
end $$;

-- t47: combo membership and capacities are immutable (D34, DA011)
create function dastar.trg_combo_immutable() returns trigger
language plpgsql as $$
begin
  if new.unit_ids is distinct from old.unit_ids
     or new.capacity_min is distinct from old.capacity_min
     or new.capacity_max is distinct from old.capacity_max then
    raise exception 'combo members and capacities are immutable; deactivate and create a new combo'
      using errcode = 'DA011', detail = format('combo=%s', old.id), hint = 'supporting guard DA011 combo_immutable';
  end if;
  return new;
end $$;

-- t50: version and updated_at are managed here; a supplied version is overridden
create function dastar.trg_version() returns trigger
language plpgsql security definer set search_path = pg_catalog, dastar as $$
begin
  new.version := old.version + 1;
  new.updated_at := dastar.dastar_now();
  return new;
end $$;

-- t55: a token may be set only on a held, unexpired reservation; clearing is always allowed (D44, DA013)
create function dastar.trg_token_guard() returns trigger
language plpgsql as $$
begin
  if new.confirm_token_hash is not null and new.confirm_token_hash is distinct from old.confirm_token_hash then
    if old.status <> 'held' or new.status <> 'held' or old.hold_expires_at <= dastar.dastar_now() then
      raise exception 'a confirm token requires a held, unexpired reservation'
        using errcode = 'DA013', detail = format('reservation=%s status=%s', old.id, old.status), hint = 'supporting guard DA013 token_requires_held';
    end if;
  end if;
  return new;
end $$;

-- t60: every insert and update is audited; the audit trigger is the only writer of audit_log (invariants 5, 6)
create function dastar.trg_audit() returns trigger
language plpgsql security definer set search_path = pg_catalog, dastar as $$
declare
  act text; b jsonb; a jsonb;
begin
  if tg_op = 'INSERT' then
    act := 'insert'; b := null; a := to_jsonb(new) - 'confirm_token_hash';
  else
    if new.status is distinct from old.status then
      act := format('update:%s>%s', old.status, new.status);
    else
      act := 'update:metadata';
    end if;
    b := to_jsonb(old) - 'confirm_token_hash'; a := to_jsonb(new) - 'confirm_token_hash';
  end if;
  insert into dastar.audit_log (venue_id, entity, entity_id, action, before, after, actor, trace_id)
  values (new.venue_id, 'reservation', new.id, act, b, a, dastar.require_actor(), current_setting('dastar.trace_id', true));
  return null;
end $$;

-- t70: unit rows flip inactive on cancel or expiry; this is the only writer of active (invariant 8)
create function dastar.trg_sync_unit_rows() returns trigger
language plpgsql security definer set search_path = pg_catalog, dastar as $$
begin
  if new.status in ('cancelled', 'expired') and old.status not in ('cancelled', 'expired') then
    update dastar.reservation_unit set active = false where reservation_id = new.id and active;
  end if;
  return null;
end $$;

-- t80: unit rows are inserted only for a held reservation, active, with its range and venue (DA008)
create function dastar.trg_unit_row_insert_guard() returns trigger
language plpgsql as $$
declare
  r record;
begin
  select status, during, venue_id into r from dastar.reservation where id = new.reservation_id;
  if r is null then
    raise exception 'reservation % not found', new.reservation_id
      using errcode = 'DA008', detail = format('reservation_id=%s', new.reservation_id), hint = 'supporting guard DA008 range_mismatch';
  end if;
  if new.active is distinct from true or r.status <> 'held' or new.during <> r.during or new.venue_id <> r.venue_id then
    raise exception 'unit row must be active, for a held reservation, with the reservation range and venue'
      using errcode = 'DA008', detail = format('reservation=%s unit=%s', new.reservation_id, new.unit_id), hint = 'supporting guard DA008 range_mismatch';
  end if;
  return new;
end $$;

-- t90: at commit, the unit rows of a reservation equal its assignment's members, active or not (invariant 9)
create function dastar.trg_membership() returns trigger
language plpgsql as $$
declare
  rid uuid; kind dastar.assignment_kind; aid uuid; members uuid[]; rows_ uuid[];
begin
  if tg_table_name = 'reservation' then rid := new.id; else rid := new.reservation_id; end if;
  select assignment_kind, assignment_id into kind, aid from dastar.reservation where id = rid;
  if kind = 'unit' then members := array[aid];
  else select unit_ids into members from dastar.unit_combo where id = aid; end if;
  select array_agg(x order by x) into members from unnest(members) x;
  select array_agg(unit_id order by unit_id) into rows_ from dastar.reservation_unit where reservation_id = rid;
  if rows_ is distinct from members then
    raise exception 'unit rows do not match the assignment members'
      using errcode = 'DA010', detail = format('reservation=%s rows=%s members=%s', rid, rows_, members), hint = 'invariant 9 assignment_mismatch';
  end if;
  return null;
end $$;

-- audit_log is append-only (invariant 5, DA004)
create function dastar.trg_audit_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_log is append-only'
    using errcode = 'DA004', detail = format('operation=%s', tg_op), hint = 'invariant 5 audit_immutable';
end $$;

create trigger t10_actor_required before insert or update on dastar.reservation
  for each row execute function dastar.trg_actor_required();
create trigger t20_transition before update on dastar.reservation
  for each row execute function dastar.trg_transition();
create trigger t30_expiry_guard before update on dastar.reservation
  for each row execute function dastar.trg_expiry_guard();
create trigger t40_fit before insert or update of party_size, assignment_kind, assignment_id on dastar.reservation
  for each row execute function dastar.trg_fit();
create trigger t50_version before update on dastar.reservation
  for each row execute function dastar.trg_version();
create trigger t55_token_guard before update of confirm_token_hash on dastar.reservation
  for each row execute function dastar.trg_token_guard();
create trigger t60_audit after insert or update on dastar.reservation
  for each row execute function dastar.trg_audit();
create trigger t70_sync_unit_rows after update of status on dastar.reservation
  for each row execute function dastar.trg_sync_unit_rows();
create constraint trigger t90_membership after insert or update of assignment_kind, assignment_id on dastar.reservation
  deferrable initially deferred for each row execute function dastar.trg_membership();

create trigger t80_unit_row_insert_guard before insert on dastar.reservation_unit
  for each row execute function dastar.trg_unit_row_insert_guard();
create constraint trigger t90_membership_rows after insert or update on dastar.reservation_unit
  deferrable initially deferred for each row execute function dastar.trg_membership();

create trigger t45_capacity_guard before update of capacity_min, capacity_max on dastar.unit
  for each row execute function dastar.trg_capacity_guard();
create trigger t46_config_version after insert or update or delete on dastar.unit
  for each row execute function dastar.trg_config_version();
create trigger t46_config_version after insert or update or delete on dastar.unit_combo
  for each row execute function dastar.trg_config_version();
create trigger t47_combo_immutable before update of unit_ids, capacity_min, capacity_max on dastar.unit_combo
  for each row execute function dastar.trg_combo_immutable();

create trigger t10_audit_immutable before update or delete on dastar.audit_log
  for each row execute function dastar.trg_audit_immutable();
create trigger t11_audit_no_truncate before truncate on dastar.audit_log
  for each statement execute function dastar.trg_audit_immutable();

-- transaction: yes
-- impact: instant-exclusive
-- Invariant 12: a live reservation never uses an inactive unit or combination. A new reservation's assignment and
-- every unit it books are active (the fit trigger, after its unit locks), and a unit or combination with a live
-- reservation cannot be deactivated (two owner-run guards that take the same unit locks), so a deactivation and a
-- hold serialize on the unit locks and whichever runs second sees the other, as capacity edits do (D40).

-- t40: the fit check of 0006, owner-run as since 0007, now also refusing an inactive assignment on insert (DA015).
-- A replacement keeps the owner and the grants but not the security attributes, so they are restated.
create or replace function dastar.trg_fit() returns trigger
language plpgsql security definer set search_path = pg_catalog, dastar, pg_temp as $$
declare
  cmin int; cmax int; members uuid[]; sorted uuid[]; u uuid; usable boolean;
begin
  if tg_op = 'UPDATE'
     and new.party_size = old.party_size
     and new.assignment_kind = old.assignment_kind
     and new.assignment_id = old.assignment_id
     and not (old.status = 'held' and new.status = 'confirmed') then
    return new;
  end if;
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
  -- the same re-read for activity: a deactivation may have committed while this transaction waited. A combination is
  -- usable when it is active and every member is an active unit of its venue. Only an insert is judged: a held
  -- reservation cannot outlive a deactivation, which refuses while one is live.
  if tg_op = 'INSERT' then
    if new.assignment_kind = 'unit' then
      select active into usable from dastar.unit where id = new.assignment_id;
    else
      select c.active and not exists (
               select 1 from unnest(c.unit_ids) m
                where not exists (select 1 from dastar.unit x where x.id = m and x.venue_id = c.venue_id and x.active))
        into usable from dastar.unit_combo c where c.id = new.assignment_id;
    end if;
    if not coalesce(usable, false) then
      raise exception 'assignment % is not active', new.assignment_id
        using errcode = 'DA015', detail = format('reservation=%s', new.id), hint = 'invariant 12 assignment_inactive';
    end if;
  end if;
  if new.party_size < cmin or new.party_size > cmax then
    raise exception 'party of % does not fit assignment % (% to %)', new.party_size, new.assignment_id, cmin, cmax
      using errcode = 'DA003', detail = format('reservation=%s', new.id), hint = 'invariant 4 party_does_not_fit';
  end if;
  return new;
end $$;

-- t44 on unit: deactivating a unit takes its lock and is refused while a live reservation has an active unit row on it,
-- which covers reservations of combinations that contain it (DA016).
create function dastar.trg_unit_active_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, dastar, pg_temp as $$
declare
  live uuid;
begin
  if old.active and not new.active then
    perform pg_advisory_xact_lock(dastar.unit_lock_key(old.id));
    select r.id into live
      from dastar.reservation_unit ru join dastar.reservation r on r.id = ru.reservation_id
     where ru.unit_id = old.id and ru.active
       and dastar.effective_status(r.status, r.hold_expires_at) in ('held', 'confirmed', 'seated')
     limit 1;
    if live is not null then
      raise exception 'unit % has a live reservation', old.id
        using errcode = 'DA016', detail = format('reservation=%s', live), hint = 'invariant 12 assignment_in_use';
    end if;
  end if;
  return new;
end $$;

-- t44 on unit_combo: deactivating a combination takes its member units' locks in sorted order and is refused while a
-- live reservation is assigned to it (DA016).
create function dastar.trg_combo_active_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, dastar, pg_temp as $$
declare
  live uuid; u uuid;
begin
  if old.active and not new.active then
    for u in select distinct m from unnest(old.unit_ids) m order by m loop
      perform pg_advisory_xact_lock(dastar.unit_lock_key(u));
    end loop;
    select r.id into live from dastar.reservation r
     where r.assignment_kind = 'combo' and r.assignment_id = old.id
       and dastar.effective_status(r.status, r.hold_expires_at) in ('held', 'confirmed', 'seated')
     limit 1;
    if live is not null then
      raise exception 'combination % has a live reservation', old.id
        using errcode = 'DA016', detail = format('reservation=%s', live), hint = 'invariant 12 assignment_in_use';
    end if;
  end if;
  return new;
end $$;

-- t49 on venue: a venue's time zone is a name in Postgres's time zone database (DA017 otherwise). `at time zone` alone
-- would also accept a POSIX-style rule, so a typo with a trailing digit would pass as a fixed offset; the name must match
-- exactly. It reads only a system view, so it runs with the caller's rights.
create function dastar.trg_venue_timezone() returns trigger
language plpgsql set search_path = pg_catalog, dastar, pg_temp as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone) then
    raise exception 'unknown time zone %', new.timezone using errcode = 'DA017', hint = 'invalid_timezone';
  end if;
  return new;
end $$;

create trigger t44_unit_active_guard before update of active on dastar.unit
  for each row execute function dastar.trg_unit_active_guard();
create trigger t44_combo_active_guard before update of active on dastar.unit_combo
  for each row execute function dastar.trg_combo_active_guard();
create trigger t49_venue_timezone before insert or update of timezone on dastar.venue
  for each row execute function dastar.trg_venue_timezone();

revoke all on function dastar.trg_unit_active_guard() from public;
revoke all on function dastar.trg_combo_active_guard() from public;
revoke all on function dastar.trg_venue_timezone() from public;

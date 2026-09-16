-- transaction: yes
-- impact: instant-exclusive
-- Invariant 4 also holds across confirmation: the fit check runs on the transition held -> confirmed,
-- so a capacity edit that judged the hold expired cannot leave a confirmed party outside the range.
-- Every other status change (cancel, expire, seat, complete) skips the check.
create or replace function dastar.trg_fit() returns trigger
language plpgsql as $$
declare
  cmin int; cmax int; members uuid[]; sorted uuid[]; u uuid;
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
  if new.party_size < cmin or new.party_size > cmax then
    raise exception 'party of % does not fit assignment % (% to %)', new.party_size, new.assignment_id, cmin, cmax
      using errcode = 'DA003', detail = format('reservation=%s', new.id), hint = 'invariant 4 party_does_not_fit';
  end if;
  return new;
end $$;

drop trigger t40_fit on dastar.reservation;
create trigger t40_fit before insert or update of party_size, assignment_kind, assignment_id, status on dastar.reservation
  for each row execute function dastar.trg_fit();

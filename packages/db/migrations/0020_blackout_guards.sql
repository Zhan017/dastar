-- transaction: yes
-- impact: instant-exclusive
-- Invariant 11: a live reservation never overlaps an active blackout of its venue. Two owner-run guards enforce it
-- under the venue-level lock: reservation inserts take it shared and blackout writes take it exclusively, so whichever
-- transaction commits second sees the other (ADR 7). Both read ranges, so they run as the owner, which keeps the range
-- indexes usable under row-level security and keeps the caller's venue binding out of what they see.

-- t35: a reservation insert takes the shared venue lock and is refused inside an active blackout of its venue (DA009).
-- A hold already holds the lock, and taking it again is a no-op; a writer that bypasses the hold takes it here.
-- Ranges and venues are not updatable by the application role, so insert is enough.
create function dastar.trg_blackout_guard() returns trigger
language plpgsql security definer set search_path = pg_catalog, dastar, pg_temp as $$
declare
  blocking uuid;
begin
  perform pg_advisory_xact_lock_shared(dastar.venue_lock_key(new.venue_id));
  select b.id into blocking
    from dastar.blackout b
   where b.venue_id = new.venue_id and b.active and b.during && new.during
   limit 1;
  if blocking is not null then
    raise exception 'reservation range overlaps an active blackout of the venue'
      using errcode = 'DA009', detail = format('blackout=%s', blocking), hint = 'invariant 11 blackout';
  end if;
  return new;
end $$;

-- t10: a blackout write takes the venue lock exclusively. A blackout that is active after the write may not strand a
-- live reservation (held, confirmed, or seated by its effective status) with an active unit row over its range (DA014).
-- A deactivation, or an update that leaves an active blackout's range alone, takes the lock and cannot strand anything.
create function dastar.trg_blackout_write() returns trigger
language plpgsql security definer set search_path = pg_catalog, dastar, pg_temp as $$
declare
  stranded uuid;
  judge boolean := false;
begin
  perform pg_advisory_xact_lock(dastar.venue_lock_key(new.venue_id));
  -- OLD exists only on update, so it is read only there
  if new.active then
    if tg_op = 'INSERT' then
      judge := true;
    else
      judge := not old.active or new.during is distinct from old.during or new.venue_id is distinct from old.venue_id;
    end if;
  end if;
  if judge then
    select r.id into stranded
      from dastar.reservation_unit ru
      join dastar.reservation r on r.id = ru.reservation_id
     where ru.venue_id = new.venue_id and ru.active and ru.during && new.during
       and dastar.effective_status(r.status, r.hold_expires_at) in ('held', 'confirmed', 'seated')
     limit 1;
    if stranded is not null then
      raise exception 'blackout would strand a live reservation'
        using errcode = 'DA014', detail = format('reservation=%s', stranded), hint = 'invariant 11 blackout_conflict';
    end if;
  end if;
  return new;
end $$;

create trigger t35_blackout_guard before insert on dastar.reservation
  for each row execute function dastar.trg_blackout_guard();
create trigger t10_blackout_write before insert or update on dastar.blackout
  for each row execute function dastar.trg_blackout_write();

revoke all on function dastar.trg_blackout_guard() from public;
revoke all on function dastar.trg_blackout_write() from public;

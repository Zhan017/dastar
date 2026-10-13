-- transaction: yes
-- impact: instant-exclusive
-- Owner-run lookups and a view for row-level security (invariant 10, ADR 0006).

-- the venue of a reservation, for a caller that holds only its id; the caller then binds that venue
create function dastar.reservation_venue(p_reservation_id uuid) returns uuid
language sql stable security definer set search_path = pg_catalog, dastar, pg_temp as $$
  select r.venue_id from dastar.reservation r where r.id = p_reservation_id
$$;

-- the confirm-token check's single read: the venue and the token hash, or no row
create function dastar.reservation_token(p_reservation_id uuid) returns table (venue_id uuid, confirm_token_hash bytea)
language sql stable security definer set search_path = pg_catalog, dastar, pg_temp as $$
  select r.venue_id, r.confirm_token_hash from dastar.reservation r where r.id = p_reservation_id
$$;

revoke all on function dastar.reservation_venue(uuid) from public;
revoke all on function dastar.reservation_token(uuid) from public;
grant execute on function dastar.reservation_venue(uuid) to dastar_app;
grant execute on function dastar.reservation_token(uuid) to dastar_app;

-- the bound venue's active unit rows, read with the owner's privileges so the range index stays usable under
-- row-level security, and filtered here by the same rule the policies apply: bound to a venue, its rows; unbound, none
create view dastar.occupancy as
  select reservation_id, unit_id, during
    from dastar.reservation_unit
   where active and venue_id = nullif(current_setting('dastar.venue_id', true), '')::uuid;
revoke all on dastar.occupancy from public;
grant select on dastar.occupancy to dastar_app;

-- triggers that read tables to enforce an invariant run as the owner, so row-level security never changes what they see
alter function dastar.trg_fit() security definer set search_path = pg_catalog, dastar, pg_temp;
alter function dastar.trg_capacity_guard() security definer set search_path = pg_catalog, dastar, pg_temp;
alter function dastar.trg_unit_row_insert_guard() security definer set search_path = pg_catalog, dastar, pg_temp;
alter function dastar.trg_membership() security definer set search_path = pg_catalog, dastar, pg_temp;

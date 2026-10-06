-- The demo venue: six tables and two combinations, with fixed ids so a walkthrough can name them.
-- Applied as dastar_owner after the migrations; applying it again changes nothing. Not a migration:
-- a production database never carries it.
begin;
select set_config('dastar.actor', 'seed:demo', true), set_config('dastar.trace_id', 'seed-demo', true);

insert into dastar.venue (id, name, timezone, hold_ttl_seconds, max_live_holds_per_actor)
values ('0199a000-0000-7000-8000-000000000001', 'Dastarkhan', 'Asia/Almaty', 600, 5)
on conflict (id) do nothing;

insert into dastar.unit (id, venue_id, label, capacity_min, capacity_max) values
  ('0199a000-0000-7000-8000-000000000101', '0199a000-0000-7000-8000-000000000001', 'T1', 1, 2),
  ('0199a000-0000-7000-8000-000000000102', '0199a000-0000-7000-8000-000000000001', 'T2', 1, 2),
  ('0199a000-0000-7000-8000-000000000103', '0199a000-0000-7000-8000-000000000001', 'T3', 2, 4),
  ('0199a000-0000-7000-8000-000000000104', '0199a000-0000-7000-8000-000000000001', 'T4', 2, 4),
  ('0199a000-0000-7000-8000-000000000105', '0199a000-0000-7000-8000-000000000001', 'T5', 4, 6),
  ('0199a000-0000-7000-8000-000000000106', '0199a000-0000-7000-8000-000000000001', 'T6', 6, 8)
on conflict (id) do nothing;

-- T1+T2 seats a party of three or four; T3+T4 one of five to eight
insert into dastar.unit_combo (id, venue_id, label, unit_ids, capacity_min, capacity_max) values
  ('0199a000-0000-7000-8000-000000000201', '0199a000-0000-7000-8000-000000000001', 'T1+T2',
   array['0199a000-0000-7000-8000-000000000101', '0199a000-0000-7000-8000-000000000102']::uuid[], 3, 4),
  ('0199a000-0000-7000-8000-000000000202', '0199a000-0000-7000-8000-000000000001', 'T3+T4',
   array['0199a000-0000-7000-8000-000000000103', '0199a000-0000-7000-8000-000000000104']::uuid[], 5, 8)
on conflict (id) do nothing;

commit;

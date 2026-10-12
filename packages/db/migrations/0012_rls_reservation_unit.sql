-- transaction: yes
-- impact: instant-exclusive
-- invariant 10: a transaction bound to one venue reads and writes only that venue's unit rows; unbound, none.
-- One table per file: a migration that locks one table cannot deadlock against a live hold.
alter table dastar.reservation_unit enable row level security;
create policy venue_scope on dastar.reservation_unit for all to dastar_app
  using (venue_id = nullif(current_setting('dastar.venue_id', true), '')::uuid)
  with check (venue_id = nullif(current_setting('dastar.venue_id', true), '')::uuid);
create policy readonly_reads on dastar.reservation_unit for select to dastar_readonly using (true);

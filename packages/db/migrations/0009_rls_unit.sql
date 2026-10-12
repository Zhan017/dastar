-- transaction: yes
-- impact: instant-exclusive
-- invariant 10: a transaction bound to one venue reads and writes only that venue's units; unbound, none.
-- One table per file: a migration that locks one table cannot deadlock against a live hold.
alter table dastar.unit enable row level security;
create policy venue_scope on dastar.unit for all to dastar_app
  using (venue_id = nullif(current_setting('dastar.venue_id', true), '')::uuid)
  with check (venue_id = nullif(current_setting('dastar.venue_id', true), '')::uuid);
create policy readonly_reads on dastar.unit for select to dastar_readonly using (true);

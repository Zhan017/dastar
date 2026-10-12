-- transaction: yes
-- impact: instant-exclusive
-- invariant 10: a transaction bound to one venue reads and writes only that venue's row; unbound, none.
-- One table per file, so the migration holds one table's lock at a time; the runner retries a lock timeout, not a deadlock.
alter table dastar.venue enable row level security;
create policy venue_scope on dastar.venue for all to dastar_app
  using (id = nullif(current_setting('dastar.venue_id', true), '')::uuid)
  with check (id = nullif(current_setting('dastar.venue_id', true), '')::uuid);
create policy readonly_reads on dastar.venue for select to dastar_readonly using (true);

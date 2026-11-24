-- transaction: yes
-- impact: instant-exclusive
-- invariant 10: a transaction bound to one venue reads and writes only that venue's session holds; unbound, none.
-- One table per file, so the migration holds one table's lock at a time; the runner retries a lock timeout, not a deadlock.
alter table dastar_agent.session_hold enable row level security;
create policy venue_scope on dastar_agent.session_hold for all to dastar_app
  using (venue_id = nullif(current_setting('dastar.venue_id', true), '')::uuid)
  with check (venue_id = nullif(current_setting('dastar.venue_id', true), '')::uuid);

-- transaction: yes
-- impact: instant-exclusive
-- What the reference agent records beyond a transcript, and what it keeps between turns. The turn record is set on
-- reference assistant turns only: the model that answered, a hash of the prompt it ran under, how many provider calls
-- and regenerations the turn took, whether it ended in the fallback, the tokens it used, and how long it took. A turn of
-- an external session, and a user turn, leave all ten columns null. session_hold keeps the confirm token of each
-- reservation a session holds, encrypted by the agent, which writes it as dastar_app; the token is what confirms the
-- reservation, so reporting has no grant on the table.

alter table dastar_agent.turn
  add column model text,
  add column prompt_hash text,
  add column provider_calls smallint,
  add column regenerations smallint,
  add column fell_back boolean,
  add column input_tokens int,
  add column output_tokens int,
  add column cache_read_tokens int,
  add column cache_write_tokens int,
  add column latency_ms int;

-- One row per reservation a session holds. The pair (venue_id, session_id) references the session, so a row names its
-- session's venue and goes with the session when the worker deletes it.
create table dastar_agent.session_hold (
  session_id uuid not null,
  venue_id uuid not null,
  reservation_id uuid not null,
  confirm_token_enc bytea not null,
  created_at timestamptz not null default dastar.dastar_now(),
  primary key (session_id, reservation_id),
  constraint session_hold_session_fkey foreign key (venue_id, session_id) references dastar_agent.session (venue_id, id) on delete cascade
);
comment on table dastar_agent.session_hold is 'The confirm token of each reservation a reference session holds, encrypted by the agent; no reporting grant, since the token is a credential even encrypted.';
comment on column dastar_agent.session_hold.confirm_token_enc is 'The confirm token, encrypted by the agent app, which writes it as dastar_app; never read by reporting.';

-- The application inserts a hold row and rewrites its token when it mints a new one; it never changes a row's session,
-- venue, or reservation, and deletes none. The worker deletes the rows of an expired session with the session and
-- updates nothing. Reporting has no grant.
grant select, insert on dastar_agent.session_hold to dastar_app;
grant update (confirm_token_enc) on dastar_agent.session_hold to dastar_app;
grant select, delete on dastar_agent.session_hold to dastar_worker;

-- transaction: yes
-- impact: instant-exclusive
-- What the judge reads and writes. The judge is a process that reads each assistant turn of an audited session, checks
-- the reservation statements the turn made against what the session's calls observed, and stores its result in
-- dastar_agent.turn.judge_result. It connects as dastar_judge, which bypasses row-level security because it works across
-- every venue, and so holds only what the work needs: it reads the sessions, calls and turns; reads a reservation's id,
-- venue, status and hold expiry, and a venue's time zone, to say what a reservation is now; updates a turn's judge_result and
-- no other column; and counts its own provider calls per day in judge_day, a table no other role can touch. It has no grant
-- on session_hold, whose confirm tokens are credentials even encrypted, and none on audit_log or api_key.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'dastar_judge') then
    create role dastar_judge login bypassrls;
  end if;
end $$;

alter role dastar_judge set statement_timeout = '10s';
alter role dastar_judge set idle_in_transaction_session_timeout = '30s';

grant usage on schema dastar, dastar_agent to dastar_judge;

grant select on dastar_agent.session, dastar_agent.tool_call, dastar_agent.turn to dastar_judge;
grant update (judge_result) on dastar_agent.turn to dastar_judge;
grant select (id, venue_id, status, hold_expires_at) on dastar.reservation to dastar_judge;
grant select (id, timezone) on dastar.venue to dastar_judge;

-- the clock, a reservation's status as of now, and whether a session still exists, which the judge's statements call
grant execute on function dastar.dastar_now() to dastar_judge;
grant execute on function dastar.effective_status(dastar.reservation_status, timestamptz) to dastar_judge;
grant execute on function dastar_agent.session_live(dastar_agent.session_kind, timestamptz) to dastar_judge;

-- Whether the latest post of an external session asked for its turns to be judged. The application sets it with the post
-- and never writes a result; the judge reads it to find the turns that are due.
alter table dastar_agent.session add column judge_requested boolean not null default false;
comment on column dastar_agent.session.judge_requested is 'Set by the application when the latest post of the session asked for its assistant turns to be judged; read by the judge.';
grant update (judge_requested) on dastar_agent.session to dastar_app;

-- The provider calls the judge has made on each day, so that a daily cap holds across restarts. Only the judge reads or
-- writes it: row-level security is on and no policy exists, which the judge's bypass is the one way past.
create table dastar_agent.judge_day (
  day date primary key,
  calls int not null
);
comment on table dastar_agent.judge_day is 'The provider calls the judge has made per day, for its daily cap; no policy, so no role without bypassrls reads or writes it.';
alter table dastar_agent.judge_day enable row level security;
grant select, insert, update on dastar_agent.judge_day to dastar_judge;

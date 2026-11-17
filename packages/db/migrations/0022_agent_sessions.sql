-- transaction: yes
-- impact: instant-exclusive
-- What an agent did and said: the sessions an API key opens, the tool calls each session makes, and the turns of its
-- transcript, so that an audit can set what the agent claimed against what its calls observed. The API writes these
-- tables as dastar_app; the worker reads them and deletes expired sessions; reporting reads them. The audit's evidence
-- chain ends at dastar.audit_log, the engine's own record; nothing here is a second record of what the engine did.

create schema dastar_agent;
grant usage on schema dastar_agent to dastar_app, dastar_worker, dastar_readonly;

-- A reference session is one the product's own agent runs; an external session is one a builder opens with their own key.
create type dastar_agent.session_kind as enum ('reference', 'external');

-- A session belongs to one venue and one key. call_count is raised, under the row's lock, by the statement that starts a
-- call, so a cap on calls holds exactly under concurrent calls; audit is the result of the latest audit, audited_at the
-- time of the snapshot it read. The pair (venue_id, id) is what calls and turns reference, so neither can name another
-- venue than its session's.
create table dastar_agent.session (
  id uuid not null default uuidv7() primary key,
  venue_id uuid not null references dastar.venue (id),
  api_key_id uuid not null references dastar.api_key (id),
  kind dastar_agent.session_kind not null,
  started_at timestamptz not null default dastar.dastar_now(),
  last_seen_at timestamptz not null default dastar.dastar_now(),
  call_count int not null default 0 check (call_count >= 0),
  audit jsonb,
  audited_at timestamptz,
  unique (venue_id, id)
);

-- One call to one of the agent tools. It starts with the tool and its input, and is completed once, with the HTTP
-- status, the output, and the receipt the audit reads; a call that never completed has no completed_at.
-- turn_id is set by the reference agent to the turn the call answers. It has no foreign key: an external session's turns
-- are replaced on every post of its transcript, and a call does not follow them.
create table dastar_agent.tool_call (
  id bigint generated always as identity primary key,
  session_id uuid not null,
  venue_id uuid not null,
  turn_id bigint,
  tool text not null,
  input jsonb not null,
  status int,
  output jsonb,
  receipt jsonb,
  started_at timestamptz not null default dastar.dastar_now(),
  completed_at timestamptz,
  constraint tool_call_session_fkey foreign key (venue_id, session_id) references dastar_agent.session (venue_id, id) on delete cascade
);

-- One turn of a session's transcript, numbered from 0. The text is already scrubbed when it is written; claims are the
-- reservation statements an assistant turn made, and guardrail_fired and judge_result are the reference agent's own marks.
create table dastar_agent.turn (
  id bigint generated always as identity primary key,
  session_id uuid not null,
  venue_id uuid not null,
  seq int not null check (seq >= 0),
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  claims jsonb,
  guardrail_fired boolean not null default false,
  judge_result jsonb,
  at timestamptz,
  unique (session_id, seq),
  constraint turn_session_fkey foreign key (venue_id, session_id) references dastar_agent.session (venue_id, id) on delete cascade
);

-- a session's calls in order (turn's (session_id, seq) is served by its unique constraint); a key's sessions; and the
-- worker's purge of external sessions by the time they were last seen
create index tool_call_session on dastar_agent.tool_call (session_id, id);
create index session_api_key on dastar_agent.session (api_key_id);
create index session_external_last_seen on dastar_agent.session (last_seen_at) where kind = 'external';

-- The application starts and completes calls, touches and audits its sessions, and replaces a session's turns on a new
-- post; it never rewrites a session's key, venue, or kind, a call's tool or input, or a turn, and deletes no session or
-- call. The worker deletes expired sessions (their calls and turns go with them) and changes nothing.
grant select, insert on dastar_agent.session, dastar_agent.tool_call, dastar_agent.turn to dastar_app;
grant update (last_seen_at, call_count, audit, audited_at) on dastar_agent.session to dastar_app;
grant update (status, output, receipt, completed_at) on dastar_agent.tool_call to dastar_app;
grant delete on dastar_agent.turn to dastar_app;
grant select, delete on dastar_agent.session, dastar_agent.tool_call, dastar_agent.turn to dastar_worker;
grant select on dastar_agent.session, dastar_agent.tool_call, dastar_agent.turn to dastar_readonly;
grant usage on all sequences in schema dastar_agent to dastar_app;

-- Whether a session still exists for the API: a reference session always, an external one while it was last seen less
-- than 30 days (720 hours, not a calendar interval, so a change of daylight time does not move the edge) before now. The worker's
-- purge only reclaims the rows of sessions this says are gone. EXTERNAL_SESSION_RETENTION_DAYS, in the API's code, must equal it.
create function dastar_agent.session_live(p_kind dastar_agent.session_kind, p_last_seen_at timestamptz) returns boolean
language sql stable as $$
  select p_kind = 'reference' or p_last_seen_at > dastar.dastar_now() - make_interval(hours => 30 * 24)
$$;
revoke all on function dastar_agent.session_live(dastar_agent.session_kind, timestamptz) from public;
grant execute on function dastar_agent.session_live(dastar_agent.session_kind, timestamptz) to dastar_app, dastar_worker;

-- The venue of a live session the key owns, or null, for a caller that holds only the session's id and its key and has
-- not yet bound a venue; the caller then binds that venue. It runs as the owner so row-level security does not hide the row.
create function dastar_agent.session_venue(p_session_id uuid, p_api_key_id uuid) returns uuid
language sql stable security definer set search_path = pg_catalog, dastar_agent, pg_temp as $$
  select s.venue_id from dastar_agent.session s
   where s.id = p_session_id and s.api_key_id = p_api_key_id and dastar_agent.session_live(s.kind, s.last_seen_at)
$$;
revoke all on function dastar_agent.session_venue(uuid, uuid) from public;
grant execute on function dastar_agent.session_venue(uuid, uuid) to dastar_app;

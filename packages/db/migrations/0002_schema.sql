-- transaction: yes
-- impact: instant-exclusive
create type dastar.reservation_status as enum ('held', 'confirmed', 'seated', 'completed', 'cancelled', 'expired');
create type dastar.assignment_kind as enum ('unit', 'combo');

create table dastar.venue (
  id uuid primary key default uuidv7(),
  name text not null,
  timezone text not null,
  hold_ttl_seconds int not null default 600 check (hold_ttl_seconds between 60 and 3600),
  slot_minutes int not null default 15 check (slot_minutes in (5, 10, 15, 20, 30, 60)),
  availability_window_days int not null default 14 check (availability_window_days between 1 and 90),
  max_live_holds_per_actor int not null default 5 check (max_live_holds_per_actor between 1 and 100),
  config jsonb not null default '{}'::jsonb,
  config_version bigint not null default 0,
  created_at timestamptz not null default now()
);

create table dastar.unit (
  id uuid not null default uuidv7(),
  venue_id uuid not null references dastar.venue (id),
  label text not null,
  capacity_min int not null check (capacity_min >= 1),
  capacity_max int not null,
  active boolean not null default true,
  layout jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (id),
  unique (venue_id, id),
  constraint unit_capacity_order check (capacity_max >= capacity_min)
);

create table dastar.unit_combo (
  id uuid not null default uuidv7(),
  venue_id uuid not null references dastar.venue (id),
  label text not null,
  unit_ids uuid[] not null,
  capacity_min int not null check (capacity_min >= 1),
  capacity_max int not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (id),
  unique (venue_id, id),
  constraint combo_capacity_order check (capacity_max >= capacity_min),
  constraint combo_too_large check (cardinality(unit_ids) between 2 and 6)
);

create table dastar.reservation (
  id uuid not null default uuidv7(),
  venue_id uuid not null references dastar.venue (id),
  party_size int not null check (party_size >= 1),
  during tstzrange not null,
  status dastar.reservation_status not null,
  assignment_kind dastar.assignment_kind not null,
  assignment_id uuid not null,
  hold_expires_at timestamptz not null,
  version int not null default 1,
  confirm_token_hash bytea,
  cancel_reason text,
  external_ref text,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id),
  unique (venue_id, id),
  constraint duration_out_of_range check (
    lower_inc(during) and not upper_inc(during)
    and not lower_inf(during) and not upper_inf(during)
    and (upper(during) - lower(during)) between interval '5 minutes' and interval '12 hours')
);
create index reservation_held_expiry on dastar.reservation (hold_expires_at) where status = 'held';
create index reservation_actor_held on dastar.reservation (venue_id, created_by) where status = 'held';
create index reservation_external_ref on dastar.reservation (venue_id, external_ref) where external_ref is not null;

create table dastar.reservation_unit (
  venue_id uuid not null,
  reservation_id uuid not null,
  unit_id uuid not null,
  during tstzrange not null,
  active boolean not null default true,
  primary key (reservation_id, unit_id),
  foreign key (venue_id, reservation_id) references dastar.reservation (venue_id, id),
  foreign key (venue_id, unit_id) references dastar.unit (venue_id, id),
  constraint reservation_unit_no_overlap exclude using gist (unit_id with =, during with &&) where (active)
) with (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
create index reservation_unit_venue_during on dastar.reservation_unit using gist (venue_id, during) where (active);

create table dastar.idempotency (
  venue_id uuid not null references dastar.venue (id),
  actor text not null,
  key text not null,
  request_hash bytea not null,
  response jsonb,
  created_at timestamptz not null default now(),
  purge_at timestamptz not null,
  primary key (venue_id, actor, key)
);
create index idempotency_purge on dastar.idempotency (purge_at);

create table dastar.audit_log (
  id bigint generated always as identity primary key,
  venue_id uuid not null,
  entity text not null,
  entity_id uuid not null,
  action text not null,
  before jsonb,
  after jsonb,
  actor text not null,
  trace_id text,
  at timestamptz not null default now()
);
create index audit_log_entity on dastar.audit_log (entity_id, at);

create table dastar.outbox (
  id bigint generated always as identity primary key,
  venue_id uuid not null,
  topic text not null,
  payload jsonb not null,
  payload_version int not null default 1,
  created_at timestamptz not null default now(),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  published_at timestamptz,
  dead_lettered_at timestamptz
);
create index outbox_due on dastar.outbox (next_attempt_at, id) where published_at is null and dead_lettered_at is null;
create index outbox_published on dastar.outbox (published_at) where published_at is not null;

create table dastar.api_key (
  id uuid primary key default uuidv7(),
  label text not null,
  key_hash bytea not null unique,
  capabilities text[] not null,
  venue_ids uuid[],
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

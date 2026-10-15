-- transaction: yes
-- impact: instant-exclusive
-- Service periods and closures of a venue, and the venue-level lock the blackout guards use (invariant 11).

-- A weekly service period: ISO day (Monday = 1), opening and closing time, and for each party size the duration it books.
-- A period that ends after midnight has closes <= opens and says so with closes_next_day.
-- duration_by_size is an object whose keys are the largest party size a duration applies to (an integer 1 to 999, as
-- text) and whose values are whole minutes from 5 to 720, with at least one key. The CHECK asks jsonpath, with errors
-- silenced, so no input can raise an evaluation error in place of a check violation and the constraint calls no custom function.
create table dastar.schedule (
  id uuid not null default uuidv7(),
  venue_id uuid not null references dastar.venue (id),
  day_of_week smallint not null check (day_of_week between 1 and 7),
  opens time not null,
  closes time not null,
  closes_next_day boolean not null default false,
  duration_by_size jsonb not null,
  gap_minutes int not null default 0 check (gap_minutes between 0 and 720),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (id),
  unique (venue_id, id),
  constraint schedule_closes_next_day check (closes_next_day = (closes <= opens)),
  constraint duration_by_size_shape check (
    jsonb_typeof(duration_by_size) = 'object'
    and jsonb_path_exists(duration_by_size, '$.keyvalue()', '{}', true)
    and not jsonb_path_exists(duration_by_size,
      '$.keyvalue() ? (!(@.key like_regex "^[1-9][0-9]{0,2}$") || @.value.type() != "number" || @.value < 5 || @.value > 720 || @.value != @.value.floor())',
      '{}', true)
  )
);

-- A closure: a bounded (finite at both ends), non-empty, half-open range (as reservations use) during which the venue takes no reservation. The range is fixed once written;
-- to change it, deactivate the blackout and create another.
create table dastar.blackout (
  id uuid not null default uuidv7(),
  venue_id uuid not null references dastar.venue (id),
  during tstzrange not null,
  reason text not null check (length(reason) between 1 and 500),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (id),
  unique (venue_id, id),
  constraint blackout_during_bounded check (
    not isempty(during) and lower_inc(during) and not upper_inc(during) and not lower_inf(during) and not upper_inf(during)
    and isfinite(lower(during)) and isfinite(upper(during))
  )
);
create index blackout_venue_during on dastar.blackout using gist (venue_id, during) where (active);

grant select, insert on dastar.schedule, dastar.blackout to dastar_app, dastar_worker;
grant update (day_of_week, opens, closes, closes_next_day, duration_by_size, gap_minutes, active) on dastar.schedule to dastar_app, dastar_worker;
grant update (reason, active) on dastar.blackout to dastar_app, dastar_worker;
grant select on dastar.schedule, dastar.blackout to dastar_readonly;

-- t46: config version bumps on schedule and blackout writes, as on units and combos (D17)
create trigger t46_config_version after insert or update on dastar.schedule
  for each row execute function dastar.trg_config_version();
create trigger t46_config_version after insert or update on dastar.blackout
  for each row execute function dastar.trg_config_version();

-- The venue-level advisory lock key. Holds take the lock shared, blackout writes exclusively. The salt keeps it
-- apart from unit keys, which hash the bare id.
create function dastar.venue_lock_key(venue_id uuid) returns bigint
language sql immutable as $$
  select ('x' || substr(md5('venue:' || venue_id::text), 1, 16))::bit(64)::bigint
$$;
revoke all on function dastar.venue_lock_key(uuid) from public;
grant execute on function dastar.venue_lock_key(uuid) to dastar_app, dastar_worker, dastar_readonly;

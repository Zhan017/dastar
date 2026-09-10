-- transaction: yes
-- impact: instant-exclusive

-- Schema creation grants no privileges to PUBLIC by default, so without this
-- grant no non-owner role (including dastar_app, used by the app-role tests
-- in this migration's test suite) can even reference an object in this
-- schema by qualified name, let alone call one of the functions below.
-- Table-level DML grants remain out of scope here and land in a later task.
grant usage on schema dastar to dastar_app, dastar_worker, dastar_readonly;

create function dastar.dastar_now() returns timestamptz
language sql stable as $$ select now() $$;

create function dastar.unit_lock_key(unit_id uuid) returns bigint
language sql immutable as $$
  select ('x' || substr(md5(unit_id::text), 1, 16))::bit(64)::bigint
$$;

create function dastar.effective_status(status dastar.reservation_status, hold_expires_at timestamptz)
returns dastar.reservation_status
language sql stable as $$
  select case
    when status = 'held' and hold_expires_at <= dastar.dastar_now() then 'expired'::dastar.reservation_status
    else status
  end
$$;

create function dastar.require_actor() returns text
language plpgsql stable as $$
declare
  a text := current_setting('dastar.actor', true);
begin
  if a is null or a = '' then
    raise exception 'dastar.actor is not set for this transaction'
      using errcode = 'DA007', detail = 'every write must declare an actor', hint = 'supporting guard DA007 actor_required';
  end if;
  return a;
end
$$;

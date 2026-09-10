create or replace function dastar.dastar_now() returns timestamptz
language sql stable as $$
  select coalesce(nullif(current_setting('dastar.now', true), '')::timestamptz, now())
$$;

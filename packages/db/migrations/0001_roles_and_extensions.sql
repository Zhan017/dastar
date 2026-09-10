-- transaction: yes
-- impact: instant-exclusive
create extension if not exists btree_gist;

create schema if not exists dastar;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'dastar_app') then
    create role dastar_app login;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'dastar_worker') then
    create role dastar_worker login bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'dastar_readonly') then
    create role dastar_readonly login;
  end if;
end $$;

alter role dastar_app set statement_timeout = '10s';
alter role dastar_app set idle_in_transaction_session_timeout = '30s';
alter role dastar_worker set idle_in_transaction_session_timeout = '30s';

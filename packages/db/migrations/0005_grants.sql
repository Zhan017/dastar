-- transaction: yes
-- impact: instant-exclusive
-- schema USAGE was granted in 0003 alongside the functions it makes callable
grant usage on all sequences in schema dastar to dastar_app, dastar_worker;
grant execute on all functions in schema dastar to dastar_app, dastar_worker, dastar_readonly;

grant select on all tables in schema dastar to dastar_readonly;

grant select, insert, update on dastar.unit, dastar.api_key to dastar_app, dastar_worker;
grant select, insert on dastar.venue to dastar_app, dastar_worker;
grant update (name, timezone, hold_ttl_seconds, slot_minutes, availability_window_days, max_live_holds_per_actor, config) on dastar.venue to dastar_app, dastar_worker;

grant select, insert on dastar.unit_combo to dastar_app, dastar_worker;
grant update (label, active) on dastar.unit_combo to dastar_app, dastar_worker;

grant select, insert on dastar.reservation to dastar_app, dastar_worker;
grant update (status, cancel_reason, confirm_token_hash, external_ref, updated_at) on dastar.reservation to dastar_app, dastar_worker;

grant select, insert on dastar.reservation_unit to dastar_app, dastar_worker;

grant select, insert on dastar.idempotency to dastar_app, dastar_worker;
grant update (response) on dastar.idempotency to dastar_app, dastar_worker;
grant delete on dastar.idempotency to dastar_worker;

grant select on dastar.audit_log to dastar_app, dastar_worker;

grant select, insert on dastar.outbox to dastar_app, dastar_worker;
grant update, delete on dastar.outbox to dastar_worker;

grant select on dastar.schema_migration to dastar_app, dastar_worker;

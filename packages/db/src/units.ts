export { sortUnitIds } from "@dastar/core";

export const LOCK_UNIT_SQL = "select pg_advisory_xact_lock(dastar.unit_lock_key($1::uuid))";

/** The venue lock, shared: holds never block each other on it, and a blackout write, which takes it exclusively, waits for every hold in flight. */
export const LOCK_VENUE_SHARED_SQL = "select pg_advisory_xact_lock_shared(dastar.venue_lock_key($1::uuid))";

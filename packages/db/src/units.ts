export { sortUnitIds } from "@dastar/core";

export const LOCK_UNIT_SQL = "select pg_advisory_xact_lock(dastar.unit_lock_key($1::uuid))";

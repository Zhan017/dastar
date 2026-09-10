/** Lowercase hex order equals Postgres uuid byte order; used everywhere a unit set is locked or inserted. */
export function sortUnitIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((s) => s.toLowerCase()))].sort();
}

export const LOCK_UNIT_SQL = "select pg_advisory_xact_lock(dastar.unit_lock_key($1::uuid))";

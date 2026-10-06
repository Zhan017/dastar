/** Lowercase hex order equals Postgres uuid byte order; used everywhere a unit set is locked or inserted. */
export function sortUnitIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((s) => s.toLowerCase()))].sort();
}

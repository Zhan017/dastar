import type { ClientBase } from "pg";

export type BenchSeed = { venue: string; units: string[]; combos: string[] };

/** One venue with a high live-holds cap, units with capacities 2, 4, 6, 8 in rotation, and pair combos. */
export async function seedBench(owner: ClientBase, opts: { units?: number; combos?: number } = {}): Promise<BenchSeed> {
  const venue = (await owner.query(
    "insert into dastar.venue(name, timezone, hold_ttl_seconds, max_live_holds_per_actor) values ('Bench', 'UTC', 600, 100) returning id",
  )).rows[0].id as string;
  const n = opts.units ?? 40;
  const units: string[] = [];
  for (let i = 0; i < n; i++) {
    const max = 2 + (i % 4) * 2;
    units.push((await owner.query(
      "insert into dastar.unit(venue_id, label, capacity_min, capacity_max) values ($1, $2, 1, $3) returning id",
      [venue, `U${i + 1}`, max],
    )).rows[0].id as string);
  }
  const combos: string[] = [];
  const m = Math.min(opts.combos ?? 10, Math.floor(n / 2));
  for (let i = 0; i < m; i++) {
    const members = [units[2 * i]!, units[2 * i + 1]!].sort();
    combos.push((await owner.query(
      "insert into dastar.unit_combo(venue_id, label, unit_ids, capacity_min, capacity_max) values ($1, $2, $3::uuid[], 5, 12) returning id",
      [venue, `C${i + 1}`, members],
    )).rows[0].id as string);
  }
  return { venue, units, combos };
}

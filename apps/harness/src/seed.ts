import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ClientBase } from "pg";

const DEMO_SEED = fileURLToPath(new URL("../../../packages/db/seed/demo-venue.sql", import.meta.url));

/** The ids `packages/db/seed/demo-venue.sql` gives the demo venue, so a walkthrough can name them. */
export const DEMO = {
  venue: "0199a000-0000-7000-8000-000000000001",
  units: {
    T1: "0199a000-0000-7000-8000-000000000101", T2: "0199a000-0000-7000-8000-000000000102",
    T3: "0199a000-0000-7000-8000-000000000103", T4: "0199a000-0000-7000-8000-000000000104",
    T5: "0199a000-0000-7000-8000-000000000105", T6: "0199a000-0000-7000-8000-000000000106",
  },
  combos: { "T1+T2": "0199a000-0000-7000-8000-000000000201", "T3+T4": "0199a000-0000-7000-8000-000000000202" },
} as const;

/** Applies the demo venue seed as the owner; applying it again changes nothing. */
export async function seedDemo(owner: ClientBase): Promise<void> {
  await owner.query(await readFile(DEMO_SEED, "utf8"));
}

export type BenchSeed = { venue: string; units: string[]; combos: string[] };
export type SeedOptions = {
  units?: number;
  combos?: number;
  /** Venue hold TTL; the schema allows 60 to 3600. Default 600. */
  holdTtlSeconds?: number;
  /** Combos are every pair among the first four units, so combos share members. Overrides `combos`. */
  mesh?: boolean;
};

/** One venue with the highest live-holds cap, units with capacities 2, 4, 6, 8 in rotation, and pair combos. */
export async function seedBench(owner: ClientBase, opts: SeedOptions = {}): Promise<BenchSeed> {
  const venue = (await owner.query(
    "insert into dastar.venue(name, timezone, hold_ttl_seconds, max_live_holds_per_actor) values ('Bench', 'UTC', $1, 100) returning id",
    [opts.holdTtlSeconds ?? 600],
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
  const pairs: [number, number][] = [];
  if (opts.mesh) {
    if (n < 4) throw new Error("seed: mesh combos need at least four units");
    for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) pairs.push([a, b]);
  } else {
    const m = Math.min(opts.combos ?? 10, Math.floor(n / 2));
    for (let i = 0; i < m; i++) pairs.push([2 * i, 2 * i + 1]);
  }
  const combos: string[] = [];
  for (const [a, b] of pairs) {
    const members = [units[a]!, units[b]!].sort();
    combos.push((await owner.query(
      "insert into dastar.unit_combo(venue_id, label, unit_ids, capacity_min, capacity_max) values ($1, $2, $3::uuid[], 5, 12) returning id",
      [venue, `C${a + 1}-${b + 1}`, members],
    )).rows[0].id as string);
  }
  return { venue, units, combos };
}

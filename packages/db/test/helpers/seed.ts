import type { ClientBase } from "pg";

export type Seed = { venue: string; units: string[]; combos: { id: string; units: string[] }[] };

/** One API key written by the owner, with a hash no other call shares; returns its id. */
export async function seedKey(owner: ClientBase, opts: { capabilities?: string[]; venueIds?: string[] } = {}): Promise<string> {
  const r = await owner.query(
    "insert into dastar.api_key(label, key_hash, capabilities, venue_ids) values ('test', uuid_send(uuidv7()), $1::text[], $2::uuid[]) returning id",
    [opts.capabilities ?? ["read", "hold"], opts.venueIds ?? null],
  );
  return r.rows[0].id as string;
}

export async function seedVenue(owner: ClientBase, opts: { units?: number } = {}): Promise<Seed> {
  const venue = (await owner.query("insert into dastar.venue(name, timezone, hold_ttl_seconds) values ('Test', 'Europe/Berlin', 600) returning id")).rows[0].id as string;
  const n = opts.units ?? 6;
  const units: string[] = [];
  for (let i = 0; i < n; i++) {
    const cap = i < 4 ? 4 : 2;
    units.push((await owner.query("insert into dastar.unit(venue_id, label, capacity_min, capacity_max) values ($1, $2, 1, $3) returning id", [venue, `T${i + 1}`, cap])).rows[0].id as string);
  }
  const combos: Seed["combos"] = [];
  const pairs: [number, number][] = [[0, 1], [2, 3], [0, 2], [1, 3], [0, 3], [1, 2]];
  for (const [a, b] of pairs) {
    const members = [units[a]!, units[b]!].sort();
    const id = (await owner.query("insert into dastar.unit_combo(venue_id, label, unit_ids, capacity_min, capacity_max) values ($1, $2, $3::uuid[], 5, 8) returning id",
      [venue, `C${a + 1}${b + 1}`, members])).rows[0].id as string;
    combos.push({ id, units: members });
  }
  return { venue, units, combos };
}

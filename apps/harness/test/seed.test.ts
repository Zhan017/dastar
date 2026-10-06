import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client, Pool } from "pg";
import { createDastar } from "@dastar/db";
import { cloneDatabase, dropDatabase, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedDemo, DEMO } from "../src/seed.js";

describe("demo seed", () => {
  let conn: Conn; let owner: Client;
  beforeAll(async () => {
    conn = await cloneDatabase("harness_seed_demo");
    owner = new Client({ connectionString: conn.owner });
    await owner.connect();
  });
  afterAll(async () => { await owner.end(); await dropDatabase("harness_seed_demo"); });

  it("creates the venue with its fixed ids, and applying it again changes nothing", async () => {
    await seedDemo(owner);
    await seedDemo(owner);
    const counts = (await owner.query(
      `select (select count(*) from dastar.venue where id = $1)::int as venues,
              (select count(*) from dastar.unit where venue_id = $1)::int as units,
              (select count(*) from dastar.unit_combo where venue_id = $1)::int as combos`, [DEMO.venue])).rows[0];
    expect(counts).toEqual({ venues: 1, units: 6, combos: 2 });
    const ids = (await owner.query("select id from dastar.unit where venue_id = $1 order by label", [DEMO.venue])).rows.map((r) => r.id as string);
    expect(ids).toEqual(Object.values(DEMO.units));
  });

  it("seats the parties its tables and combinations are sized for, and refuses the rest", async () => {
    await seedDemo(owner);
    const pool = new Pool({ connectionString: conn.app, max: 2 });
    pool.on("error", () => undefined);
    const d = createDastar({ pool });
    let n = 0;
    const hold = (partySize: number, assignment: { kind: "unit" | "combo"; id: string }) => {
      n += 1;
      return d.hold({
        venueId: DEMO.venue, actor: `seed-test:${n}`, traceId: `seed-${n}`, idempotencyKey: `seed-${n}`,
        partySize, startsAt: new Date(Date.UTC(2042, 0, n, 19)).toISOString(), durationMinutes: 90, assignment,
      });
    };
    try {
      expect((await hold(2, { kind: "unit", id: DEMO.units.T1 })).ok).toBe(true);
      expect(await hold(3, { kind: "unit", id: DEMO.units.T1 })).toMatchObject({ ok: false, error: { code: "party_does_not_fit" } });
      expect((await hold(4, { kind: "combo", id: DEMO.combos["T1+T2"] })).ok).toBe(true);
      expect((await hold(8, { kind: "combo", id: DEMO.combos["T3+T4"] })).ok).toBe(true);
      expect(await hold(9, { kind: "unit", id: DEMO.units.T6 })).toMatchObject({ ok: false, error: { code: "party_does_not_fit" } });
    } finally {
      await d.close();
      await pool.end();
    }
  });
});

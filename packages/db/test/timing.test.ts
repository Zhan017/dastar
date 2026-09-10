import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { seedVenue, type Seed } from "./helpers/seed.js";
import { hold, type HoldInput } from "../src/commands/hold.js";
import { cancel } from "../src/commands/cancel.js";

function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

describe("H2: hold transaction duration, single connection, no contention", () => {
  let conn: Conn; let owner: Client; let app: Client; let seed: Seed;
  beforeAll(async () => {
    conn = await cloneDatabase("timing_test");
    owner = await connect(conn.owner); app = await connect(conn.app);
    seed = await seedVenue(owner, { units: 40 });
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100 where id = $1", [seed.venue]);
  });
  afterAll(async () => { await app.end(); await owner.end(); await dropDatabase("timing_test"); });

  it("measures 300 holds on distinct slots, and 300 conflicts", async () => {
    const okMs: number[] = []; const conflictMs: number[] = [];
    const base = Date.UTC(2039, 0, 1, 8);
    for (let k = 0; k < 300; k++) {
      const i: HoldInput = { venueId: seed.venue, actor: `key:t${k % 50}`, traceId: `t${k}`, idempotencyKey: `ok${k}`, partySize: 2,
        startsAt: new Date(base + k * 3_600_000).toISOString(), durationMinutes: 60, assignment: { kind: "unit", id: seed.units[k % 40]! } };
      const t0 = performance.now();
      const out = await hold(app, i);
      okMs.push(performance.now() - t0);
      expect(out.ok).toBe(true);
    }
    for (let k = 0; k < 300; k++) {
      const i: HoldInput = { venueId: seed.venue, actor: `key:c${k % 50}`, traceId: `c${k}`, idempotencyKey: `cf${k}`, partySize: 2,
        startsAt: new Date(base + k * 3_600_000).toISOString(), durationMinutes: 60, assignment: { kind: "unit", id: seed.units[k % 40]! } };
      const t0 = performance.now();
      const out = await hold(app, i);
      conflictMs.push(performance.now() - t0);
      expect(out).toMatchObject({ ok: false, error: { code: "hold_conflict" } });
    }
    const line = `H2 single-connection: success p50=${pct(okMs, 50).toFixed(1)}ms p95=${pct(okMs, 95).toFixed(1)}ms p99=${pct(okMs, 99).toFixed(1)}ms; conflict p50=${pct(conflictMs, 50).toFixed(1)}ms p95=${pct(conflictMs, 95).toFixed(1)}ms p99=${pct(conflictMs, 99).toFixed(1)}ms`;
    console.log(line);
    expect(okMs.length).toBe(300);
  });
});

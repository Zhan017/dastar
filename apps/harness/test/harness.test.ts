import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool, Client } from "pg";
import { createDastar } from "@dastar/db";
import { cloneDatabase, dropDatabase, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedBench } from "../src/seed.js";
import { runRace } from "../src/race.js";
import { disableProtections, runNaive } from "../src/naive.js";

describe("harness", () => {
  let race: Conn; let naive: Conn;
  beforeAll(async () => {
    race = await cloneDatabase("harness_race");
    naive = await cloneDatabase("harness_naive");
  });
  afterAll(async () => { await dropDatabase("harness_race"); await dropDatabase("harness_naive"); });

  it("race: one winner, N minus one conflicts, zero overlaps", async () => {
    const owner = new Client({ connectionString: race.owner });
    await owner.connect();
    const seed = await seedBench(owner, { units: 4, combos: 1 });
    const pool = new Pool({ connectionString: race.app, max: 16 });
    const d = createDastar({ pool, acquireTimeoutMs: 60_000, deadlineMs: 60_000 });
    const r = await runRace(d, owner, seed, 200);
    expect(r).toMatchObject({ n: 200, winners: 1, conflicts: 199, overlaps: 0, other: {} });
    expect(r.latencyMs.count).toBe(200);
    await d.close(); await pool.end(); await owner.end();
  });

  it("naive: a plain check-then-insert double-books once every worker has passed the check", async () => {
    await disableProtections(naive.owner);
    const r = await runNaive(naive.owner, 20);
    expect(r.n).toBe(20);
    expect(r.committed).toBe(20);
    expect(r.overlaps).toBeGreaterThan(0);
  });
});

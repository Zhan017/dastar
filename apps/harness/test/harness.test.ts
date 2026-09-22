import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool, Client } from "pg";
import { createDastar } from "@dastar/db";
import { cloneDatabase, dropDatabase, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedBench } from "../src/seed.js";
import { runRace } from "../src/race.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disableProtections, runNaive, NAIVE_DB_RE, benchDatabaseName, createThrowawayDatabase, dropNaiveDatabase } from "../src/naive.js";

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

  it("the throwaway database is created only under a generated name and never replaces an existing one", async () => {
    const adminUrl = `${process.env.DASTAR_TEST_PG_BASE}/postgres`;
    const migrations = new URL("../../../packages/db/migrations", import.meta.url).pathname;
    await expect(dropNaiveDatabase(adminUrl, "harness_naive")).rejects.toThrow(/refusing to drop/);
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    expect((await admin.query("select 1 from pg_database where datname = 'harness_naive'")).rowCount).toBe(1);
    const taken = "dastar_naive_deadbeef";
    await admin.query(`drop database if exists "${taken}" with (force)`);
    await admin.query(`create database "${taken}"`);
    await expect(createThrowawayDatabase(adminUrl, taken, migrations)).rejects.toThrow(/already exists/);
    expect((await admin.query("select 1 from pg_database where datname = $1", [taken])).rowCount).toBe(1);
    await expect(createThrowawayDatabase(adminUrl, "not_a_naive_name", migrations)).rejects.toThrow(/must match/);
    await dropNaiveDatabase(adminUrl, taken);
    expect((await admin.query("select 1 from pg_database where datname = $1", [taken])).rowCount).toBe(0);
    expect(NAIVE_DB_RE.test(taken)).toBe(true);
    await admin.end();
  });

  it("a throwaway database whose migration fails is dropped again; bench names pass the same guard", async () => {
    const adminUrl = `${process.env.DASTAR_TEST_PG_BASE}/postgres`;
    const name = benchDatabaseName();
    expect(name).toMatch(/^dastar_bench_[0-9a-f]{8}$/);
    expect(NAIVE_DB_RE.test(name)).toBe(true);
    const broken = await mkdtemp(join(tmpdir(), "dastar-broken-"));
    await writeFile(join(broken, "0001_broken.sql"), "-- transaction: yes\n-- impact: instant-exclusive\nselect 1 / 0;\n");
    await expect(createThrowawayDatabase(adminUrl, name, broken)).rejects.toThrow(/division by zero/);
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    expect((await admin.query("select 1 from pg_database where datname = $1", [name])).rowCount).toBe(0);
    await admin.end();
  });
});

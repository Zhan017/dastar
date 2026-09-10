import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { readFile } from "node:fs/promises";
import { cloneDatabase, dropDatabase, connect } from "./helpers/db.js";
import { setClock } from "./helpers/clock.js";

describe("clock and derived functions", () => {
  let app: Client;
  beforeAll(async () => { app = await connect((await cloneDatabase("clock_test")).app); });
  afterAll(async () => { await app.end(); await dropDatabase("clock_test"); });

  it("dastar_now follows now() unless the test override is set", async () => {
    const real = (await app.query("select now() as n, dastar.dastar_now() as d")).rows[0];
    expect(Math.abs(new Date(real.d).getTime() - new Date(real.n).getTime())).toBeLessThan(1000);
    await setClock(app, "2030-01-01T12:00:00Z");
    const fake = (await app.query("select dastar.dastar_now() as d")).rows[0].d;
    expect(new Date(fake).toISOString()).toBe("2030-01-01T12:00:00.000Z");
    await setClock(app, null);
  });

  it("the production migration defines dastar_now as now() only", async () => {
    const sql = await readFile(new URL("../migrations/0003_functions.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/create function dastar\.dastar_now\(\)[\s\S]*?\$\$\s*select now\(\)\s*\$\$/);
    expect(sql).not.toMatch(/dastar\.now/);
  });

  it("the app role cannot replace dastar_now", async () => {
    await expect(app.query("create or replace function dastar.dastar_now() returns timestamptz language sql as $$ select now() $$"))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("effective_status derives expired from a stale held row", async () => {
    await setClock(app, "2030-01-01T12:00:00Z");
    const r = await app.query(
      `select dastar.effective_status('held', '2030-01-01T11:59:00Z') as a,
              dastar.effective_status('held', '2030-01-01T12:01:00Z') as b,
              dastar.effective_status('confirmed', '2030-01-01T11:59:00Z') as c`);
    expect(r.rows[0]).toEqual({ a: "expired", b: "held", c: "confirmed" });
    await setClock(app, null);
  });

  it("unit_lock_key is stable and 64-bit", async () => {
    const r = await app.query("select dastar.unit_lock_key('018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b') as k1, dastar.unit_lock_key('018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b') as k2");
    expect(r.rows[0].k1).toBe(r.rows[0].k2);
    expect(typeof r.rows[0].k1).toBe("string");
  });

  it("require_actor raises DA007 when unset", async () => {
    await expect(app.query("select dastar.require_actor()")).rejects.toMatchObject({ code: "DA007" });
    await app.query("select set_config('dastar.actor', 'test', false)");
    expect((await app.query("select dastar.require_actor() as a")).rows[0].a).toBe("test");
  });
});

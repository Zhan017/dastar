import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer as createTcpServer, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Pool, Client } from "pg";
import type { HoldInput } from "@dastar/db";
import { listen } from "@dastar/api/server";
import { cloneDatabase, dropDatabase, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedBench, type BenchSeed } from "../src/seed.js";
import { createLoadKeys, engineTarget, httpTarget } from "../src/target.js";
import { waitFor, backends } from "../src/observe.js";

describe("load targets", () => {
  let conn: Conn; let owner: Client; let seed: BenchSeed; let n = 0;
  const pools: Pool[] = [];
  const pool = (max: number, applicationName: string): Pool => {
    const p = new Pool({ connectionString: conn.app, max, application_name: applicationName });
    p.on("error", () => undefined);
    pools.push(p);
    return p;
  };
  beforeAll(async () => {
    conn = await cloneDatabase("harness_target");
    owner = new Client({ connectionString: conn.owner });
    await owner.connect();
    seed = await seedBench(owner, { units: 4, combos: 1, holdTtlSeconds: 60 });
  });
  afterAll(async () => { for (const p of pools) await p.end(); await owner.end(); await dropDatabase("harness_target"); });

  const input = (unit: number, over: Partial<HoldInput> = {}): HoldInput => {
    n += 1;
    return {
      venueId: seed.venue, actor: `t:${n}`, traceId: `t-${n}`, idempotencyKey: `t-${n}`, partySize: 2, durationMinutes: 60,
      startsAt: new Date(Date.UTC(2052, 0, n, 19)).toISOString(), assignment: { kind: "unit", id: seed.units[unit]! }, ...over,
    };
  };

  it("engine: a hold that wins has every phase, and the phases nest", async () => {
    const t = engineTarget(pool(2, "T1"));
    const a = await t.hold(input(0));
    expect(a).toMatchObject({ code: "ok", phases: { poolWaitCensored: false, unitLockCensored: false, retries: 0 } });
    expect(a.reservationId).toMatch(/^[0-9a-f-]{36}$/);
    const p = a.phases!;
    for (const k of ["poolWaitMs", "unitLockMs", "transactionMs", "connectionHeldMs"] as const) expect(p[k], k).toBeGreaterThan(0);
    expect(p.transactionMs!).toBeGreaterThan(p.unitLockMs!);
    expect(p.connectionHeldMs!).toBeGreaterThanOrEqual(p.transactionMs!);
    expect(await t.confirm(a.reservationId!, seed.venue, "t-c")).toBe("ok");
    expect(await t.cancel(a.reservationId!, seed.venue, "t-x")).toBe("ok");
    expect(await t.cancel(a.reservationId!, seed.venue, "t-x2")).toBe("invalid_transition");
    await t.close();
  });

  it("engine: a request that ends while waiting for a unit lock leaves a censored sample, not a missing one", async () => {
    const t = engineTarget(pool(1, "T2"), { deadlineMs: 400 });
    const blocker = new Client({ connectionString: conn.app });
    await blocker.connect();
    await blocker.query("begin");
    await blocker.query("select pg_advisory_xact_lock(dastar.unit_lock_key($1::uuid))", [seed.units[1]]);
    const pending = t.hold(input(1));
    await waitFor(async () => (await backends(owner, "T2")).some((b) => b.waitType === "Lock" && b.waitEvent === "advisory"), 5_000, "the hold waits for the unit lock");
    const a = await pending;
    await blocker.query("rollback");
    await blocker.end();
    expect(a).toMatchObject({ code: "timeout", reservationId: null, phases: { unitLockCensored: true, poolWaitCensored: false } });
    expect(a.phases!.unitLockMs!).toBeGreaterThanOrEqual(300);
    expect(a.phases!.transactionMs!).toBeGreaterThanOrEqual(a.phases!.unitLockMs!);
    await t.close();
  });

  it("engine: a request that never got a connection has a censored pool wait and no other phase", async () => {
    const one = pool(1, "T3");
    const busy = await one.connect();
    const t = engineTarget(one, { acquireTimeoutMs: 40 });
    const a = await t.hold(input(2));
    busy.release();
    expect(a).toMatchObject({ code: "pool_timeout", phases: { poolWaitCensored: true, unitLockMs: null, transactionMs: null, connectionHeldMs: null } });
    expect(a.phases!.poolWaitMs!).toBeGreaterThanOrEqual(35);
    await t.close();
  });

  it("http: the same requests through the reference API, spread over several keys, with no phases", async () => {
    const api = await listen({ DATABASE_URL: conn.app, HOST: "127.0.0.1", PORT: 0, POOL_MAX: 4, POOL_ACQUIRE_MS: 5_000, READ_TIMEOUT_MS: 2_000, REQUEST_DEADLINE_MS: 12_000 }, { log: () => undefined });
    try {
      const keys = await createLoadKeys(pool(1, "T4"), 3);
      expect(new Set(keys).size).toBe(3);
      const t = httpTarget({ url: api.url, keys });
      const first = input(3);
      const a = await t.hold(first);
      expect(a).toMatchObject({ code: "ok", phases: null });
      expect((await t.hold({ ...input(3), startsAt: first.startsAt })).code).toBe("hold_conflict");
      expect(await t.confirm(a.reservationId!, seed.venue, "h-c")).toBe("ok");
      expect(await t.cancel(a.reservationId!, seed.venue, "h-x")).toBe("ok");
      expect((await t.hold(input(3, { partySize: 0 }))).code).toBe("validation");
      const actors = await owner.query("select distinct created_by from dastar.reservation where created_by like 'key:%'");
      expect(actors.rowCount).toBe(1);
      const used = await owner.query("select count(distinct actor)::int as n from dastar.idempotency where actor like 'key:%'");
      expect(used.rows[0].n).toBeGreaterThanOrEqual(2);
      expect(() => httpTarget({ url: api.url, keys: [] })).toThrow(/at least one key/);
      const down = httpTarget({ url: "http://127.0.0.1:9", keys });
      expect((await down.hold(input(3))).code).toBe("transport_error");
    } finally {
      await api.close();
    }
  });

  it("http: a response that never starts, or never ends, is a transport timeout at the harness's deadline, and says nothing about the database", async () => {
    // one server accepts the connection and never answers; the other sends its headers and half a body, then stalls
    const open = new Set<Socket>();
    const silent = createTcpServer((socket) => { open.add(socket); socket.on("error", () => undefined); });
    const halfway = createHttpServer((_req, res) => { res.writeHead(201, { "content-type": "application/json" }); res.write('{"receipt":'); });
    await Promise.all([new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r())), new Promise<void>((r) => halfway.listen(0, "127.0.0.1", () => r()))]);
    try {
      for (const server of [silent, halfway]) {
        const t = httpTarget({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, keys: ["dsk_unused"], deadlineMs: 300 });
        const t0 = Date.now();
        const a = await t.hold(input(0));
        expect(a).toEqual({ code: "transport_timeout", reservationId: null, phases: null });
        expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
        expect(Date.now() - t0).toBeLessThan(2_000);
        expect(await t.confirm("00000000-0000-0000-0000-000000000000", seed.venue, "x")).toBe("transport_timeout");
      }
    } finally {
      // a server waits for its connections before it closes, and these never end on their own
      for (const socket of open) socket.destroy();
      halfway.closeAllConnections();
      await Promise.all([new Promise<void>((r) => silent.close(() => r())), new Promise<void>((r) => halfway.close(() => r()))]);
    }
  });
});

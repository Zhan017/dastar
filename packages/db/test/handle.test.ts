import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:net";
import { Pool, type Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { seedVenue, type Seed } from "./helpers/seed.js";
import { connectAs, pause, outcome } from "./helpers/wait.js";
import { createDastar } from "../src/handle.js";
import type { HoldInput } from "../src/commands/hold.js";

async function eventually(check: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > ms) throw new Error("condition not met in time");
    await new Promise((res) => setTimeout(res, 25));
  }
}

describe("pool-owned handle", () => {
  let conn: Conn; let owner: Client; let seed: Seed; let n = 0;
  const NIL = "00000000-0000-0000-0000-000000000000";

  beforeAll(async () => {
    conn = await cloneDatabase("handle_test");
    owner = await connect(conn.owner);
    seed = await seedVenue(owner);
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100 where id = $1", [seed.venue]);
  });
  afterAll(async () => { await owner.end(); await dropDatabase("handle_test"); });

  function input(over: Partial<HoldInput> = {}): HoldInput {
    n += 1;
    const start = new Date(Date.UTC(2043, 0, 1 + Math.floor(n / 8), 8 + (n % 8)));
    return { venueId: seed.venue, actor: "key:H", traceId: `h${n}`, idempotencyKey: `h-k${n}`, partySize: 2, startsAt: start.toISOString(), durationMinutes: 60, assignment: { kind: "unit", id: seed.units[0]! }, ...over };
  }
  const poolErrors: Error[] = [];
  const makePool = (max: number, appName: string) => {
    const pool = new Pool({ connectionString: conn.app, max, application_name: appName });
    pool.on("error", (e) => { poolErrors.push(e); });
    return pool;
  };
  const states = async (appName: string) =>
    (await owner.query("select state from pg_stat_activity where datname = current_database() and application_name = $1", [appName])).rows.map((r) => r.state as string);
  const advisoryLocks = async (appName: string) =>
    (await owner.query("select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid = l.pid where a.datname = current_database() and a.application_name = $1 and l.locktype = 'advisory'", [appName])).rows[0].n as number;

  it("runs every command through a pooled client and returns it idle", async () => {
    const pool = makePool(2, "H1");
    const d = createDastar({ pool });
    const out = await d.hold(input());
    expect(out.ok).toBe(true);
    const id = (out as { receipt: { reservationId: string } }).receipt.reservationId;
    expect((await d.getReservation(id))?.status).toBe("held");
    const { token } = await d.mintConfirmToken({ reservationId: id, actor: "key:H", traceId: "m", venueId: seed.venue });
    expect((await d.confirm({ reservationId: id, actor: "ignored", traceId: "c", venueId: seed.venue, confirmToken: token })).status).toBe("confirmed");
    expect((await d.cancel({ reservationId: id, actor: "key:H", traceId: "x", venueId: seed.venue, reason: "test" })).status).toBe("cancelled");
    await expect(d.getReservation(NIL)).resolves.toBeNull();
    expect(pool.idleCount).toBe(pool.totalCount);
    await d.close();
    await pool.end();
  });

  it("a command error leaves the client idle and reusable", async () => {
    const pool = makePool(1, "H2");
    const d = createDastar({ pool });
    await expect(d.confirm({ reservationId: NIL, actor: "key:H", traceId: "c", venueId: seed.venue })).rejects.toMatchObject({ code: "not_found" });
    expect(pool.idleCount).toBe(1);
    expect(await states("H2")).toEqual(["idle"]);
    expect((await d.hold(input())).ok).toBe(true);
    await d.close();
    await pool.end();
  });

  it("acquire timeout produces pool_timeout and the late connection is released", async () => {
    const pool = makePool(1, "H3");
    const d = createDastar({ pool, acquireTimeoutMs: 200 });
    // establish the pool's single physical connection first, so the 200 ms below measures only the wait for it
    const warm = await pool.connect();
    warm.release();
    const p = pause();
    const pHold = d.hold(input(), { afterUnitLocks: p.hook });
    await p.reached;
    await expect(d.getReservation(NIL)).rejects.toMatchObject({ code: "pool_timeout", retryable: true });
    p.release();
    expect((await pHold).ok).toBe(true);
    await eventually(() => pool.idleCount === pool.totalCount && pool.waitingCount === 0);
    expect(pool.totalCount).toBe(1);
    await d.close();
    await pool.end();
  });

  it("deadline: cancels the blocked backend, the command settles with timeout, the connection is discarded", async () => {
    const pool = makePool(1, "H4");
    const d = createDastar({ pool, deadlineMs: 800, cancelGraceMs: 2_000, cancellerConnectionString: conn.app });
    const u = seed.units[1]!;
    const blocker = await connectAs(conn.app, "H4blocker");
    await blocker.query("begin");
    await blocker.query("select pg_advisory_xact_lock(dastar.unit_lock_key($1::uuid))", [u]);
    const t0 = Date.now();
    await expect(d.hold(input({ assignment: { kind: "unit", id: u } }))).rejects.toMatchObject({ code: "timeout", retryable: true });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(800);
    expect(Date.now() - t0).toBeLessThan(2_500);
    await eventually(() => pool.totalCount === 0);
    expect(await advisoryLocks("H4")).toBe(0);
    await blocker.query("rollback");
    await blocker.end();
    expect((await d.hold(input({ assignment: { kind: "unit", id: u } }))).ok).toBe(true);
    await eventually(async () => (await states("H4")).length === 1);
    await d.close();
    await pool.end();
  });

  it("deadline without a working canceller: the connection is discarded after the grace period and the pool recovers", async () => {
    const pool = makePool(1, "H5");
    // the readonly role may not cancel an app-role backend, so cancellation fails and the grace period runs out
    const d = createDastar({ pool, deadlineMs: 500, cancelGraceMs: 500, cancellerConnectionString: conn.readonly });
    const u = seed.units[2]!;
    const blocker = await connectAs(conn.app, "H5blocker");
    await blocker.query("begin");
    await blocker.query("select pg_advisory_xact_lock(dastar.unit_lock_key($1::uuid))", [u]);
    await expect(d.hold(input({ assignment: { kind: "unit", id: u } }))).rejects.toMatchObject({ code: "timeout", retryable: true });
    expect(pool.totalCount).toBe(0);
    await blocker.query("rollback");
    await blocker.end();
    expect((await d.hold(input({ assignment: { kind: "unit", id: u } }))).ok).toBe(true);
    await eventually(async () => (await states("H5")).length === 1);
    await d.close();
    await pool.end();
  });

  it("a connection terminated mid-command is destroyed, not returned", async () => {
    const pool = makePool(1, "H6");
    const d = createDastar({ pool });
    const u = seed.units[3]!;
    const p = pause();
    const pHold = outcome(d.hold(input({ assignment: { kind: "unit", id: u } }), { afterUnitLocks: p.hook }));
    await p.reached;
    await owner.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and application_name = 'H6'");
    p.release();
    expect(await pHold).toMatchObject({ ok: false, error: { code: "internal" } });
    await eventually(() => pool.totalCount === 0);
    expect((await d.hold(input({ assignment: { kind: "unit", id: u } }))).ok).toBe(true);
    await d.close();
    await pool.end();
  });

  it("two commands past their deadline at once share one canceller connection", async () => {
    const pool = makePool(2, "H7");
    const d = createDastar({ pool, deadlineMs: 500, cancelGraceMs: 2_000, cancellerConnectionString: conn.app });
    const u = seed.units[4]!;
    const blocker = await connectAs(conn.app, "H7blocker");
    await blocker.query("begin");
    await blocker.query("select pg_advisory_xact_lock(dastar.unit_lock_key($1::uuid))", [u]);
    const results = await Promise.allSettled([
      d.hold(input({ assignment: { kind: "unit", id: u } })),
      d.hold(input({ assignment: { kind: "unit", id: u } })),
    ]);
    for (const r of results) {
      expect(r.status).toBe("rejected");
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "timeout", retryable: true });
    }
    await eventually(async () => (await states("dastar-canceller")).length === 1);
    await eventually(() => pool.totalCount === 0);
    await blocker.query("rollback");
    await blocker.end();
    await d.close();
    await eventually(async () => (await states("dastar-canceller")).length === 0);
    await pool.end();
  });

  it("a canceller that never answers cannot extend the deadline; the connection is discarded and the pool recovers", async () => {
    // a TCP endpoint that accepts and never replies stands in for a stalled canceller; the socket is resumed
    // (and its bytes discarded) so the server notices the client's close instead of leaving it half-open forever
    const blackHole: Server = createServer((socket) => socket.resume());
    await new Promise<void>((res) => blackHole.listen(0, "127.0.0.1", () => res()));
    const port = (blackHole.address() as { port: number }).port;
    const pool = makePool(1, "H8");
    const d = createDastar({ pool, deadlineMs: 300, cancelGraceMs: 500, cancellerConnectionString: `postgres://dastar_app:app@127.0.0.1:${port}/none` });
    const u = seed.units[5]!;
    const blocker = await connectAs(conn.app, "H8blocker");
    await blocker.query("begin");
    await blocker.query("select pg_advisory_xact_lock(dastar.unit_lock_key($1::uuid))", [u]);
    const t0 = Date.now();
    await expect(d.hold(input({ assignment: { kind: "unit", id: u } }))).rejects.toMatchObject({ code: "timeout", retryable: true });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(800);
    expect(elapsed).toBeLessThan(2_000);
    expect(pool.totalCount).toBe(0);
    await blocker.query("rollback");
    await blocker.end();
    expect((await d.hold(input({ assignment: { kind: "unit", id: u } }))).ok).toBe(true);
    await d.close();
    await pool.end();
    await new Promise<void>((res) => blackHole.close(() => res()));
  });
});

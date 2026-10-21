import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool, type Client } from "pg";
import { createDastar } from "@dastar/db";
import { cloneDatabase, connect, dropDatabase, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedVenue, type Seed } from "../../../packages/db/test/helpers/seed.js";
import { DESIGN_SWEEP } from "../src/sweeper.js";
import { DESIGN_RETENTION } from "../src/retention.js";
import { parseWorkerConfig, startWorker, type WorkerLogEntry } from "../src/worker.js";

const pkg = fileURLToPath(new URL("..", import.meta.url));

describe("worker config", () => {
  it("defaults to the design's sweeper and retention job and a pool of two", () => {
    expect(parseWorkerConfig({ DATABASE_URL: "postgres://w@h/d" })).toEqual({ databaseUrl: "postgres://w@h/d", sweep: DESIGN_SWEEP, retention: DESIGN_RETENTION, poolMax: 2 });
    expect(parseWorkerConfig({ DATABASE_URL: "postgres://w@h/d", SWEEP_EVERY_MS: "250", SWEEP_LIMIT: "5", POOL_MAX: "1" }))
      .toEqual({ databaseUrl: "postgres://w@h/d", sweep: { everyMs: 250, limit: 5, drain: true }, retention: DESIGN_RETENTION, poolMax: 1 });
    expect(parseWorkerConfig({ DATABASE_URL: "postgres://w@h/d", RETENTION_EVERY_MS: "750", RETENTION_LIMIT: "9" }))
      .toEqual({ databaseUrl: "postgres://w@h/d", sweep: DESIGN_SWEEP, retention: { everyMs: 750, limit: 9, drain: true }, poolMax: 2 });
  });

  it("refuses a missing URL and values it cannot use", () => {
    expect(() => parseWorkerConfig({})).toThrow(/DATABASE_URL/);
    for (const name of ["SWEEP_LIMIT", "RETENTION_EVERY_MS", "RETENTION_LIMIT"]) {
      for (const bad of ["0", "-1", "1.5", "x"]) expect(() => parseWorkerConfig({ DATABASE_URL: "u", [name]: bad }), `${name}=${bad}`).toThrow(new RegExp(name));
    }
  });
});

describe("worker", () => {
  let conn: Conn; let owner: Client; let appPool: Pool; let seed: Seed; let n = 0;
  beforeAll(async () => {
    conn = await cloneDatabase("worker_test");
    owner = await connect(conn.owner);
    await owner.query("select set_config('dastar.actor', 'owner', false), set_config('dastar.trace_id', 'owner', false)");
    seed = await seedVenue(owner);
    appPool = new Pool({ connectionString: conn.app, max: 2 });
    appPool.on("error", () => undefined);
  });
  afterAll(async () => { await appPool.end(); await owner.end(); await dropDatabase("worker_test"); });

  /** A hold whose expiry the owner moves to the next moment, the way the harness ages holds. */
  async function dyingHold(): Promise<string> {
    const d = createDastar({ pool: appPool });
    const k = ++n;
    const held = await d.hold({
      venueId: seed.venue, actor: `key:w${k}`, traceId: `w${k}`, idempotencyKey: `w${k}`,
      partySize: 2, startsAt: new Date(Date.UTC(2041, 0, k, 19)).toISOString(), durationMinutes: 90, assignment: { kind: "unit", id: seed.units[0]! },
    });
    await d.close();
    if (!held.ok) throw new Error(held.error.code);
    const id = held.receipt.reservationId;
    await owner.query("update dastar.reservation set hold_expires_at = now() + interval '200 milliseconds' where id = $1", [id]);
    return id;
  }

  async function statusOf(id: string): Promise<string> {
    return (await owner.query("select status from dastar.reservation where id = $1", [id])).rows[0].status as string;
  }

  async function until(check: () => Promise<boolean>, ms: number): Promise<void> {
    const t0 = Date.now();
    while (!(await check())) {
      if (Date.now() - t0 > ms) throw new Error("condition not met in time");
      await new Promise((res) => setTimeout(res, 50));
    }
  }

  it("expires a dead hold as dastar_worker, logs the batch, and stops cleanly", async () => {
    const id = await dyingHold();
    const logs: WorkerLogEntry[] = [];
    const w = startWorker({ databaseUrl: conn.worker, sweep: { everyMs: 100, limit: 20, drain: true }, retention: DESIGN_RETENTION, poolMax: 1 }, { log: (e) => logs.push(e) });
    try {
      await until(async () => (await statusOf(id)) === "expired", 10_000);
      await until(async () => logs.some((l) => l.msg === "expired"), 2_000);
    } finally {
      await w.stop();
    }
    expect(logs.filter((l) => l.level === "error")).toEqual([]);
    expect(w.stats.errors).toBe(0);
    const audit = await owner.query("select actor from dastar.audit_log where entity_id = $1 order by id desc limit 1", [id]);
    expect(audit.rows[0].actor).toBe("system:sweeper");
  });

  it("purges a due idempotency row as dastar_worker, leaves one that is not due, logs the batch, and stops both loops cleanly", async () => {
    const insert = async (key: string, purgeAt: string): Promise<void> => {
      await owner.query(
        `insert into dastar.idempotency(venue_id, actor, key, request_hash, purge_at) values ($1, 'key:ret', $2, decode('00', 'hex'), ${purgeAt})`,
        [seed.venue, key],
      );
    };
    await insert("ret-due", "now() - interval '1 hour'");
    await insert("ret-later", "now() + interval '1 day'");
    const keys = async (): Promise<string[]> =>
      (await owner.query("select key from dastar.idempotency where actor = 'key:ret' order by key")).rows.map((r) => r.key as string);
    expect(await keys()).toEqual(["ret-due", "ret-later"]);
    const logs: WorkerLogEntry[] = [];
    const w = startWorker({ databaseUrl: conn.worker, sweep: { everyMs: 60_000, limit: 20, drain: true }, retention: { everyMs: 100, limit: 500, drain: true }, poolMax: 2 }, { log: (e) => logs.push(e) });
    try {
      await until(async () => (await keys()).length === 1, 10_000);
      await until(async () => logs.some((l) => l.msg === "purged"), 2_000);
    } finally {
      await w.stop();
    }
    expect(await keys()).toEqual(["ret-later"]);
    expect(logs.filter((l) => l.level === "error")).toEqual([]);
    expect(logs.filter((l) => l.msg === "purged")).toEqual([expect.objectContaining({ level: "info", msg: "purged", idempotency: 1, outbox: 0 })]);
    expect(w.retention).toMatchObject({ idempotency: 1, outbox: 0, errors: 0 });
    const ticks = w.retention.ticks;
    await new Promise((res) => setTimeout(res, 350));
    expect(w.retention.ticks).toBe(ticks);
  });

  it("logs a failed batch and keeps going", async () => {
    const logs: WorkerLogEntry[] = [];
    // a wrong password fails every batch at connect
    const w = startWorker({ databaseUrl: conn.worker.replace("worker:worker@", "worker:wrong@"), sweep: { everyMs: 50, limit: 20, drain: true }, retention: DESIGN_RETENTION, poolMax: 1 }, { log: (e) => logs.push(e) });
    try {
      await until(async () => w.stats.errors >= 2, 5_000);
    } finally {
      await w.stop();
    }
    expect(logs.find((l) => l.msg === "sweep failed")).toMatchObject({ level: "error", msg: "sweep failed" });
  });

  it("runs as a process that sweeps until SIGTERM and exits 0", async () => {
    const id = await dyingHold();
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
      cwd: pkg, env: { ...process.env, DATABASE_URL: conn.worker, SWEEP_EVERY_MS: "100" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (b: Buffer) => { out += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { out += b.toString(); });
    const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
    try {
      await until(async () => (await statusOf(id)) === "expired", 20_000);
      await until(async () => out.includes('"msg":"expired"'), 2_000);
    } finally {
      child.kill("SIGTERM");
    }
    expect(await exited).toBe(0);
    expect(out).toContain('"msg":"sweeping"');
  });

  it("refuses to start without a database URL", async () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], { cwd: pkg, env, stdio: "ignore" });
    expect(await new Promise((res) => child.on("exit", (code) => res(code)))).toBe(2);
  });
});

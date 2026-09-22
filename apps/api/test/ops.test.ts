import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool, type Client } from "pg";
import { serve } from "@hono/node-server";
import { createDastar, readMigrationFiles } from "@dastar/db";
import { cloneDatabase, dropDatabase, connect, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedVenue, type Seed } from "../../../packages/db/test/helpers/seed.js";
import { createApp } from "../src/app.js";
import { createKey } from "../src/auth.js";
import { buildServer, listen, parseConfig } from "../src/server.js";
import type { LogEntry } from "../src/env.js";
import { runKeysCli } from "../src/keys-cli.js";
import { makeApi, bearer, jsonInit, MIGRATIONS } from "./helpers.js";

describe("operations", () => {
  let conn: Conn; let owner: Client; let seed: Seed;
  beforeAll(async () => { conn = await cloneDatabase("api_ops_test"); owner = await connect(conn.owner); seed = await seedVenue(owner); });
  afterAll(async () => { await owner.end(); await dropDatabase("api_ops_test"); });

  it("ready when the database answers and every migration file is applied", async () => {
    const api = makeApi(conn, { appName: "api-ready-ok" });
    const files = (await readdir(MIGRATIONS)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).length;
    const r = await api.app.request("/health/ready");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "ready", migrations: files });
    await api.close();
  });

  it("not ready within about a second when no connection is available, and ready again afterwards", async () => {
    const api = makeApi(conn, { poolMax: 1, appName: "api-ready-busy" });
    const held = await api.pool.connect();
    const t0 = Date.now();
    const r = await api.app.request("/health/ready");
    const elapsed = Date.now() - t0;
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("1");
    expect(await r.json()).toMatchObject({ code: "not_ready" });
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(4_000);
    held.release();
    expect((await api.app.request("/health/ready")).status).toBe(200);
    await api.close();
  });

  it("not ready when the shipped set has a migration the database has not seen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dastar-ready-"));
    for (const m of await readMigrationFiles(MIGRATIONS)) await writeFile(join(dir, m.file), m.sql);
    await writeFile(join(dir, "0099_extra.sql"), "-- transaction: yes\n-- impact: instant-exclusive\nselect 1;\n");
    const pool = new Pool({ connectionString: conn.app, max: 2, application_name: "api-ready-behind" });
    pool.on("error", () => undefined);
    const dastar = createDastar({ pool });
    const app = createApp({ dastar, pool, migrationsDir: dir, log: () => undefined });
    const r = await app.request("/health/ready");
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ code: "not_ready", detail: "migration 0099_extra.sql is not applied" });
    await dastar.close();
    await pool.end();
  });

  it("not ready when a shipped migration is missing, even if another row keeps the count the same", async () => {
    const last = (await readMigrationFiles(MIGRATIONS)).at(-1)!;
    const api = makeApi(conn, { appName: "api-ready-swap" });
    await owner.query("update dastar.schema_migration set version = 9999 where version = $1", [last.version]);
    try {
      const r = await api.app.request("/health/ready");
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({ code: "not_ready", detail: `migration ${last.file} is not applied` });
    } finally {
      await owner.query("update dastar.schema_migration set version = $1 where version = 9999", [last.version]);
    }
    expect((await api.app.request("/health/ready")).status).toBe(200);
    await api.close();
  });

  it("not ready when an applied migration differs from the shipped file", async () => {
    const last = (await readMigrationFiles(MIGRATIONS)).at(-1)!;
    const api = makeApi(conn, { appName: "api-ready-sum" });
    await owner.query("update dastar.schema_migration set checksum = $2 where version = $1", [last.version, Buffer.from([0])]);
    try {
      const r = await api.app.request("/health/ready");
      expect(r.status).toBe(503);
      expect(await r.json()).toMatchObject({ code: "not_ready", detail: `migration ${last.file} differs from the applied one` });
    } finally {
      await owner.query("update dastar.schema_migration set checksum = $2 where version = $1", [last.version, last.checksum]);
    }
    expect((await api.app.request("/health/ready")).status).toBe(200);
    await api.close();
  });

  it("not ready, and says so, when the migration files cannot be read", async () => {
    const pool = new Pool({ connectionString: conn.app, max: 2, application_name: "api-ready-nodir" });
    pool.on("error", () => undefined);
    const dastar = createDastar({ pool });
    const app = createApp({ dastar, pool, migrationsDir: join(tmpdir(), "dastar-no-such-dir"), log: () => undefined });
    const r = await app.request("/health/ready");
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ code: "not_ready", detail: "migration files unreadable" });
    await dastar.close();
    await pool.end();
  });

  it("no log entry, custom or default, ever contains a confirm token", async () => {
    const api = makeApi(conn, { appName: "api-redact" });
    const staff = await createKey(api.pool, { label: "staff", capabilities: ["hold", "confirm"] });
    const hold = await api.app.request(`/v1/venues/${seed.venue}/holds`, jsonInit("POST", { party_size: 2, starts_at: "2047-03-01T19:00:00Z", duration_minutes: 60, assignment: { kind: "unit", id: seed.units[0] } }, { ...bearer(staff.key), "idempotency-key": "ops-1" }));
    const id = (await hold.json() as { receipt: { reservation_id: string } }).receipt.reservation_id;
    const { confirm_token } = await (await api.app.request(`/v1/reservations/${id}/confirm-token`, jsonInit("POST", {}, bearer(staff.key)))).json() as { confirm_token: string };
    expect((await api.app.request(`/v1/reservations/${id}/confirm`, jsonInit("POST", { confirm_token }))).status).toBe(200);
    const logged = JSON.stringify(api.lines);
    expect(logged).not.toContain(confirm_token);
    expect(logged).not.toContain(staff.key);
    await api.close();

    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const pool = new Pool({ connectionString: conn.app, max: 2, application_name: "api-redact-default" });
      pool.on("error", () => undefined);
      const dastar = createDastar({ pool });
      const app = createApp({ dastar, pool, migrationsDir: MIGRATIONS });
      const h2 = await app.request(`/v1/venues/${seed.venue}/holds`, jsonInit("POST", { party_size: 2, starts_at: "2047-03-02T19:00:00Z", duration_minutes: 60, assignment: { kind: "unit", id: seed.units[0] } }, { ...bearer(staff.key), "idempotency-key": "ops-2" }));
      const id2 = (await h2.json() as { receipt: { reservation_id: string } }).receipt.reservation_id;
      const t2 = (await (await app.request(`/v1/reservations/${id2}/confirm-token`, jsonInit("POST", {}, bearer(staff.key)))).json() as { confirm_token: string }).confirm_token;
      await app.request(`/v1/reservations/${id2}/confirm`, jsonInit("POST", { confirm_token: t2 }));
      const printed = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(spy.mock.calls.length).toBe(3);
      expect(printed).not.toContain(t2);
      expect(printed).not.toContain(staff.key);
      await dastar.close();
      await pool.end();
    } finally {
      spy.mockRestore();
    }
  });

  it("the server entry builds from the environment, serves, and closes", async () => {
    expect(() => parseConfig({})).toThrow();
    const built = buildServer(parseConfig({ DATABASE_URL: conn.app, PORT: "0", POOL_MAX: "2" }));
    const server = serve({ fetch: built.app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((res) => server.once("listening", () => res()));
    const port = (server.address() as AddressInfo).port;
    expect(await (await fetch(`http://127.0.0.1:${port}/health/live`)).json()).toEqual({ status: "live" });
    expect((await fetch(`http://127.0.0.1:${port}/health/ready`)).status).toBe(200);
    await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
    await built.close();
  });

  it("listen binds a free port, routes request logs to the given sink, and closes the socket and the pool", async () => {
    const entries: LogEntry[] = [];
    const running = await listen(parseConfig({ DATABASE_URL: conn.app, PORT: "0", POOL_MAX: "2" }), { log: (e) => { entries.push(e); } });
    expect(running.port).toBeGreaterThan(0);
    expect(running.host).toBe("127.0.0.1"); // no HOST given: loopback, never every interface
    expect(running.url).toBe(`http://127.0.0.1:${running.port}`);
    expect((await fetch(`${running.url}/health/ready`)).status).toBe(200);
    expect(entries.map((e) => e.path)).toEqual(["/health/ready"]);
    await running.close();
    await expect(fetch(`${running.url}/health/live`)).rejects.toThrow();
    // 192.0.2.1 is reserved for documentation and is no interface here: the promise rejects instead of hanging
    await expect(listen(parseConfig({ DATABASE_URL: conn.app, HOST: "192.0.2.1", PORT: "0", POOL_MAX: "2" }))).rejects.toThrow(/EADDRNOTAVAIL/);
  });

  it("the key script creates a key that authenticates, and refuses unknown capabilities", async () => {
    const created = await runKeysCli(["--label", "cli", "--capabilities", "hold,read", "--venues", seed.venue], { DATABASE_URL: conn.app });
    expect(created.key).toMatch(/^dsk_/);
    const api = makeApi(conn, { appName: "api-cli" });
    const r = await api.app.request(`/v1/venues/${seed.venue}/holds`, jsonInit("POST", { party_size: 2, starts_at: "2047-03-03T19:00:00Z", duration_minutes: 60, assignment: { kind: "unit", id: seed.units[0] } }, { ...bearer(created.key), "idempotency-key": "ops-3" }));
    expect(r.status).toBe(201);
    await api.close();
    await expect(runKeysCli(["--label", "bad", "--capabilities", "hold,admin"], { DATABASE_URL: conn.app })).rejects.toThrow(/unknown capability/);
    await expect(runKeysCli(["--capabilities", "hold"], { DATABASE_URL: conn.app })).rejects.toThrow(/--label/);
  });
});

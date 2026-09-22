import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import { cloneDatabase, dropDatabase, type Conn } from "../../../packages/db/test/helpers/db.js";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { runExhaust, postHold, exhaustPassed } from "../src/exhaust.js";

describe("exhaust verdict", () => {
  it("passes only when both variants ran and made checks that all passed; nothing checked is not a pass", () => {
    const ok = { checks: [{ name: "a", pass: true, detail: "" }] };
    expect(exhaustPassed([ok, ok])).toBe(true);
    expect(exhaustPassed([])).toBe(false);
    expect(exhaustPassed([ok])).toBe(false);
    expect(exhaustPassed([ok, { checks: [] }])).toBe(false);
    expect(exhaustPassed([ok, { checks: [{ name: "b", pass: false, detail: "x" }] }])).toBe(false);
  });
});

describe("pool exhaustion and recovery over HTTP", () => {
  let conn: Conn;
  beforeAll(async () => {
    conn = await cloneDatabase("harness_exhaust");
    // a 3 s statement timeout for this database only, so both variants finish in seconds
    const owner = new Client({ connectionString: conn.owner });
    await owner.connect();
    await owner.query(`alter role dastar_app in database "harness_exhaust" set statement_timeout = '3s'`);
    await owner.end();
  });
  afterAll(async () => { await dropDatabase("harness_exhaust"); });

  it("refuses at the acquire timeout, recovers after release, and leaves nothing behind after a statement timeout", async () => {
    const r = await runExhaust({ ownerUrl: conn.owner, appUrl: conn.app, poolMax: 4, acquireMs: 1_000 });
    expect(r).toMatchObject({ poolMax: 4, acquireMs: 1_000, statementTimeoutMs: 3_000, startedApi: true });
    const failed = r.variants.flatMap((v) => v.checks.filter((c) => !c.pass).map((c) => `${v.variant}: ${c.name} :: ${c.detail}`));
    expect(failed).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.variants.map((v) => v.variant)).toEqual(["release_before_statement_timeout", "blocker_past_statement_timeout"]);
    expect(r.variants[0]!.drainMs).not.toBeNull();
    expect(r.variants[0]!.checks.length).toBeGreaterThanOrEqual(9);
    expect(r.variants[1]!.checks.length).toBeGreaterThanOrEqual(9);
  });

  it("an API that never answers is a transport timeout at the harness's deadline, not a hung run", async () => {
    const open = new Set<Socket>();
    const silent = createServer((socket) => { open.add(socket); socket.on("error", () => undefined); });
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    try {
      const t0 = Date.now();
      const a = await postHold({ url: `http://127.0.0.1:${(silent.address() as AddressInfo).port}`, key: "dsk_unused", deadlineMs: 300 }, "00000000-0000-0000-0000-000000000000",
        { key: "k", unit: "00000000-0000-0000-0000-000000000000", startsAt: "2049-01-01T19:00:00.000Z" });
      expect(a).toMatchObject({ key: "k", status: 0, code: "transport_timeout", replayed: null, retryAfter: null });
      expect(Date.now() - t0).toBeLessThan(2_000);
    } finally {
      for (const socket of open) socket.destroy();
      await new Promise<void>((r) => silent.close(() => r()));
    }
  });

  it("refuses to run when the acquire timeout is not clearly under the statement timeout", async () => {
    await expect(runExhaust({ ownerUrl: conn.owner, appUrl: conn.app, poolMax: 2, acquireMs: 2_500 })).rejects.toThrow(/must be at least 1.5 s under/);
  });

  it("refuses to run when the blocker's idle transaction would be ended before the statement timeout passes", async () => {
    const owner = new Client({ connectionString: conn.owner });
    await owner.connect();
    await owner.query(`alter role dastar_app in database "harness_exhaust" set idle_in_transaction_session_timeout = '4s'`);
    try {
      await expect(runExhaust({ ownerUrl: conn.owner, appUrl: conn.app, poolMax: 2, acquireMs: 1_000 })).rejects.toThrow(/idle_in_transaction_session_timeout \(4000ms\) must exceed/);
    } finally {
      await owner.query(`alter role dastar_app in database "harness_exhaust" reset idle_in_transaction_session_timeout`);
      await owner.end();
    }
  });
});

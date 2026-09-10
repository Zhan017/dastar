import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { seedVenue, type Seed } from "./helpers/seed.js";
import { hold, type HoldInput } from "../src/commands/hold.js";

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => { open = r; });
  return { wait: () => p, open };
}

describe("idempotency (invariant 3, G2)", () => {
  let conn: Conn; let owner: Client; let a: Client; let b: Client; let worker: Client; let seed: Seed; let n = 0;
  beforeAll(async () => {
    conn = await cloneDatabase("idem_test");
    owner = await connect(conn.owner);
    a = await connect(conn.app); b = await connect(conn.app); worker = await connect(conn.worker);
    seed = await seedVenue(owner);
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100 where id = $1", [seed.venue]);
  });
  afterAll(async () => { await a.end(); await b.end(); await worker.end(); await owner.end(); await dropDatabase("idem_test"); });

  function input(over: Partial<HoldInput> = {}): HoldInput {
    n += 1;
    const start = new Date(Date.UTC(2036, 0, 1 + Math.floor(n / 8), 8 + (n % 8)));
    return { venueId: seed.venue, actor: "key:idem", traceId: `t${n}`, idempotencyKey: `k${n}`, partySize: 2, startsAt: start.toISOString(), durationMinutes: 60, assignment: { kind: "unit", id: seed.units[0]! }, ...over };
  }

  it("two concurrent requests with one key: the second blocks on the claim and replays the first's outcome", async () => {
    const i = input();
    const claimed = gate();
    const release = gate();
    const first = hold(a, i, { afterClaim: async () => { claimed.open(); await release.wait(); } });
    await claimed.wait();
    const second = hold(b, i);
    const deadline = Date.now() + 5_000;
    for (;;) {
      const waiting = await owner.query(
        "select count(*)::int as c from pg_stat_activity where datname = current_database() and usename = 'dastar_app' and wait_event_type = 'Lock' and state = 'active'");
      if (waiting.rows[0].c === 1) break;
      if (Date.now() > deadline) throw new Error("second request never blocked on the idempotency claim");
      await new Promise((r) => setTimeout(r, 20));
    }
    release.open();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.ok).toBe(true);
    expect(r2).toEqual({ ...r1, replayed: true });
    const c = await owner.query("select count(*)::int as c from dastar.reservation where created_by = 'key:idem'");
    expect(c.rows[0].c).toBe(1);
  });

  it("a committed outcome survives the client losing the response (crash after commit)", async () => {
    const i = input();
    const lost = await connect(conn.app);
    const out = await hold(lost, i);
    lost.end().catch(() => undefined);
    const retry = await hold(a, i);
    expect(retry).toEqual({ ...out, replayed: true });
  });

  it("a request aborted before commit leaves no claim, and a retry executes fresh", async () => {
    const i = input();
    const g = gate();
    const crashing = await connect(conn.app);
    const p = hold(crashing, i, { beforeCommit: async () => { await g.wait(); throw new Error("simulated crash before commit"); } });
    g.open();
    await expect(p).rejects.toThrow(/simulated crash/);
    await crashing.end();
    expect((await owner.query("select 1 from dastar.idempotency where key = $1", [i.idempotencyKey])).rowCount).toBe(0);
    const fresh = await hold(a, i);
    expect(fresh).toMatchObject({ ok: true, replayed: false });
  });

  it("a purged key is fresh again; retention bounds the guarantee", async () => {
    const i = input();
    const first = await hold(a, i);
    expect(first.ok).toBe(true);
    await worker.query("delete from dastar.idempotency where key = $1", [i.idempotencyKey]);
    const again = await hold(a, i);
    expect(again).toMatchObject({ ok: false, error: { code: "hold_conflict" }, replayed: false });
  });

  it("different keys under the same actor are independent requests", async () => {
    const i = input();
    const first = await hold(a, i);
    expect(first.ok).toBe(true);
    const second = await hold(a, { ...i, idempotencyKey: `${i.idempotencyKey}-2` });
    expect(second).toMatchObject({ ok: false, error: { code: "hold_conflict" } });
  });
});

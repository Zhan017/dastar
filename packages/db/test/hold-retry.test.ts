import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { seedVenue, type Seed } from "./helpers/seed.js";
import { connectAs, waitForBackend, deadlockCountStable, pause } from "./helpers/wait.js";
import { hold, type HoldInput } from "../src/commands/hold.js";

describe("hold retry on deadlock and serialization failure", () => {
  let conn: Conn; let owner: Client; let app: Client; let seed: Seed; let n = 0; let appPid = 0;
  let A: Client; let R: Client; let deadlocksAtStart = 0;

  beforeAll(async () => {
    conn = await cloneDatabase("hold_retry_test");
    owner = await connect(conn.owner);
    await owner.query("select set_config('dastar.actor', 'owner', false)");
    app = await connect(conn.app);
    appPid = (await app.query("select pg_backend_pid() as pid")).rows[0].pid as number;
    seed = await seedVenue(owner);
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100 where id = $1", [seed.venue]);
    A = await connectAs(conn.app, "RA");
    R = await connectAs(conn.app, "RR");
    deadlocksAtStart = await deadlockCountStable(owner);
  });
  afterAll(async () => {
    await A.end(); await R.end();
    await app.end(); await owner.end(); await dropDatabase("hold_retry_test");
  });

  function input(over: Partial<HoldInput> = {}): HoldInput {
    n += 1;
    const start = new Date(Date.UTC(2041, 0, 1 + Math.floor(n / 8), 8 + (n % 8)));
    return { venueId: seed.venue, actor: "key:R", traceId: `r${n}`, idempotencyKey: `r-k${n}`, partySize: 2, startsAt: start.toISOString(), durationMinutes: 60, assignment: { kind: "unit", id: seed.units[0]! }, ...over };
  }
  const injected = () => Object.assign(new Error("injected deadlock"), { code: "40P01" });

  it("injected once: the hold retries and succeeds; onRetry reports attempt 1 with 40P01", async () => {
    let throws = 1;
    const retries: { attempt: number; sqlstate: string }[] = [];
    const out = await hold(app, input(), {
      afterOverlapLocks: async () => { if (throws-- > 0) throw injected(); },
      onRetry: (i) => retries.push({ attempt: i.attempt, sqlstate: i.sqlstate }),
    });
    expect(out.ok).toBe(true);
    expect(retries).toEqual([{ attempt: 1, sqlstate: "40P01" }]);
  });

  it("hooks bracket the transaction and the unit locks: beforeBegin runs outside a transaction, beforeUnitLocks before any unit lock, on every attempt", async () => {
    let throws = 1;
    const seen: string[] = [];
    const state = async (): Promise<string> =>
      (await owner.query("select state from pg_stat_activity where pid = $1", [appPid])).rows[0].state as string;
    const unitLocks = async (): Promise<number> =>
      (await owner.query("select count(*)::int as n from pg_locks where pid = $1 and locktype = 'advisory'", [appPid])).rows[0].n as number;
    const out = await hold(app, input(), {
      beforeBegin: async () => { seen.push(`beforeBegin:${await state()}`); },
      afterClaim: async () => { seen.push(`afterClaim:${await state()}`); },
      beforeUnitLocks: async () => { seen.push(`beforeUnitLocks:${await unitLocks()}`); },
      afterUnitLocks: async () => { seen.push(`afterUnitLocks:${await unitLocks()}`); },
      afterOverlapLocks: async () => { seen.push("afterOverlapLocks"); if (throws-- > 0) throw injected(); },
      beforeCommit: async () => { seen.push("beforeCommit"); },
    });
    expect(out.ok).toBe(true);
    const attempt = ["beforeBegin:idle", "afterClaim:idle in transaction", "beforeUnitLocks:0", "afterUnitLocks:1", "afterOverlapLocks"];
    expect(seen).toEqual([...attempt, ...attempt, "beforeCommit"]);
  });

  it("injected on every attempt: gives up after one retry and leaves nothing behind", async () => {
    const i = input();
    const retries: number[] = [];
    await expect(hold(app, i, {
      afterOverlapLocks: async () => { throw injected(); },
      onRetry: (x) => retries.push(x.attempt),
    })).rejects.toMatchObject({ code: "serialization_conflict", retryable: true, sqlstate: "40P01" });
    expect(retries).toEqual([1]);

    const state = await owner.query("select state from pg_stat_activity where pid = $1", [appPid]);
    expect(state.rows[0].state).toBe("idle");
    const locks = await owner.query("select count(*)::int as n from pg_locks where pid = $1 and locktype = 'advisory'", [appPid]);
    expect(locks.rows[0].n).toBe(0);
    const keys = await owner.query("select count(*)::int as n from dastar.idempotency where venue_id = $1 and actor = $2 and key = $3", [i.venueId, i.actor, i.idempotencyKey]);
    expect(keys.rows[0].n).toBe(0);
    const rows = await owner.query("select count(*)::int as n from dastar.reservation where created_by = $1 and lower(during) = $2::timestamptz", [i.actor, i.startsAt]);
    expect(rows.rows[0].n).toBe(0);

    const again = await hold(app, i);
    expect(again).toMatchObject({ ok: true, replayed: false });
  });

  it("real deadlock: the hold receives 40P01 from Postgres, retries once, and succeeds", async () => {
    const start = input().startsAt;
    // a dead hold on the slot: the hold under test will lock and expire it in its overlap pass
    const dead = await hold(app, input({ startsAt: start, actor: "key:dead", idempotencyKey: `dead-${n}` }));
    if (!dead.ok) throw new Error(dead.error.code);
    await owner.query("update dastar.reservation set hold_expires_at = now() - interval '1 minute' where id = $1", [dead.receipt.reservationId]);

    // R holds the dead row; the hold under test holds the unit lock and pauses
    await R.query("begin");
    await R.query("select set_config('dastar.actor', 'key:R', true)");
    await R.query("select id from dastar.reservation where id = $1 for update", [dead.receipt.reservationId]);
    const retries: { attempt: number; sqlstate: string }[] = [];
    const p = pause();
    const pHold = hold(A, input({ startsAt: start }), {
      afterUnitLocks: p.hook,
      onRetry: (i) => retries.push({ attempt: i.attempt, sqlstate: i.sqlstate }),
    });
    await p.reached;

    // R now waits for the unit lock; its deadlock timer fires without finding a cycle
    const pR = R.query("select pg_advisory_xact_lock(dastar.unit_lock_key($1::uuid))", [seed.units[0]]);
    await waitForBackend(owner, "RR", { type: "Lock", event: "advisory" });
    // Not synchronization: this wait only lets R's one-shot deadlock check (deadlock_timeout=200ms) run and
    // find nothing, so that the later waiter, the hold, is the one whose check finds the cycle.
    await new Promise((res) => setTimeout(res, 500));

    // the hold requests the row R holds: cycle closed; the hold's check runs 200 ms later
    p.release();
    // attempt 2 of the hold queues on the unit lock that R obtained when attempt 1 rolled back
    await waitForBackend(owner, "RA", { type: "Lock", event: "advisory" }, 10_000).catch(() => undefined);
    await pR.catch(() => undefined);
    await R.query("rollback");

    const out = await pHold;
    expect(out.ok).toBe(true);
    expect(retries).toEqual([{ attempt: 1, sqlstate: "40P01" }]);
    expect(await deadlockCountStable(owner)).toBe(deadlocksAtStart + 1);
  });
});

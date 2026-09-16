import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { seedVenue, type Seed } from "./helpers/seed.js";
import { hold, type HoldInput } from "../src/commands/hold.js";

describe("hold retry on deadlock and serialization failure", () => {
  let conn: Conn; let owner: Client; let app: Client; let seed: Seed; let n = 0; let appPid = 0;

  beforeAll(async () => {
    conn = await cloneDatabase("hold_retry_test");
    owner = await connect(conn.owner);
    app = await connect(conn.app);
    appPid = (await app.query("select pg_backend_pid() as pid")).rows[0].pid as number;
    seed = await seedVenue(owner);
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100 where id = $1", [seed.venue]);
  });
  afterAll(async () => { await app.end(); await owner.end(); await dropDatabase("hold_retry_test"); });

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
});

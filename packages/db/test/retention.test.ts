import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Pool, type Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { setClock } from "./helpers/clock.js";
import { seedVenue, seedKey, type Seed } from "./helpers/seed.js";
import { hold, type HoldInput } from "../src/commands/hold.js";
import {
  purgeRetained, PUBLISHED_OUTBOX_RETENTION_DAYS, EXTERNAL_SESSION_RETENTION_DAYS,
  PURGE_SESSION_CALLS_SQL, PURGE_SESSION_TURNS_SQL, PURGE_SESSIONS_SQL,
} from "../src/commands/retention.js";
import { createDastar } from "../src/handle.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("retention", () => {
  let conn: Conn; let owner: Client; let app: Client; let worker: Client; let seed: Seed; let keyId: string; let n = 0;

  beforeAll(async () => {
    conn = await cloneDatabase("retention_test");
    owner = await connect(conn.owner);
    app = await connect(conn.app);
    worker = await connect(conn.worker);
    seed = await seedVenue(owner);
    keyId = await seedKey(owner);
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100 where id = $1", [seed.venue]);
  });
  afterAll(async () => {
    await worker.end(); await app.end(); await owner.end();
    await dropDatabase("retention_test");
  });
  // every test counts rows, so none starts with another's
  beforeEach(async () => {
    await owner.query("delete from dastar.idempotency");
    await owner.query("delete from dastar.outbox");
    // a session's calls and turns go with it
    await owner.query("delete from dastar_agent.session");
  });

  /** An idempotency row whose purge time is `offsetMs` from the real clock. */
  async function claim(key: string, offsetMs: number): Promise<void> {
    await owner.query(
      "insert into dastar.idempotency(venue_id, actor, key, request_hash, purge_at) values ($1, 'key:ret', $2, decode('00', 'hex'), now() + make_interval(secs => $3::float8))",
      [seed.venue, key, offsetMs / 1000],
    );
  }
  const keys = async (): Promise<string[]> =>
    (await owner.query("select key from dastar.idempotency order by key")).rows.map((r) => r.key as string);

  type OutboxState = "published" | "unpublished" | "dead" | "published and dead";
  /** An outbox row; a published one was published `ageMs` before the real clock. Returns its id. */
  async function event(state: OutboxState, ageMs = 0): Promise<number> {
    const r = await owner.query(
      `insert into dastar.outbox(venue_id, topic, payload, published_at, dead_lettered_at)
       values ($1, 'reservation.held', '{}'::jsonb,
               case when $2::text in ('published', 'published and dead') then now() - make_interval(secs => $3::float8) end,
               case when $2::text in ('dead', 'published and dead') then now() end)
       returning id`,
      [seed.venue, state, ageMs / 1000],
    );
    return Number(r.rows[0].id);
  }
  const outboxIds = async (): Promise<number[]> =>
    (await owner.query("select id from dastar.outbox order by id")).rows.map((r) => Number(r.id));

  /** A session last seen `seenAgoMs` before the real clock, with `calls` calls and `turns` turns. Returns its id. */
  async function session(kind: "external" | "reference", seenAgoMs: number, calls: number, turns: number): Promise<string> {
    const id = (await owner.query(
      `insert into dastar_agent.session(venue_id, api_key_id, kind, last_seen_at)
       values ($1, $2, $3::dastar_agent.session_kind, now() - make_interval(secs => $4::float8)) returning id`,
      [seed.venue, keyId, kind, seenAgoMs / 1000],
    )).rows[0].id as string;
    await owner.query(
      "insert into dastar_agent.tool_call(session_id, venue_id, tool, input) select $1, $2, 'hold', '{}'::jsonb from generate_series(1, $3::int)",
      [id, seed.venue, calls],
    );
    await owner.query(
      "insert into dastar_agent.turn(session_id, venue_id, seq, role, content) select $1, $2, g, 'user', 'text' from generate_series(0, $3::int - 1) g",
      [id, seed.venue, turns],
    );
    return id;
  }
  const sessionIds = async (): Promise<string[]> =>
    (await owner.query("select id from dastar_agent.session order by id")).rows.map((r) => r.id as string);
  /** The calls and turns the session still has. */
  async function rowsOf(id: string): Promise<{ calls: number; turns: number }> {
    const r = await owner.query(
      "select (select count(*) from dastar_agent.tool_call where session_id = $1)::int as calls, (select count(*) from dastar_agent.turn where session_id = $1)::int as turns",
      [id],
    );
    return r.rows[0] as { calls: number; turns: number };
  }

  function holdInput(over: Partial<HoldInput> = {}): HoldInput {
    n += 1;
    return {
      venueId: seed.venue, actor: "key:ret", traceId: `ret-t${n}`, idempotencyKey: `ret-k${n}`,
      partySize: 2, startsAt: new Date(Date.UTC(2062, 0, n, 19)).toISOString(), durationMinutes: 90, assignment: { kind: "unit", id: seed.units[0]! }, ...over,
    };
  }

  describe("idempotency rows", () => {
    it("deletes the rows past their purge time by the worker's clock, returns the count, and leaves the rest", async () => {
      await claim("due-a", -HOUR);
      await claim("due-b", -2 * HOUR);
      await claim("later-a", HOUR);
      await claim("later-b", 23 * HOUR);
      // nothing is due by the real clock except the two
      expect(await purgeRetained(worker)).toEqual({ idempotency: 2, outbox: 0, sessions: 0, calls: 0, turns: 0 });
      expect(await keys()).toEqual(["later-a", "later-b"]);
      expect(await purgeRetained(worker)).toEqual({ idempotency: 0, outbox: 0, sessions: 0, calls: 0, turns: 0 });
      expect(await keys()).toEqual(["later-a", "later-b"]);
      // the purge time is judged by the database clock the engine uses, so a clock a day ahead makes the rest due
      await setClock(worker, new Date(Date.now() + 25 * HOUR).toISOString());
      try {
        expect(await purgeRetained(worker)).toEqual({ idempotency: 2, outbox: 0, sessions: 0, calls: 0, turns: 0 });
      } finally {
        await setClock(worker, null);
      }
      expect(await keys()).toEqual([]);
    });

    it("takes at most `limit` rows a batch, the oldest first", async () => {
      await claim("k3", -HOUR);
      await claim("k1", -3 * HOUR);
      await claim("k2", -2 * HOUR);
      expect(await purgeRetained(worker, { limit: 2 })).toEqual({ idempotency: 2, outbox: 0, sessions: 0, calls: 0, turns: 0 });
      expect(await keys()).toEqual(["k3"]);
      expect(await purgeRetained(worker, { limit: 2 })).toEqual({ idempotency: 1, outbox: 0, sessions: 0, calls: 0, turns: 0 });
      expect(await keys()).toEqual([]);
    });

    it("a hold with a key replays until the key is purged, and executes afresh after", async () => {
      const i = holdInput();
      const first = await hold(app, i);
      expect(first).toMatchObject({ ok: true, replayed: false });
      expect(await hold(app, i)).toEqual({ ...first, replayed: true });
      // the key is 24 hours from its claim: a purge on the real clock keeps it, and it still replays
      expect(await purgeRetained(worker)).toEqual({ idempotency: 0, outbox: 0, sessions: 0, calls: 0, turns: 0 });
      expect(await hold(app, i)).toEqual({ ...first, replayed: true });
      await setClock(worker, new Date(Date.now() + 25 * HOUR).toISOString());
      try {
        expect(await purgeRetained(worker)).toEqual({ idempotency: 1, outbox: 0, sessions: 0, calls: 0, turns: 0 });
      } finally {
        await setClock(worker, null);
      }
      expect((await owner.query("select 1 from dastar.idempotency where key = $1", [i.idempotencyKey])).rowCount).toBe(0);
      // the same key and payload now run again, and the unit is still held by the first request
      const again = await hold(app, i);
      expect(again).toMatchObject({ ok: false, error: { code: "hold_conflict" }, replayed: false });
      const stored = await owner.query("select response from dastar.idempotency where key = $1", [i.idempotencyKey]);
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0].response).toMatchObject({ ok: false, error: { code: "hold_conflict" } });
    });

    it("leaves a row another transaction holds and takes it in the next batch", async () => {
      await claim("locked", -HOUR);
      await claim("free", -2 * HOUR);
      const other = await connect(conn.owner);
      try {
        await other.query("begin");
        await other.query("select 1 from dastar.idempotency where key = 'locked' for update");
        // a purge that waited for the row would fail on the timeout instead of passing
        await worker.query("set statement_timeout = '3s'");
        try {
          expect(await purgeRetained(worker)).toEqual({ idempotency: 1, outbox: 0, sessions: 0, calls: 0, turns: 0 });
        } finally {
          await worker.query("reset statement_timeout");
        }
        expect(await keys()).toEqual(["locked"]);
      } finally {
        await other.query("rollback").catch(() => undefined);
        await other.end();
      }
      expect(await purgeRetained(worker)).toEqual({ idempotency: 1, outbox: 0, sessions: 0, calls: 0, turns: 0 });
      expect(await keys()).toEqual([]);
    });
  });

  describe("outbox rows", () => {
    it("deletes the rows published more than seven days ago and keeps the published later, unpublished, and dead-lettered ones", async () => {
      expect(PUBLISHED_OUTBOX_RETENTION_DAYS).toBe(7);
      const old = await event("published", 8 * DAY);
      const recent = await event("published", 6 * DAY);
      const unpublished = await event("unpublished");
      const dead = await event("dead");
      // a dead-lettered row stays even when it also carries an old published_at
      const both = await event("published and dead", 8 * DAY);
      expect(await purgeRetained(worker)).toEqual({ idempotency: 0, outbox: 1, sessions: 0, calls: 0, turns: 0 });
      expect(await outboxIds()).toEqual([recent, unpublished, dead, both]);
      expect(await outboxIds()).not.toContain(old);
      expect(await purgeRetained(worker)).toEqual({ idempotency: 0, outbox: 0, sessions: 0, calls: 0, turns: 0 });
      // the age is judged by the worker's clock: two days later the recent row is eight days old
      await setClock(worker, new Date(Date.now() + 2 * DAY).toISOString());
      try {
        expect(await purgeRetained(worker)).toEqual({ idempotency: 0, outbox: 1, sessions: 0, calls: 0, turns: 0 });
      } finally {
        await setClock(worker, null);
      }
      // however late the clock, a row never published is not purged
      await setClock(worker, new Date(Date.now() + 400 * DAY).toISOString());
      try {
        expect(await purgeRetained(worker)).toEqual({ idempotency: 0, outbox: 0, sessions: 0, calls: 0, turns: 0 });
      } finally {
        await setClock(worker, null);
      }
      expect(await outboxIds()).toEqual([unpublished, dead, both]);
    });

    it("takes at most `limit` rows a batch, the oldest published first", async () => {
      const newest = await event("published", 8 * DAY);
      await event("published", 10 * DAY);
      await event("published", 9 * DAY);
      expect(await purgeRetained(worker, { limit: 2 })).toEqual({ idempotency: 0, outbox: 2, sessions: 0, calls: 0, turns: 0 });
      expect(await outboxIds()).toEqual([newest]);
      expect(await purgeRetained(worker, { limit: 2 })).toEqual({ idempotency: 0, outbox: 1, sessions: 0, calls: 0, turns: 0 });
      expect(await outboxIds()).toEqual([]);
    });

    it("bounds each table by the limit on its own", async () => {
      await claim("i1", -HOUR);
      await claim("i2", -HOUR);
      await claim("i3", -HOUR);
      await event("published", 8 * DAY);
      await event("published", 9 * DAY);
      await event("published", 10 * DAY);
      expect(await purgeRetained(worker, { limit: 2 })).toEqual({ idempotency: 2, outbox: 2, sessions: 0, calls: 0, turns: 0 });
      expect(await purgeRetained(worker, { limit: 2 })).toEqual({ idempotency: 1, outbox: 1, sessions: 0, calls: 0, turns: 0 });
    });
  });

  describe("external sessions", () => {
    it("purges an external session 30 days after it was last seen, with its calls and turns, and not before", async () => {
      expect(EXTERNAL_SESSION_RETENTION_DAYS).toBe(30);
      const due = await session("external", 30 * DAY + HOUR, 2, 1);
      const kept = await session("external", 30 * DAY - HOUR, 3, 2);
      expect(await purgeRetained(worker)).toEqual({ idempotency: 0, outbox: 0, sessions: 1, calls: 2, turns: 1 });
      expect(await sessionIds()).toEqual([kept]);
      expect(await rowsOf(due)).toEqual({ calls: 0, turns: 0 });
      expect(await rowsOf(kept)).toEqual({ calls: 3, turns: 2 });
      expect(await purgeRetained(worker)).toEqual({ idempotency: 0, outbox: 0, sessions: 0, calls: 0, turns: 0 });
      expect(await rowsOf(kept)).toEqual({ calls: 3, turns: 2 });
    });

    it("a batch deletes at most limit calls and limit turns, and a session once nothing of it is left", async () => {
      const due = await session("external", 31 * DAY, 5, 3);
      expect(await purgeRetained(worker, { limit: 2 })).toEqual({ idempotency: 0, outbox: 0, sessions: 0, calls: 2, turns: 2 });
      expect(await rowsOf(due)).toEqual({ calls: 3, turns: 1 });
      expect(await purgeRetained(worker, { limit: 2 })).toEqual({ idempotency: 0, outbox: 0, sessions: 0, calls: 2, turns: 1 });
      expect(await rowsOf(due)).toEqual({ calls: 1, turns: 0 });
      expect(await sessionIds()).toEqual([due]);
      expect(await purgeRetained(worker, { limit: 2 })).toEqual({ idempotency: 0, outbox: 0, sessions: 1, calls: 1, turns: 0 });
      expect(await sessionIds()).toEqual([]);
    });

    it("a batch reads only the oldest limit due sessions, so an empty one behind a busy one waits its turn", async () => {
      const oldest = await session("external", 33 * DAY, 5, 0);
      await session("external", 32 * DAY, 0, 0);
      const newest = await session("external", 31 * DAY, 0, 0);
      expect(await purgeRetained(worker, { limit: 2 })).toEqual({ idempotency: 0, outbox: 0, sessions: 1, calls: 2, turns: 0 });
      expect(await sessionIds()).toEqual([oldest, newest]);
      expect(await rowsOf(oldest)).toEqual({ calls: 3, turns: 0 });
      expect(await purgeRetained(worker, { limit: 2 })).toEqual({ idempotency: 0, outbox: 0, sessions: 1, calls: 2, turns: 0 });
      expect(await sessionIds()).toEqual([oldest]);
      expect(await purgeRetained(worker, { limit: 2 })).toEqual({ idempotency: 0, outbox: 0, sessions: 1, calls: 1, turns: 0 });
      expect(await sessionIds()).toEqual([]);
    });

    it("keeps a session for 10 minutes after it is no longer live", async () => {
      const id = await session("external", 30 * DAY + 5 * 60_000, 1, 1);
      const live = await owner.query(
        "select dastar_agent.session_live(kind, last_seen_at) as live from dastar_agent.session where id = $1",
        [id],
      );
      expect(live.rows[0].live).toBe(false);
      expect(await purgeRetained(worker)).toEqual({ idempotency: 0, outbox: 0, sessions: 0, calls: 0, turns: 0 });
      expect(await sessionIds()).toEqual([id]);
      expect(await rowsOf(id)).toEqual({ calls: 1, turns: 1 });
    });

    it("each session purge statement reads due sessions by last_seen_at and their rows by session", async () => {
      // 2000 live external sessions last seen over the last 29 days and 3 due ones, each with 10 calls and 2 turns
      await owner.query(
        `insert into dastar_agent.session(venue_id, api_key_id, kind, last_seen_at)
         select $1::uuid, $2::uuid, 'external'::dastar_agent.session_kind, now() - make_interval(secs => (g * 29 * 86400.0 / 2000)::float8)
           from generate_series(1, 2000) g`,
        [seed.venue, keyId],
      );
      await owner.query(
        `insert into dastar_agent.session(venue_id, api_key_id, kind, last_seen_at)
         select $1::uuid, $2::uuid, 'external'::dastar_agent.session_kind, now() - make_interval(days => 31) - make_interval(mins => g)
           from generate_series(1, 3) g`,
        [seed.venue, keyId],
      );
      await owner.query(
        `insert into dastar_agent.tool_call(session_id, venue_id, tool, input)
         select s.id, s.venue_id, 'hold', '{}'::jsonb from dastar_agent.session s cross join generate_series(1, 10)`,
      );
      await owner.query(
        `insert into dastar_agent.turn(session_id, venue_id, seq, role, content)
         select s.id, s.venue_id, g, 'user', 'text' from dastar_agent.session s cross join generate_series(0, 1) g`,
      );
      await owner.query("analyze dastar_agent.session");
      await owner.query("analyze dastar_agent.tool_call");
      await owner.query("analyze dastar_agent.turn");

      const planOf = async (sql: string): Promise<string[]> =>
        (await worker.query(`explain (costs off) ${sql}`, [500, 10])).rows.map((r) => r["QUERY PLAN"] as string);
      const expectations: [string, string, string | null][] = [
        ["calls", PURGE_SESSION_CALLS_SQL, "tool_call_session"],
        ["turns", PURGE_SESSION_TURNS_SQL, "turn_session_id_seq_key"],
        ["sessions", PURGE_SESSIONS_SQL, null],
      ];
      for (const [name, sql, rowIndex] of expectations) {
        const plan = await planOf(sql);
        const text = `${name}\n${plan.join("\n")}`;
        expect(plan.some((line) => /Index Cond: .*last_seen_at <=/.test(line)), text).toBe(true);
        expect(plan.some((line) => line.includes("session_external_last_seen")), text).toBe(true);
        if (rowIndex !== null) {
          expect(plan.some((line) => line.includes(rowIndex)), text).toBe(true);
          expect(plan.some((line) => /Index Cond: .*session_id =/.test(line)), text).toBe(true);
        }
      }

      expect(await purgeRetained(worker)).toEqual({ idempotency: 0, outbox: 0, sessions: 3, calls: 30, turns: 6 });
      const left = await owner.query(
        `select (select count(*) from dastar_agent.session)::int as sessions,
                (select count(*) from dastar_agent.tool_call)::int as calls,
                (select count(*) from dastar_agent.turn)::int as turns,
                (select count(*) from dastar_agent.session s
                  where (select count(*) from dastar_agent.tool_call c where c.session_id = s.id) = 10
                    and (select count(*) from dastar_agent.turn t where t.session_id = s.id) = 2)::int as whole`,
      );
      expect(left.rows[0]).toEqual({ sessions: 2000, calls: 20_000, turns: 4_000, whole: 2000 });
    }, 120_000);

    it("never purges a reference session by age", async () => {
      const reference = await session("reference", 60 * DAY, 2, 2);
      expect(await purgeRetained(worker)).toEqual({ idempotency: 0, outbox: 0, sessions: 0, calls: 0, turns: 0 });
      expect(await sessionIds()).toEqual([reference]);
      expect(await rowsOf(reference)).toEqual({ calls: 2, turns: 2 });
    });
  });

  it("is refused forbidden for the application role, which deletes nothing", async () => {
    await claim("due", -HOUR);
    const published = await event("published", 8 * DAY);
    await expect(purgeRetained(app)).rejects.toMatchObject({ name: "DastarError", code: "forbidden" });
    await expect(purgeRetained(app, { limit: 1 })).rejects.toMatchObject({ name: "DastarError", code: "forbidden" });
    expect(await keys()).toEqual(["due"]);
    expect(await outboxIds()).toEqual([published]);
    // the same rows go to the worker role
    expect(await purgeRetained(worker)).toEqual({ idempotency: 1, outbox: 1, sessions: 0, calls: 0, turns: 0 });
  });

  it("the handle runs purgeRetained as a command of its own and returns the counts", async () => {
    const pool = new Pool({ connectionString: conn.worker, max: 2 });
    pool.on("error", () => undefined);
    const seen: { command: string; traceId: string | null }[] = [];
    const d = createDastar({ pool, onAcquire: (i) => { seen.push({ command: i.command, traceId: i.traceId }); } });
    try {
      await claim("h1", -HOUR);
      await claim("h2", -2 * HOUR);
      await claim("h3", HOUR);
      await event("published", 8 * DAY);
      expect(await d.purgeRetained({ limit: 1 })).toEqual({ idempotency: 1, outbox: 1, sessions: 0, calls: 0, turns: 0 });
      expect(await keys()).toEqual(["h1", "h3"]);
      expect(await d.purgeRetained()).toEqual({ idempotency: 1, outbox: 0, sessions: 0, calls: 0, turns: 0 });
      expect(await keys()).toEqual(["h3"]);
      expect(seen).toEqual([{ command: "purgeRetained", traceId: null }, { command: "purgeRetained", traceId: null }]);
    } finally {
      await d.close();
      await pool.end();
    }
  });
});

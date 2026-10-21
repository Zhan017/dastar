import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Pool, type Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { setClock } from "./helpers/clock.js";
import { seedVenue, type Seed } from "./helpers/seed.js";
import { hold, type HoldInput } from "../src/commands/hold.js";
import { purgeRetained, PUBLISHED_OUTBOX_RETENTION_DAYS } from "../src/commands/retention.js";
import { createDastar } from "../src/handle.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("retention", () => {
  let conn: Conn; let owner: Client; let app: Client; let worker: Client; let seed: Seed; let n = 0;

  beforeAll(async () => {
    conn = await cloneDatabase("retention_test");
    owner = await connect(conn.owner);
    app = await connect(conn.app);
    worker = await connect(conn.worker);
    seed = await seedVenue(owner);
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
      expect(await purgeRetained(worker)).toEqual({ idempotency: 2, outbox: 0 });
      expect(await keys()).toEqual(["later-a", "later-b"]);
      expect(await purgeRetained(worker)).toEqual({ idempotency: 0, outbox: 0 });
      expect(await keys()).toEqual(["later-a", "later-b"]);
      // the purge time is judged by the database clock the engine uses, so a clock a day ahead makes the rest due
      await setClock(worker, new Date(Date.now() + 25 * HOUR).toISOString());
      try {
        expect(await purgeRetained(worker)).toEqual({ idempotency: 2, outbox: 0 });
      } finally {
        await setClock(worker, null);
      }
      expect(await keys()).toEqual([]);
    });

    it("takes at most `limit` rows a batch, the oldest first", async () => {
      await claim("k3", -HOUR);
      await claim("k1", -3 * HOUR);
      await claim("k2", -2 * HOUR);
      expect(await purgeRetained(worker, { limit: 2 })).toEqual({ idempotency: 2, outbox: 0 });
      expect(await keys()).toEqual(["k3"]);
      expect(await purgeRetained(worker, { limit: 2 })).toEqual({ idempotency: 1, outbox: 0 });
      expect(await keys()).toEqual([]);
    });

    it("a hold with a key replays until the key is purged, and executes afresh after", async () => {
      const i = holdInput();
      const first = await hold(app, i);
      expect(first).toMatchObject({ ok: true, replayed: false });
      expect(await hold(app, i)).toEqual({ ...first, replayed: true });
      // the key is 24 hours from its claim: a purge on the real clock keeps it, and it still replays
      expect(await purgeRetained(worker)).toEqual({ idempotency: 0, outbox: 0 });
      expect(await hold(app, i)).toEqual({ ...first, replayed: true });
      await setClock(worker, new Date(Date.now() + 25 * HOUR).toISOString());
      try {
        expect(await purgeRetained(worker)).toEqual({ idempotency: 1, outbox: 0 });
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
          expect(await purgeRetained(worker)).toEqual({ idempotency: 1, outbox: 0 });
        } finally {
          await worker.query("reset statement_timeout");
        }
        expect(await keys()).toEqual(["locked"]);
      } finally {
        await other.query("rollback").catch(() => undefined);
        await other.end();
      }
      expect(await purgeRetained(worker)).toEqual({ idempotency: 1, outbox: 0 });
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
      expect(await purgeRetained(worker)).toEqual({ idempotency: 0, outbox: 1 });
      expect(await outboxIds()).toEqual([recent, unpublished, dead, both]);
      expect(await outboxIds()).not.toContain(old);
      expect(await purgeRetained(worker)).toEqual({ idempotency: 0, outbox: 0 });
      // the age is judged by the worker's clock: two days later the recent row is eight days old
      await setClock(worker, new Date(Date.now() + 2 * DAY).toISOString());
      try {
        expect(await purgeRetained(worker)).toEqual({ idempotency: 0, outbox: 1 });
      } finally {
        await setClock(worker, null);
      }
      // however late the clock, a row never published is not purged
      await setClock(worker, new Date(Date.now() + 400 * DAY).toISOString());
      try {
        expect(await purgeRetained(worker)).toEqual({ idempotency: 0, outbox: 0 });
      } finally {
        await setClock(worker, null);
      }
      expect(await outboxIds()).toEqual([unpublished, dead, both]);
    });

    it("takes at most `limit` rows a batch, the oldest published first", async () => {
      const newest = await event("published", 8 * DAY);
      await event("published", 10 * DAY);
      await event("published", 9 * DAY);
      expect(await purgeRetained(worker, { limit: 2 })).toEqual({ idempotency: 0, outbox: 2 });
      expect(await outboxIds()).toEqual([newest]);
      expect(await purgeRetained(worker, { limit: 2 })).toEqual({ idempotency: 0, outbox: 1 });
      expect(await outboxIds()).toEqual([]);
    });

    it("bounds each table by the limit on its own", async () => {
      await claim("i1", -HOUR);
      await claim("i2", -HOUR);
      await claim("i3", -HOUR);
      await event("published", 8 * DAY);
      await event("published", 9 * DAY);
      await event("published", 10 * DAY);
      expect(await purgeRetained(worker, { limit: 2 })).toEqual({ idempotency: 2, outbox: 2 });
      expect(await purgeRetained(worker, { limit: 2 })).toEqual({ idempotency: 1, outbox: 1 });
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
    expect(await purgeRetained(worker)).toEqual({ idempotency: 1, outbox: 1 });
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
      expect(await d.purgeRetained({ limit: 1 })).toEqual({ idempotency: 1, outbox: 1 });
      expect(await keys()).toEqual(["h1", "h3"]);
      expect(await d.purgeRetained()).toEqual({ idempotency: 1, outbox: 0 });
      expect(await keys()).toEqual(["h3"]);
      expect(seen).toEqual([{ command: "purgeRetained", traceId: null }, { command: "purgeRetained", traceId: null }]);
    } finally {
      await d.close();
      await pool.end();
    }
  });
});

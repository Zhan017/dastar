import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool, type Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { setClock } from "./helpers/clock.js";
import { seedVenue, type Seed } from "./helpers/seed.js";
import { createDastar } from "../src/handle.js";
import { hold, type HoldInput } from "../src/commands/hold.js";
import { confirm } from "../src/commands/confirm.js";
import { cancel } from "../src/commands/cancel.js";
import { listHolds, type HoldView } from "../src/commands/list-holds.js";

type Placed = { id: string; holdExpiresAt: string };

describe("list holds", () => {
  let conn: Conn; let owner: Client; let app: Client;
  let V1: Seed; let V2: Seed;
  let aLate: Placed; let aSoon: Placed; let aMid: Placed;
  let aConfirmed: Placed; let aCancelled: Placed; let aPastExpiry: Placed; let aOtherVenue: Placed; let bOne: Placed;
  let n = 0;
  const ALICE = "key:alice";
  const BOB = "key:bob";
  const ABSENT = "00000000-0000-7000-8000-000000000000";

  /**
   * One hold through the engine; every call gets its own day, so no overlap is in the way. `clockOffsetMs` moves the
   * database clock for the hold alone: the hold expires at that clock plus the venue's hold time, so a hold made on
   * an earlier clock expires earlier.
   */
  async function place(seed: Seed, actor: string, over: Partial<HoldInput> = {}, clockOffsetMs = 0): Promise<Placed> {
    n += 1;
    const start = new Date(Date.UTC(2048, 0, 1 + n, 19));
    const input: HoldInput = {
      venueId: seed.venue, actor, traceId: `lh-h${n}`, idempotencyKey: `lh-k${n}`,
      partySize: 2, startsAt: start.toISOString(), durationMinutes: 90, assignment: { kind: "unit", id: seed.units[0]! }, ...over,
    };
    if (clockOffsetMs !== 0) await setClock(app, new Date(Date.now() + clockOffsetMs).toISOString());
    try {
      const out = await hold(app, input);
      if (!out.ok) throw new Error(out.error.code);
      return { id: out.receipt.reservationId, holdExpiresAt: out.holdExpiresAt };
    } finally {
      if (clockOffsetMs !== 0) await setClock(app, null);
    }
  }
  const ctx = (seed: Seed, actor: string) => ({ actor, traceId: `lh-t${++n}`, venueId: seed.venue });
  const ids = (views: HoldView[]): string[] => views.map((v) => v.id);
  async function duringOf(id: string): Promise<string> {
    return (await owner.query("select during from dastar.reservation where id = $1", [id])).rows[0].during as string;
  }

  beforeAll(async () => {
    conn = await cloneDatabase("list_holds_test");
    owner = await connect(conn.owner);
    app = await connect(conn.app);
    V1 = await seedVenue(owner);
    V2 = await seedVenue(owner);
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100, hold_ttl_seconds = 3600 where id = any($1::uuid[])", [[V1.venue, V2.venue]]);

    // Alice's three live holds, made in an order that is not their expiry order: the venue's hold time is an hour, so on
    // a clock thirty minutes behind a hold expires in thirty minutes, and on a clock ten minutes behind in fifty
    aLate = await place(V1, ALICE);
    aSoon = await place(V1, ALICE, { partySize: 6, assignment: { kind: "combo", id: V1.combos[0]!.id }, externalRef: "walk-in-7" }, -1_800_000);
    aMid = await place(V1, ALICE, { partySize: 3, assignment: { kind: "unit", id: V1.units[1]! } }, -600_000);
    // the ones that are not live: confirmed, cancelled, and still stored as held an hour past their expiry
    aConfirmed = await place(V1, ALICE);
    await confirm(app, { reservationId: aConfirmed.id, ...ctx(V1, ALICE) });
    aCancelled = await place(V1, ALICE);
    await cancel(app, { reservationId: aCancelled.id, ...ctx(V1, ALICE), reason: "guest" });
    aPastExpiry = await place(V1, ALICE, {}, -7_200_000);
    // Alice's hold in the second venue, and Bob's hold in the first
    aOtherVenue = await place(V2, ALICE);
    bOne = await place(V1, BOB);
  });
  afterAll(async () => {
    await app.end(); await owner.end();
    await dropDatabase("list_holds_test");
  });

  it("returns exactly the actor's live holds in the venue, soonest expiry first, with the view's fields", async () => {
    const out = await listHolds(app, { venueId: V1.venue, actor: ALICE });
    // creation order is aLate, aSoon, aMid (and so is id order); expiry order is not
    expect(ids(out)).toEqual([aSoon.id, aMid.id, aLate.id]);
    expect(out).toEqual([
      {
        id: aSoon.id, partySize: 6, during: await duringOf(aSoon.id), assignment: { kind: "combo", id: V1.combos[0]!.id },
        holdExpiresAt: aSoon.holdExpiresAt, version: 1, externalRef: "walk-in-7",
      },
      {
        id: aMid.id, partySize: 3, during: await duringOf(aMid.id), assignment: { kind: "unit", id: V1.units[1] },
        holdExpiresAt: aMid.holdExpiresAt, version: 1, externalRef: null,
      },
      {
        id: aLate.id, partySize: 2, during: await duringOf(aLate.id), assignment: { kind: "unit", id: V1.units[0] },
        holdExpiresAt: aLate.holdExpiresAt, version: 1, externalRef: null,
      },
    ]);
    const expiries = out.map((v) => new Date(v.holdExpiresAt).getTime());
    expect(expiries).toEqual([...expiries].sort((x, y) => x - y));
  });

  it("leaves out a confirmed hold, a cancelled one, one past its expiry that is still stored as held, another actor's, and another venue's", async () => {
    // the past-expiry hold is absent because of the time predicate: its stored status is still held
    expect((await owner.query("select status from dastar.reservation where id = $1", [aPastExpiry.id])).rows[0].status).toBe("held");
    expect(new Date(aPastExpiry.holdExpiresAt).getTime()).toBeLessThan(Date.now());
    expect((await owner.query("select status from dastar.reservation where id = any($1::uuid[]) order by status::text", [[aConfirmed.id, aCancelled.id]])).rows.map((r) => r.status)).toEqual(["cancelled", "confirmed"]);

    const out = ids(await listHolds(app, { venueId: V1.venue, actor: ALICE }));
    for (const left of [aConfirmed, aCancelled, aPastExpiry, aOtherVenue, bOne]) expect(out).not.toContain(left.id);
    expect(out).toHaveLength(3);
  });

  it("another actor's list has that actor's holds only", async () => {
    const out = await listHolds(app, { venueId: V1.venue, actor: BOB });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: bOne.id, partySize: 2, version: 1, externalRef: null, holdExpiresAt: bOne.holdExpiresAt });
  });

  it("an actor with no holds gets an empty list, and so does an unknown venue", async () => {
    expect(await listHolds(app, { venueId: V1.venue, actor: "key:nobody" })).toEqual([]);
    expect(await listHolds(app, { venueId: ABSENT, actor: ALICE })).toEqual([]);
  });

  it("the second venue's list has only its own holds", async () => {
    const out = await listHolds(app, { venueId: V2.venue, actor: ALICE });
    expect(ids(out)).toEqual([aOtherVenue.id]);
    expect(out[0]).toMatchObject({ assignment: { kind: "unit", id: V2.units[0] } });
    expect(await listHolds(app, { venueId: V2.venue, actor: BOB })).toEqual([]);
  });

  it("liveness is judged by the database clock: a hold drops out when the clock passes its expiry, and returns with the clock", async () => {
    const at = (iso: string, plusMs: number) => new Date(new Date(iso).getTime() + plusMs).toISOString();
    try {
      await setClock(app, at(aMid.holdExpiresAt, 1));
      expect(ids(await listHolds(app, { venueId: V1.venue, actor: ALICE }))).toEqual([aLate.id]);
      await setClock(app, at(aLate.holdExpiresAt, 1));
      expect(await listHolds(app, { venueId: V1.venue, actor: ALICE })).toEqual([]);
    } finally {
      await setClock(app, null);
    }
    expect(ids(await listHolds(app, { venueId: V1.venue, actor: ALICE }))).toEqual([aSoon.id, aMid.id, aLate.id]);
  });

  it("a hold leaves the list when it is confirmed or cancelled", async () => {
    const dave = "key:dave";
    const first = await place(V1, dave);
    const second = await place(V1, dave);
    const third = await place(V1, dave);
    expect(ids(await listHolds(app, { venueId: V1.venue, actor: dave }))).toEqual([first.id, second.id, third.id]);
    await confirm(app, { reservationId: first.id, ...ctx(V1, dave) });
    expect(ids(await listHolds(app, { venueId: V1.venue, actor: dave }))).toEqual([second.id, third.id]);
    await cancel(app, { reservationId: second.id, ...ctx(V1, dave), reason: "guest" });
    expect(ids(await listHolds(app, { venueId: V1.venue, actor: dave }))).toEqual([third.id]);
  });

  it("a malformed venue id rejects with a DastarError, code internal, and leaves the connection usable", async () => {
    await expect(listHolds(app, { venueId: "not-a-uuid", actor: ALICE })).rejects.toMatchObject({ name: "DastarError", code: "internal" });
    expect((await app.query("select 1 as one")).rows[0].one).toBe(1);
    expect(ids(await listHolds(app, { venueId: V1.venue, actor: BOB }))).toEqual([bOne.id]);
  });

  it("the handle runs listHolds as a command of its own and returns what the engine returns", async () => {
    const pool = new Pool({ connectionString: conn.app, max: 2 });
    pool.on("error", () => undefined);
    const seen: { command: string; traceId: string | null }[] = [];
    const d = createDastar({ pool, onAcquire: (i) => { seen.push({ command: i.command, traceId: i.traceId }); } });
    try {
      const viaHandle = await d.listHolds({ venueId: V1.venue, actor: ALICE });
      expect(viaHandle).toEqual(await listHolds(app, { venueId: V1.venue, actor: ALICE }));
      expect(viaHandle).toHaveLength(3);
      expect(seen).toEqual([{ command: "listHolds", traceId: null }]);
    } finally {
      await d.close();
      await pool.end();
    }
  });
});

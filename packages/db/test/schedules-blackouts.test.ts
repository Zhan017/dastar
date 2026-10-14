import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { setClock } from "./helpers/clock.js";
import { seedVenue, type Seed } from "./helpers/seed.js";
import { connectAs, waitForBackend, deadlockCountStable, pause, outcome, type Outcome } from "./helpers/wait.js";
import { mapPgError } from "../src/errors.js";
import { hold, rangeLiteral, type HoldInput, type HoldOutcome } from "../src/commands/hold.js";
import { confirm } from "../src/commands/confirm.js";
import { cancel } from "../src/commands/cancel.js";
import { seat, complete } from "../src/commands/seat.js";
import { expireDue } from "../src/commands/expire.js";

describe("schedules and blackouts", () => {
  let conn: Conn; let owner: Client; let app: Client; let worker: Client; let H: Client; let W: Client;
  let A: Seed; let B: Seed;
  let n = 0; let dayN = 0;

  beforeAll(async () => {
    conn = await cloneDatabase("schedules_blackouts_test");
    owner = await connect(conn.owner);
    app = await connect(conn.app);
    worker = await connect(conn.worker);
    H = await connectAs(conn.app, "bk-H");
    W = await connectAs(conn.app, "bk-W");
    A = await seedVenue(owner);
    B = await seedVenue(owner);
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100 where id = any($1::uuid[])", [[A.venue, B.venue]]);
    // direct statements as the application role run bound to venue A, as an engine command would bind it
    await app.query("select set_config('dastar.venue_id', $1, false)", [A.venue]);
    await W.query("select set_config('dastar.venue_id', $1, false)", [A.venue]);
  });
  afterAll(async () => {
    await W.end(); await H.end(); await worker.end(); await app.end(); await owner.end();
    await dropDatabase("schedules_blackouts_test");
  });

  type ScheduleRow = { day: number; opens: string; closes: string; nextDay: boolean; durations: string; gap: number };
  const VALID: ScheduleRow = { day: 5, opens: "17:00", closes: "23:00", nextDay: false, durations: '{"2":90,"4":120}', gap: 15 };

  /** One schedule row, written as `c`; `over` changes what it differs from a well-formed Friday evening service. */
  function insertSchedule(c: Client, venueId: string, over: Partial<ScheduleRow> = {}) {
    const r = { ...VALID, ...over };
    return c.query(
      `insert into dastar.schedule(venue_id, day_of_week, opens, closes, closes_next_day, duration_by_size, gap_minutes)
       values ($1, $2, $3::time, $4::time, $5, $6::jsonb, $7) returning id`,
      [venueId, r.day, r.opens, r.closes, r.nextDay, r.durations, r.gap],
    );
  }
  function insertBlackout(c: Client, venueId: string, during: string, reason = "closed", active = true) {
    return c.query(
      "insert into dastar.blackout(venue_id, during, reason, active) values ($1, $2::tstzrange, $3, $4) returning id",
      [venueId, during, reason, active],
    );
  }
  const configVersion = async (venueId: string): Promise<number> =>
    Number((await owner.query("select config_version from dastar.venue where id = $1", [venueId])).rows[0].config_version);

  /** The two ways a row is written; the connections exist only once `beforeAll` has run, so each is read when a test starts. */
  const WRITERS: { who: string; client: () => Client }[] = [
    { who: "the owner", client: () => owner },
    { who: "dastar_app bound to the venue", client: () => app },
  ];

  describe("schedule", () => {
    const VALID_CASES: [string, Partial<ScheduleRow>][] = [
      ["a Friday evening service", {}],
      ["Monday", { day: 1 }],
      ["Sunday", { day: 7 }],
      ["a period that ends after midnight", { opens: "18:00", closes: "02:00", nextDay: true }],
      ["a period around the clock, which closes where it opens", { opens: "00:00", closes: "00:00", nextDay: true }],
      ["no gap", { gap: 0 }],
      ["the largest gap", { gap: 720 }],
      ["one key at the smallest duration", { durations: '{"1":5}' }],
      ["one key at the largest party size and duration", { durations: '{"999":720}' }],
      ["several keys", { durations: '{"1":5,"2":60,"4":90,"999":720}' }],
    ];
    for (const { who, client: clientOf } of WRITERS) {
      it(`${who} writes a well-formed schedule, with the defaults the table states`, async () => {
        const client = clientOf();
        for (const [label, over] of VALID_CASES) {
          const id = (await insertSchedule(client, A.venue, over)).rows[0].id as string;
          expect(id, label).toMatch(/^[0-9a-f-]{36}$/);
        }
        const row = (await owner.query("select closes_next_day, active, created_at from dastar.schedule where id = $1",
          [(await insertSchedule(client, A.venue)).rows[0].id])).rows[0];
        expect(row).toMatchObject({ closes_next_day: false, active: true });
        expect(row.created_at).toBeInstanceOf(Date);
      });
    }

    /** Every case below is refused by a CHECK, never by an evaluation error: SQLSTATE 23514. */
    const INVALID_CASES: [string, Partial<ScheduleRow>][] = [
      ["day 0", { day: 0 }],
      ["day 8", { day: 8 }],
      ["a period that ends after midnight, not saying so", { opens: "18:00", closes: "02:00", nextDay: false }],
      ["a same-day period saying it ends after midnight", { opens: "10:00", closes: "22:00", nextDay: true }],
      ["a period that closes where it opens, not saying so", { opens: "10:00", closes: "10:00", nextDay: false }],
      ["a gap of -1", { gap: -1 }],
      ["a gap of 721", { gap: 721 }],
      ["durations that are an array", { durations: "[90]" }],
      ["durations that are an empty array", { durations: "[]" }],
      ["durations that are a string", { durations: '"90"' }],
      ["durations that are a number", { durations: "90" }],
      ["durations that are a boolean", { durations: "true" }],
      ["durations that are a JSON null", { durations: "null" }],
      ["durations with no key", { durations: "{}" }],
      ["a key of 0", { durations: '{"0":60}' }],
      ["a key of 1000", { durations: '{"1000":60}' }],
      ["a key with a leading zero", { durations: '{"01":60}' }],
      ["a key that is not an integer", { durations: '{"1.5":60}' }],
      ["a negative key", { durations: '{"-1":60}' }],
      ["a key that is a word", { durations: '{"two":60}' }],
      ["a key with a space", { durations: '{" 2":60}' }],
      ["an empty key", { durations: '{"":60}' }],
      ["a value of 4", { durations: '{"2":4}' }],
      ["a value of 721", { durations: '{"2":721}' }],
      ["a value of 0", { durations: '{"2":0}' }],
      ["a negative value", { durations: '{"2":-60}' }],
      ["a value of 90.5", { durations: '{"2":90.5}' }],
      ["a value that is a string", { durations: '{"2":"90"}' }],
      ["a value that is a JSON null", { durations: '{"2":null}' }],
      ["a value that is a boolean", { durations: '{"2":true}' }],
      ["a value that is an array", { durations: '{"2":[90]}' }],
      ["a value that is an object", { durations: '{"2":{"minutes":90}}' }],
      ["a valid key followed by a value of 4", { durations: '{"2":60,"4":4}' }],
      ["a valid key followed by a key that is a word", { durations: '{"2":60,"x":60}' }],
    ];
    for (const { who, client: clientOf } of WRITERS) {
      it(`${who} is refused every malformed schedule with a check violation (23514)`, async () => {
        const client = clientOf();
        for (const [label, over] of INVALID_CASES) {
          await expect(insertSchedule(client, A.venue, over), label).rejects.toMatchObject({ code: "23514" });
        }
      });
    }

    it("names the constraint that refused the row", async () => {
      await expect(insertSchedule(owner, A.venue, { durations: "{}" })).rejects.toMatchObject({ code: "23514", constraint: "duration_by_size_shape" });
      await expect(insertSchedule(owner, A.venue, { nextDay: true, opens: "10:00", closes: "22:00" })).rejects.toMatchObject({ code: "23514", constraint: "schedule_closes_next_day" });
    });

    it("a schedule of a venue that does not exist is refused (23503)", async () => {
      await expect(insertSchedule(owner, "00000000-0000-7000-8000-000000000000")).rejects.toMatchObject({ code: "23503" });
    });

    it("an update is held to the same checks", async () => {
      const id = (await insertSchedule(app, A.venue)).rows[0].id as string;
      await expect(app.query("update dastar.schedule set duration_by_size = '{\"2\":4}' where id = $1", [id])).rejects.toMatchObject({ code: "23514" });
      await expect(app.query("update dastar.schedule set closes_next_day = true where id = $1", [id])).rejects.toMatchObject({ code: "23514" });
      expect((await app.query("update dastar.schedule set duration_by_size = '{\"2\":45}', gap_minutes = 10, active = false where id = $1", [id])).rowCount).toBe(1);
    });
  });

  describe("blackout", () => {
    const DAY = (d: number) => `2091-02-${String(d).padStart(2, "0")}T00:00:00Z`;
    const range = (from: number, to: number) => `[${DAY(from)},${DAY(to)})`;

    for (const { who, client: clientOf } of WRITERS) {
      it(`${who} writes a bounded range with a reason of 1 to 500 characters, active by default`, async () => {
        const client = clientOf();
        const id = (await insertBlackout(client, A.venue, range(1, 2), "x")).rows[0].id as string;
        await insertBlackout(client, A.venue, range(3, 4), "r".repeat(500));
        const row = (await owner.query("select active, reason from dastar.blackout where id = $1", [id])).rows[0];
        expect(row).toEqual({ active: true, reason: "x" });
      });

      it(`${who} is refused an empty, unbounded, not half-open, or too-long-reasoned blackout with a check violation (23514)`, async () => {
        const client = clientOf();
        const refused = (during: string, reason = "closed") => expect(insertBlackout(client, A.venue, during, reason), `${during} / ${reason.length} chars`).rejects.toMatchObject({ code: "23514" });
        await refused("empty");
        await refused(`[${DAY(5)},${DAY(5)})`);
        await refused(`(${DAY(5)},${DAY(5)}]`);
        await refused(`[${DAY(5)},)`);
        await refused(`(,${DAY(5)})`);
        await refused("(,)");
        // half-open as reservations are, so a boundary means the same thing in both tables
        await refused(`(${DAY(5)},${DAY(6)})`);
        await refused(`[${DAY(5)},${DAY(6)}]`);
        await refused(`(${DAY(5)},${DAY(6)}]`);
        await refused(range(5, 6), "");
        await refused(range(5, 6), "r".repeat(501));
      });

      it(`${who} is refused an infinite bound by the bounded-range constraint (23514)`, async () => {
        const client = clientOf();
        // an explicit infinite bound is not an unbounded range for lower_inf and upper_inf, so the constraint also asks for finite bounds
        for (const during of [`[${DAY(5)},infinity)`, `[-infinity,${DAY(5)})`]) {
          await expect(insertBlackout(client, A.venue, during), during).rejects.toMatchObject({ code: "23514", constraint: "blackout_during_bounded" });
        }
      });

      it(`${who} cannot write a reversed range: the range type itself refuses it (22000)`, async () => {
        const client = clientOf();
        await expect(insertBlackout(client, A.venue, range(9, 8))).rejects.toMatchObject({ code: "22000" });
      });
    }

    it("a blackout of a venue that does not exist is refused (23503)", async () => {
      await expect(insertBlackout(owner, "00000000-0000-7000-8000-000000000000", range(10, 11))).rejects.toMatchObject({ code: "23503" });
    });
  });

  it("the config version of a venue steps by one on every insert and update of its schedules and blackouts, as the owner and as dastar_app", async () => {
    const C = await seedVenue(owner);
    const during = (d: number) => `[2092-03-${String(d).padStart(2, "0")}T00:00:00Z,2092-03-${String(d + 1).padStart(2, "0")}T00:00:00Z)`;
    const steps = async (venueId: string, run: () => Promise<unknown>): Promise<number> => {
      const before = await configVersion(venueId);
      await run();
      return (await configVersion(venueId)) - before;
    };

    let sid = ""; let bid = "";
    expect(await steps(C.venue, async () => { sid = (await insertSchedule(owner, C.venue)).rows[0].id; })).toBe(1);
    expect(await steps(C.venue, () => owner.query("update dastar.schedule set gap_minutes = 30 where id = $1", [sid]))).toBe(1);
    expect(await steps(C.venue, async () => { bid = (await insertBlackout(owner, C.venue, during(1))).rows[0].id; })).toBe(1);
    expect(await steps(C.venue, () => owner.query("update dastar.blackout set reason = 'renovation' where id = $1", [bid]))).toBe(1);
    expect(await steps(C.venue, () => owner.query("update dastar.blackout set active = false where id = $1", [bid]))).toBe(1);

    expect(await steps(A.venue, async () => { sid = (await insertSchedule(app, A.venue)).rows[0].id; })).toBe(1);
    expect(await steps(A.venue, () => app.query("update dastar.schedule set gap_minutes = 30 where id = $1", [sid]))).toBe(1);
    expect(await steps(A.venue, async () => { bid = (await insertBlackout(app, A.venue, during(5))).rows[0].id; })).toBe(1);
    expect(await steps(A.venue, () => app.query("update dastar.blackout set reason = 'renovation' where id = $1", [bid]))).toBe(1);
    expect(await steps(A.venue, () => app.query("update dastar.blackout set active = false where id = $1", [bid]))).toBe(1);

    // another venue's version does not move
    const b0 = await configVersion(B.venue);
    await insertSchedule(app, A.venue);
    expect(await configVersion(B.venue)).toBe(b0);
  });

  it("dastar_app and dastar_worker cannot delete a schedule or a blackout, and the application role updates only the granted columns", async () => {
    const sid = (await insertSchedule(app, A.venue)).rows[0].id as string;
    const bid = (await insertBlackout(app, A.venue, "[2093-01-01T00:00:00Z,2093-01-02T00:00:00Z)")).rows[0].id as string;
    for (const [who, client] of [["dastar_app", app], ["dastar_worker", worker]] as const) {
      await expect(client.query("delete from dastar.schedule where id = $1", [sid]), `${who}: schedule`).rejects.toMatchObject({ code: "42501" });
      await expect(client.query("delete from dastar.blackout where id = $1", [bid]), `${who}: blackout`).rejects.toMatchObject({ code: "42501" });
    }
    expect((await owner.query("select count(*)::int as n from dastar.schedule where id = $1", [sid])).rows[0].n).toBe(1);
    expect((await owner.query("select count(*)::int as n from dastar.blackout where id = $1", [bid])).rows[0].n).toBe(1);

    // a blackout's range and a row's venue are fixed; the columns the grants name are not
    await expect(app.query("update dastar.blackout set during = '[2093-02-01T00:00:00Z,2093-02-02T00:00:00Z)' where id = $1", [bid])).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("update dastar.blackout set venue_id = $2 where id = $1", [bid, B.venue])).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("update dastar.schedule set venue_id = $2 where id = $1", [sid, B.venue])).rejects.toMatchObject({ code: "42501" });
    expect((await app.query("update dastar.blackout set reason = 'closed for a wedding', active = false where id = $1", [bid])).rowCount).toBe(1);
    expect((await app.query("update dastar.schedule set day_of_week = 6, opens = '12:00', closes = '15:00', closes_next_day = false, duration_by_size = '{\"2\":60}', gap_minutes = 0, active = false where id = $1", [sid])).rowCount).toBe(1);
  });

  it("venue_lock_key is stable and 64-bit, differs from the unit key of the same id, and differs between venues", async () => {
    const r = (await app.query(
      `select dastar.venue_lock_key($1::uuid) as v1, dastar.venue_lock_key($1::uuid) as v2,
              dastar.unit_lock_key($1::uuid) as u, dastar.venue_lock_key($2::uuid) as other`,
      [A.venue, B.venue],
    )).rows[0] as { v1: string; v2: string; u: string; other: string };
    expect(r.v1).toMatch(/^-?\d+$/);
    expect(BigInt(r.v1)).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(BigInt(r.v1)).toBeLessThan(2n ** 63n);
    expect(r.v2).toBe(r.v1);
    expect(r.u).not.toBe(r.v1);
    expect(r.other).not.toBe(r.v1);
  });

  // ---- the guards (migration 0020) ----

  /** A fresh day in 2060 for each scenario, so no reservation or blackout of another scenario is in its way. */
  const nextDay = (): number => ++dayN;
  const at = (day: number, hour: number, minute = 0): string => new Date(Date.UTC(2060, 0, day, hour, minute)).toISOString();
  /** 18:00 to 22:00 of the day; the default hold, 19:00 for 90 minutes, lies inside it. */
  const windowOf = (day: number): string => rangeLiteral(at(day, 18), 240);

  function input(seed: Seed, startsAt: string, over: Partial<HoldInput> = {}): HoldInput {
    n += 1;
    return {
      venueId: seed.venue, actor: `key:bk${n}`, traceId: `bk-t${n}`, idempotencyKey: `bk-k${n}`,
      partySize: 2, startsAt, durationMinutes: 90, assignment: { kind: "unit", id: seed.units[0]! }, ...over,
    };
  }
  /** One hold through the engine; a refusal fails the test with its code. */
  async function place(seed: Seed, startsAt: string, over: Partial<HoldInput> = {}): Promise<string> {
    const out = await hold(app, input(seed, startsAt, over));
    if (!out.ok) throw new Error(out.error.code);
    return out.receipt.reservationId;
  }
  const ctx = () => ({ actor: "key:desk", traceId: `bk-c${++n}`, venueId: A.venue });
  const COMBO = () => ({ partySize: 6, assignment: { kind: "combo", id: A.combos[0]!.id } }) as const;

  type Status = "held" | "confirmed" | "seated" | "completed" | "cancelled" | "expired";
  /** A hold made on a clock an hour in the past is already due; nothing sweeps it until `expireDue` runs. */
  async function dueHold(startsAt: string): Promise<string> {
    await setClock(app, new Date(Date.now() - 3_600_000).toISOString());
    return await place(A, startsAt).finally(() => setClock(app, null));
  }
  /** A reservation of venue A at `startsAt` whose stored status is `status`; the expired one is stored by the sweeper. */
  async function reservationIn(status: Status, startsAt: string): Promise<string> {
    if (status === "expired") {
      const id = await dueHold(startsAt);
      const swept = await expireDue(worker, { limit: 100 });
      if (!swept.expired.includes(id)) throw new Error("the sweeper did not expire the hold");
      return id;
    }
    const id = await place(A, startsAt);
    if (status === "held") return id;
    if (status === "cancelled") {
      await cancel(app, { reservationId: id, ...ctx(), reason: "guest" });
      return id;
    }
    await confirm(app, { reservationId: id, ...ctx() });
    if (status === "confirmed") return id;
    await seat(app, { reservationId: id, ...ctx() });
    if (status === "seated") return id;
    await complete(app, { reservationId: id, ...ctx() });
    return id;
  }
  const storedStatus = async (id: string): Promise<string> =>
    (await owner.query("select status from dastar.reservation where id = $1", [id])).rows[0].status as string;
  const blackoutsOver = async (venueId: string, range: string): Promise<number> =>
    (await owner.query("select count(*)::int as n from dastar.blackout where venue_id = $1 and during = $2::tstzrange", [venueId, range])).rows[0].n as number;
  const reservationsBy = async (actor: string): Promise<number> =>
    (await owner.query("select count(*)::int as n from dastar.reservation where created_by = $1", [actor])).rows[0].n as number;
  const advisoryHeld = async (appName: string, mode: "ExclusiveLock" | "ShareLock"): Promise<number> =>
    (await owner.query(
      `select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid = l.pid
        where a.datname = current_database() and a.application_name = $1 and l.locktype = 'advisory' and l.granted and l.mode = $2`,
      [appName, mode],
    )).rows[0].n as number;

  const BLACKED_OUT = "reservation range overlaps an active blackout of the venue";
  const STRANDS = "blackout would strand a live reservation";

  describe("guard at insert (DA009)", () => {
    it("a hold inside an active blackout returns the stored blackout outcome, the same key replays it, and nothing is reserved", async () => {
      const day = nextDay();
      await insertBlackout(owner, A.venue, windowOf(day), "private event");
      const i = input(A, at(day, 19));
      expect(await hold(app, i)).toMatchObject({ ok: false, error: { code: "blackout", message: BLACKED_OUT }, replayed: false });
      expect(await hold(app, i)).toMatchObject({ ok: false, error: { code: "blackout", message: BLACKED_OUT }, replayed: true });
      expect(await reservationsBy(i.actor)).toBe(0);
      const rows = await owner.query("select count(*)::int as n from dastar.reservation_unit where venue_id = $1 and during && $2::tstzrange", [A.venue, windowOf(day)]);
      expect(rows.rows[0].n).toBe(0);
      const stored = await owner.query("select response from dastar.idempotency where venue_id = $1 and actor = $2 and key = $3", [A.venue, i.actor, i.idempotencyKey]);
      expect(stored.rows[0].response).toMatchObject({ ok: false, error: { code: "blackout" } });
    });

    it("the stored outcome outlives the blackout: after it is deactivated, the same key still replays blackout, and a new key books the slot", async () => {
      const day = nextDay();
      const bid = (await insertBlackout(owner, A.venue, windowOf(day), "private event")).rows[0].id as string;
      const i = input(A, at(day, 19));
      expect(await hold(app, i)).toMatchObject({ ok: false, error: { code: "blackout" }, replayed: false });
      await owner.query("update dastar.blackout set active = false where id = $1", [bid]);
      expect(await hold(app, i)).toMatchObject({ ok: false, error: { code: "blackout" }, replayed: true });
      expect(await hold(app, input(A, at(day, 19)))).toMatchObject({ ok: true });
    });

    it("an inactive blackout, and one of another venue, do not block", async () => {
      const quiet = nextDay();
      await insertBlackout(owner, A.venue, windowOf(quiet), "lifted", false);
      expect(await hold(app, input(A, at(quiet, 19)))).toMatchObject({ ok: true });
      const elsewhere = nextDay();
      await insertBlackout(owner, B.venue, windowOf(elsewhere), "closed in B");
      expect(await hold(app, input(A, at(elsewhere, 19)))).toMatchObject({ ok: true });
      // and B itself is closed
      expect(await hold(app, input(B, at(elsewhere, 19)))).toMatchObject({ ok: false, error: { code: "blackout" } });
    });

    it("a hold that only touches a blackout's boundary succeeds, the half-open ranges do not overlap; one minute inside is refused", async () => {
      const day = nextDay();
      const closed = rangeLiteral(at(day, 19), 60); // [19:00, 20:00)
      await insertBlackout(owner, A.venue, closed, "closed for an hour");
      // [17:30, 19:00) ends where the blackout starts; [20:00, 21:00) starts where it ends
      expect(await hold(app, input(A, at(day, 17, 30)))).toMatchObject({ ok: true });
      expect(await hold(app, input(A, at(day, 20), { durationMinutes: 60 }))).toMatchObject({ ok: true });
      // a minute inside on either side, and the blackout's own range
      const other = { kind: "unit", id: A.units[1]! } as const;
      expect(await hold(app, input(A, at(day, 18), { durationMinutes: 61, assignment: other }))).toMatchObject({ ok: false, error: { code: "blackout" } });
      expect(await hold(app, input(A, at(day, 19, 59), { durationMinutes: 5, assignment: other }))).toMatchObject({ ok: false, error: { code: "blackout" } });
      expect(await hold(app, input(A, at(day, 19), { durationMinutes: 60, assignment: other }))).toMatchObject({ ok: false, error: { code: "blackout" } });
    });

    it("a combo hold is refused when a blackout covers it", async () => {
      const day = nextDay();
      await insertBlackout(owner, A.venue, windowOf(day), "closed");
      const i = input(A, at(day, 19), COMBO());
      expect(await hold(app, i)).toMatchObject({ ok: false, error: { code: "blackout" } });
      expect(await reservationsBy(i.actor)).toBe(0);
    });

    it("an insert that bypasses the hold takes the guard itself: DA009 naming the blackout", async () => {
      const day = nextDay();
      const bid = (await insertBlackout(owner, A.venue, windowOf(day), "closed")).rows[0].id as string;
      await app.query("select set_config('dastar.actor', 'key:direct', false)");
      try {
        const refused = await app.query(
          `insert into dastar.reservation(venue_id, party_size, during, status, assignment_kind, assignment_id, hold_expires_at, created_by)
           values ($1, 2, $2::tstzrange, 'held', 'unit', $3, dastar.dastar_now() + interval '10 minutes', 'key:direct')`,
          [A.venue, rangeLiteral(at(day, 19), 90), A.units[0]],
        ).then(() => null, (e: unknown) => e);
        expect(refused).toMatchObject({ code: "DA009", message: BLACKED_OUT, detail: `blackout=${bid}`, hint: "invariant 11 blackout" });
        expect(mapPgError(refused)).toMatchObject({ code: "blackout", retryable: false, sqlstate: "DA009" });
        expect(await reservationsBy("key:direct")).toBe(0);
      } finally {
        await app.query("select set_config('dastar.actor', '', false)");
      }
    });
  });

  describe("guard at write (DA014)", () => {
    it("a blackout over a held, a confirmed, a seated, or a combo reservation is refused, and no blackout is stored", async () => {
      for (const status of ["held", "confirmed", "seated"] as const) {
        const day = nextDay();
        const id = await reservationIn(status, at(day, 19));
        const refused = await insertBlackout(app, A.venue, windowOf(day)).then(() => null, (e: unknown) => e);
        expect(refused, status).toMatchObject({ code: "DA014", message: STRANDS, detail: `reservation=${id}`, hint: "invariant 11 blackout_conflict" });
        expect(mapPgError(refused), status).toMatchObject({ code: "blackout_conflict", retryable: false, sqlstate: "DA014" });
        expect(await blackoutsOver(A.venue, windowOf(day)), status).toBe(0);
        expect(await storedStatus(id), status).toBe(status);
      }
      const day = nextDay();
      const combo = await place(A, at(day, 19), COMBO());
      await expect(insertBlackout(app, A.venue, windowOf(day))).rejects.toMatchObject({ code: "DA014", detail: `reservation=${combo}` });
      expect(await blackoutsOver(A.venue, windowOf(day))).toBe(0);
    });

    it("a blackout that only touches a live reservation's boundary is allowed", async () => {
      const day = nextDay();
      await place(A, at(day, 19)); // [19:00, 20:30)
      await insertBlackout(app, A.venue, rangeLiteral(at(day, 20, 30), 120)); // starts where the reservation ends
      await insertBlackout(app, A.venue, rangeLiteral(at(day, 17), 120)); // ends where it starts
      await expect(insertBlackout(app, A.venue, rangeLiteral(at(day, 20, 29), 60))).rejects.toMatchObject({ code: "DA014" });
    });

    it("a blackout over a cancelled, an expired, a completed, or an unswept expired hold is allowed", async () => {
      for (const status of ["cancelled", "expired", "completed"] as const) {
        const day = nextDay();
        const id = await reservationIn(status, at(day, 19));
        if (status === "completed") {
          // a completed reservation keeps its unit rows active, so only its status lets the blackout through
          const rows = await owner.query("select active from dastar.reservation_unit where reservation_id = $1", [id]);
          expect(rows.rows).toEqual([{ active: true }]);
        }
        await insertBlackout(app, A.venue, windowOf(day));
        expect(await blackoutsOver(A.venue, windowOf(day)), status).toBe(1);
        expect(await storedStatus(id), status).toBe(status);
      }
      const day = nextDay();
      const id = await dueHold(at(day, 19));
      // past its expiry and not swept: the stored status is still held, the effective status is expired
      expect(await storedStatus(id)).toBe("held");
      await insertBlackout(app, A.venue, windowOf(day));
      expect(await blackoutsOver(A.venue, windowOf(day))).toBe(1);
      expect(await storedStatus(id)).toBe("held");
    });

    it("a hold is judged expired by the clock of the write, not by the clock it was made on", async () => {
      const day = nextDay();
      const id = await place(A, at(day, 19));
      await setClock(app, new Date(Date.now() + 3_600_000).toISOString());
      try {
        await insertBlackout(app, A.venue, windowOf(day));
      } finally {
        await setClock(app, null);
      }
      expect(await blackoutsOver(A.venue, windowOf(day))).toBe(1);
      expect(await storedStatus(id)).toBe("held");
    });

    it("deactivating and reactivating follow the same rule, and a reason-only update never judges", async () => {
      const day = nextDay();
      const range = windowOf(day);
      const bid = (await insertBlackout(app, A.venue, range, "closed")).rows[0].id as string;
      const active = async () => (await owner.query("select active from dastar.blackout where id = $1", [bid])).rows[0].active as boolean;

      expect((await app.query("update dastar.blackout set reason = 'closed for the night' where id = $1", [bid])).rowCount).toBe(1);
      expect((await app.query("update dastar.blackout set active = false where id = $1", [bid])).rowCount).toBe(1);
      expect(await active()).toBe(false);

      const id = await place(A, at(day, 19)); // allowed now that the blackout is off
      await expect(app.query("update dastar.blackout set active = true where id = $1", [bid])).rejects.toMatchObject({ code: "DA014", message: STRANDS, detail: `reservation=${id}` });
      expect(await active()).toBe(false);
      // a reason on an inactive blackout is not an activation
      expect((await app.query("update dastar.blackout set reason = 'still off' where id = $1", [bid])).rowCount).toBe(1);

      await cancel(app, { reservationId: id, ...ctx(), reason: "guest" });
      expect((await app.query("update dastar.blackout set active = true where id = $1", [bid])).rowCount).toBe(1);
      expect(await active()).toBe(true);
      // and it blocks holds again
      expect(await hold(app, input(A, at(day, 19)))).toMatchObject({ ok: false, error: { code: "blackout" } });
    });

    it("an inactive blackout may be written over a live reservation; activating it is what is refused", async () => {
      const day = nextDay();
      const id = await place(A, at(day, 19));
      const bid = (await insertBlackout(app, A.venue, windowOf(day), "planned", false)).rows[0].id as string;
      await expect(app.query("update dastar.blackout set active = true where id = $1", [bid])).rejects.toMatchObject({ code: "DA014", detail: `reservation=${id}` });
      await confirm(app, { reservationId: id, ...ctx() });
      await expect(app.query("update dastar.blackout set active = true where id = $1", [bid])).rejects.toMatchObject({ code: "DA014", detail: `reservation=${id}` });
    });

    it("a deactivation and a reason-only update take the venue lock exclusively, though they judge nothing", async () => {
      const day = nextDay();
      const bid = (await insertBlackout(app, A.venue, windowOf(day), "closed")).rows[0].id as string;
      for (const set of ["reason = 'closed for the night'", "active = false"]) {
        await W.query("begin");
        try {
          expect((await W.query(`update dastar.blackout set ${set} where id = $1`, [bid])).rowCount, set).toBe(1);
          expect(await advisoryHeld("bk-W", "ExclusiveLock"), set).toBe(1);
        } finally {
          await W.query("rollback");
        }
        expect(await advisoryHeld("bk-W", "ExclusiveLock"), set).toBe(0);
      }
    });

    it("the owner moving an active blackout's range onto a live reservation, or the blackout onto another venue with a live reservation in range, is refused (DA014)", async () => {
      const d1 = nextDay(); const d2 = nextDay(); const d3 = nextDay();
      const idA = await place(A, at(d1, 19));
      const moving = (await insertBlackout(owner, A.venue, windowOf(d2))).rows[0].id as string;
      await expect(owner.query("update dastar.blackout set during = $2::tstzrange where id = $1", [moving, windowOf(d1)]))
        .rejects.toMatchObject({ code: "DA014", message: STRANDS, detail: `reservation=${idA}` });

      const idB = await place(B, at(d3, 19));
      const crossing = (await insertBlackout(owner, A.venue, windowOf(d3))).rows[0].id as string;
      await expect(owner.query("update dastar.blackout set venue_id = $2 where id = $1", [crossing, B.venue]))
        .rejects.toMatchObject({ code: "DA014", message: STRANDS, detail: `reservation=${idB}` });

      const unchanged = async (id: string, venueId: string, range: string): Promise<boolean> =>
        (await owner.query("select venue_id = $2 and during = $3::tstzrange as same from dastar.blackout where id = $1", [id, venueId, range])).rows[0].same as boolean;
      expect(await unchanged(moving, A.venue, windowOf(d2))).toBe(true);
      expect(await unchanged(crossing, A.venue, windowOf(d3))).toBe(true);
    });

    it("dastar_worker, which bypasses row-level security, is still guarded: its blackout over a live reservation is refused (DA014)", async () => {
      const day = nextDay();
      const id = await place(A, at(day, 19));
      await expect(insertBlackout(worker, A.venue, windowOf(day))).rejects.toMatchObject({ code: "DA014", detail: `reservation=${id}` });
      expect(await blackoutsOver(A.venue, windowOf(day))).toBe(0);
    });

    it("bound to venue A, a blackout written for venue B is refused by B's guard when B has a live reservation in range (DA014), and by row-level security otherwise (42501): the guards fire before the policy checks the new row", async () => {
      const d1 = nextDay(); const d2 = nextDay();
      await place(B, at(d1, 19));
      await expect(insertBlackout(app, B.venue, windowOf(d1))).rejects.toMatchObject({ code: "DA014" });
      await expect(insertBlackout(app, B.venue, windowOf(d2))).rejects.toMatchObject({ code: "42501" });
      expect(await blackoutsOver(B.venue, windowOf(d1))).toBe(0);
      expect(await blackoutsOver(B.venue, windowOf(d2))).toBe(0);
    });

    it("another venue's reservations do not count", async () => {
      const day = nextDay();
      await place(B, at(day, 19));
      await insertBlackout(app, A.venue, windowOf(day));
      expect(await blackoutsOver(A.venue, windowOf(day))).toBe(1);
      // the same blackout in B is refused
      await expect(insertBlackout(owner, B.venue, windowOf(day))).rejects.toMatchObject({ code: "DA014" });
    });
  });

  describe("guard at confirmation (DA009)", () => {
    /** A live hold at 19:00 of a fresh day, and an active blackout over the day's window that a write on a clock an hour ahead admits over it. */
    async function holdUnderLaterBlackout(): Promise<{ id: string; bid: string; day: number }> {
      const day = nextDay();
      const id = await place(A, at(day, 19));
      await setClock(app, new Date(Date.now() + 3_600_000).toISOString());
      try {
        const bid = (await insertBlackout(app, A.venue, windowOf(day))).rows[0].id as string;
        return { id, bid, day };
      } finally {
        await setClock(app, null);
      }
    }

    it("a hold that a blackout write judged expired by its later clock cannot be confirmed into the blackout: refused as blackout, and the hold stays held", async () => {
      const { id, bid } = await holdUnderLaterBlackout();
      await expect(confirm(app, { reservationId: id, ...ctx() })).rejects.toMatchObject({ code: "blackout" });
      expect(await storedStatus(id)).toBe("held");

      // the raw transition takes the guard itself
      await app.query("select set_config('dastar.actor', 'key:direct', false)");
      try {
        const refused = await app.query("update dastar.reservation set status = 'confirmed' where id = $1", [id]).then(() => null, (e: unknown) => e);
        expect(refused).toMatchObject({ code: "DA009", message: BLACKED_OUT, detail: `blackout=${bid}` });
        expect(await storedStatus(id)).toBe("held");
      } finally {
        await app.query("select set_config('dastar.actor', '', false)");
      }
    });

    it("every other status change on such a hold is not judged: it can be cancelled", async () => {
      const { id } = await holdUnderLaterBlackout();
      await cancel(app, { reservationId: id, ...ctx(), reason: "guest" });
      expect(await storedStatus(id)).toBe("cancelled");
    });
  });

  describe("two connections on the venue lock", () => {
    const settled = <T>(o: Outcome<T>): T => {
      if (!o.ok) throw o.error instanceof Error ? o.error : new Error(String(o.error));
      return o.value;
    };

    it("(a) a blackout insert queues behind a hold that holds the venue lock, then is refused: it sees the hold's reservation", async () => {
      const day = nextDay();
      const i = input(A, at(day, 19));
      const p = pause();
      const pHold = outcome(hold(H, i, { beforeUnitLocks: p.hook }));
      try {
        await p.reached;
        expect(await advisoryHeld("bk-H", "ShareLock")).toBe(1);
        const pBlackout = outcome(insertBlackout(W, A.venue, windowOf(day)));
        await waitForBackend(owner, "bk-W", { type: "Lock", event: "advisory" });
        p.release();
        const out = settled(await pHold);
        expect(out).toMatchObject({ ok: true, replayed: false });
        const reservationId = (out as { receipt: { reservationId: string } }).receipt.reservationId;
        const b = await pBlackout;
        expect(b).toMatchObject({ ok: false, error: { code: "DA014", detail: `reservation=${reservationId}` } });
        expect(await blackoutsOver(A.venue, windowOf(day))).toBe(0);
        expect(await storedStatus(reservationId)).toBe("held");
      } finally {
        p.release();
      }
    });

    it("(b) a hold queues behind a blackout inserted in an open transaction, then returns the stored blackout outcome", async () => {
      const day = nextDay();
      const i = input(A, at(day, 19));
      await W.query("begin");
      let pHold!: Promise<Outcome<HoldOutcome>>;
      try {
        await insertBlackout(W, A.venue, windowOf(day), "private event");
        expect(await advisoryHeld("bk-W", "ExclusiveLock")).toBe(1);
        pHold = outcome(hold(H, i));
        await waitForBackend(owner, "bk-H", { type: "Lock", event: "advisory" });
        await W.query("commit");
      } catch (e) {
        await W.query("rollback").catch(() => undefined);
        throw e;
      }
      expect(settled(await pHold)).toMatchObject({ ok: false, error: { code: "blackout", message: BLACKED_OUT }, replayed: false });
      expect(await reservationsBy(i.actor)).toBe(0);
      expect(await blackoutsOver(A.venue, windowOf(day))).toBe(1);
      expect(await hold(H, i)).toMatchObject({ ok: false, error: { code: "blackout" }, replayed: true });
    });

    it("(b2) a hold that queues behind a blackout write that is rolled back books the slot", async () => {
      const day = nextDay();
      await W.query("begin");
      let pHold!: Promise<Outcome<HoldOutcome>>;
      try {
        await insertBlackout(W, A.venue, windowOf(day), "mistake");
        pHold = outcome(hold(H, input(A, at(day, 19))));
        await waitForBackend(owner, "bk-H", { type: "Lock", event: "advisory" });
        await W.query("rollback");
      } catch (e) {
        await W.query("rollback").catch(() => undefined);
        throw e;
      }
      expect(settled(await pHold)).toMatchObject({ ok: true });
      expect(await blackoutsOver(A.venue, windowOf(day))).toBe(0);
    });

    it("(c) a hold paused holding its venue and unit locks, and a blackout write waiting on the venue lock: both finish, with no deadlock and no retry", async () => {
      const before = await deadlockCountStable(owner);
      const day = nextDay();
      const i = input(A, at(day, 19));
      const p = pause();
      const retries: string[] = [];
      const pHold = outcome(hold(H, i, { afterUnitLocks: p.hook, onRetry: (r) => { retries.push(r.sqlstate); } }));
      try {
        await p.reached;
        // the hold holds both kinds of lock: the venue's, shared, and the unit's, exclusive
        expect(await advisoryHeld("bk-H", "ShareLock")).toBe(1);
        expect(await advisoryHeld("bk-H", "ExclusiveLock")).toBe(1);
        const pBlackout = outcome(insertBlackout(W, A.venue, windowOf(day)));
        await waitForBackend(owner, "bk-W", { type: "Lock", event: "advisory" });
        p.release();
        const out = settled(await pHold);
        expect(out).toMatchObject({ ok: true });
        const reservationId = (out as { receipt: { reservationId: string } }).receipt.reservationId;
        const b = await pBlackout;
        expect(b).toMatchObject({ ok: false, error: { code: "DA014", detail: `reservation=${reservationId}` } });
        expect(retries).toEqual([]);
      } finally {
        p.release();
      }
      // nothing is left held, and a blackout elsewhere in time goes through
      expect(await advisoryHeld("bk-H", "ShareLock") + await advisoryHeld("bk-H", "ExclusiveLock")).toBe(0);
      expect(await advisoryHeld("bk-W", "ExclusiveLock")).toBe(0);
      await insertBlackout(W, A.venue, windowOf(nextDay()));
      expect(await deadlockCountStable(owner)).toBe(before);
    });

    it("(d) holds do not block each other on the venue lock: a second hold on another unit passes while the first holds it", async () => {
      const day = nextDay();
      const p = pause();
      const pFirst = outcome(hold(H, input(A, at(day, 19)), { beforeUnitLocks: p.hook }));
      try {
        await p.reached;
        // the first hold has the venue lock shared and has taken no unit lock; the second needs only the shared lock and its own unit
        const second = await hold(app, input(A, at(day, 19), { assignment: { kind: "unit", id: A.units[1]! } }));
        expect(second).toMatchObject({ ok: true });
        p.release();
        expect(settled(await pFirst)).toMatchObject({ ok: true });
      } finally {
        p.release();
      }
    });

    it("(e) a blackout write on a clock past the hold's expiry queues behind a confirmation holding the venue lock, then is refused: it sees the confirmed reservation", async () => {
      const day = nextDay();
      const id = await place(A, at(day, 19));
      const p = pause();
      const pConfirm = outcome(confirm(H, { reservationId: id, ...ctx() }, { afterUnitLocks: p.hook }));
      try {
        await p.reached;
        // the confirmation holds the venue lock, shared, and the unit's lock, exclusive
        expect(await advisoryHeld("bk-H", "ShareLock")).toBe(1);
        expect(await advisoryHeld("bk-H", "ExclusiveLock")).toBe(1);
        // W judges the hold expired, so only the venue lock stands between it and the blackout
        await setClock(W, new Date(Date.now() + 3_600_000).toISOString());
        const pBlackout = outcome(insertBlackout(W, A.venue, windowOf(day)));
        await waitForBackend(owner, "bk-W", { type: "Lock", event: "advisory" });
        p.release();
        expect(settled(await pConfirm)).toMatchObject({ reservationId: id, status: "confirmed" });
        expect(await pBlackout).toMatchObject({ ok: false, error: { code: "DA014", detail: `reservation=${id}` } });
        expect(await blackoutsOver(A.venue, windowOf(day))).toBe(0);
        expect(await storedStatus(id)).toBe("confirmed");
      } finally {
        p.release();
        await setClock(W, null);
      }
    });

    it("(f) a confirmation that starts before the hold's expiry queues behind a blackout write that judged the hold expired, then is refused as blackout", async () => {
      const day = nextDay();
      const id = await place(A, at(day, 19));
      await W.query("begin");
      let pConfirm!: Promise<Outcome<Awaited<ReturnType<typeof confirm>>>>;
      try {
        await setClock(W, new Date(Date.now() + 3_600_000).toISOString());
        await insertBlackout(W, A.venue, windowOf(day), "private event");
        expect(await advisoryHeld("bk-W", "ExclusiveLock")).toBe(1);
        pConfirm = outcome(confirm(H, { reservationId: id, ...ctx() }));
        await waitForBackend(owner, "bk-H", { type: "Lock", event: "advisory" });
        await W.query("commit");
      } catch (e) {
        await W.query("rollback").catch(() => undefined);
        throw e;
      } finally {
        await setClock(W, null);
      }
      expect(await pConfirm).toMatchObject({ ok: false, error: { code: "blackout" } });
      expect(await storedStatus(id)).toBe("held");
      expect(await blackoutsOver(A.venue, windowOf(day))).toBe(1);
    });

    it("(g) an insert that bypasses the hold queues on the guard's own shared lock behind a blackout write, then is refused (DA009)", async () => {
      const day = nextDay();
      const actor = `key:direct${++n}`;
      await W.query("begin");
      let pInsert!: Promise<Outcome<unknown>>;
      let bid = "";
      try {
        bid = (await insertBlackout(W, A.venue, windowOf(day), "closed")).rows[0].id as string;
        await H.query("select set_config('dastar.venue_id', $1, false), set_config('dastar.actor', $2, false)", [A.venue, actor]);
        // no unit lock is held by anyone and t35 fires before t40, so the advisory wait is the guard's venue lock
        pInsert = outcome(H.query(
          `insert into dastar.reservation(venue_id, party_size, during, status, assignment_kind, assignment_id, hold_expires_at, created_by)
           values ($1, 2, $2::tstzrange, 'held', 'unit', $3, dastar.dastar_now() + interval '10 minutes', $4)`,
          [A.venue, rangeLiteral(at(day, 19), 90), A.units[0], actor],
        ));
        await waitForBackend(owner, "bk-H", { type: "Lock", event: "advisory" });
        await W.query("commit");
      } catch (e) {
        await W.query("rollback").catch(() => undefined);
        throw e;
      } finally {
        if (pInsert) await pInsert;
        await H.query("select set_config('dastar.venue_id', '', false), set_config('dastar.actor', '', false)");
      }
      expect(await pInsert).toMatchObject({ ok: false, error: { code: "DA009", detail: `blackout=${bid}` } });
      expect(await reservationsBy(actor)).toBe(0);
    });
  });
});

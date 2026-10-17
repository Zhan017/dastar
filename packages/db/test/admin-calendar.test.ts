import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool, type Client } from "pg";
import { BOUNDS } from "@dastar/core";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { setClock } from "./helpers/clock.js";
import { seedVenue, type Seed } from "./helpers/seed.js";
import { connectAs, waitForBackend, deadlockCountStable, pause, outcome, type Outcome } from "./helpers/wait.js";
import { hold, type HoldInput, type HoldOutcome } from "../src/commands/hold.js";
import { confirm } from "../src/commands/confirm.js";
import { cancel } from "../src/commands/cancel.js";
import { seat, complete } from "../src/commands/seat.js";
import type { AdminContext, AdminOutcome } from "../src/commands/admin.js";
import {
  createSchedule, updateSchedule, listSchedules, createBlackout, updateBlackout, listBlackouts,
  type BlackoutView, type CreateBlackoutInput, type CreateScheduleInput, type UpdateScheduleInput,
} from "../src/commands/admin-calendar.js";
import { createDastar } from "../src/handle.js";

describe("admin commands: schedules and blackouts", () => {
  let conn: Conn; let owner: Client; let app: Client; let H: Client; let W: Client;
  let n = 0; let dayN = 0;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const ABSENT = "00000000-0000-7000-8000-000000000001";

  beforeAll(async () => {
    conn = await cloneDatabase("admin_calendar_test");
    owner = await connect(conn.owner);
    app = await connect(conn.app);
    H = await connectAs(conn.app, "ac-H");
    W = await connectAs(conn.app, "ac-W");
  });
  afterAll(async () => {
    await W.end(); await H.end(); await app.end(); await owner.end();
    await dropDatabase("admin_calendar_test");
  });

  /** A venue of its own for each scenario, so no reservation or blackout of another scenario is in its way. */
  const fresh = (): Promise<Seed> => seedVenue(owner);
  /** A fresh day in 2062 for each scenario. */
  const nextDay = (): number => ++dayN;
  const at = (day: number, hour: number, minute = 0): string => new Date(Date.UTC(2062, 0, day, hour, minute)).toISOString();
  /** The instant `at(day, hour)` written with a UTC offset of `offsetHours`, as a caller in another zone would send it. */
  const written = (day: number, hour: number, offsetHours: number): string => {
    const local = new Date(Date.UTC(2062, 0, day, hour) + offsetHours * 3_600_000).toISOString().slice(0, 19);
    return `${local}${offsetHours < 0 ? "-" : "+"}${String(Math.abs(offsetHours)).padStart(2, "0")}:00`;
  };
  /** Runs `fn` with the connection's clock `ms` ahead of the real one, and resets it. */
  async function clockAhead<T>(ms: number, fn: () => Promise<T>): Promise<T> {
    await setClock(app, new Date(Date.now() + ms).toISOString());
    try { return await fn(); } finally { await setClock(app, null); }
  }

  /** The context of an admin write, with a trace id of its own. */
  const ctx = (seed: Seed): AdminContext => ({ venueId: seed.venue, actor: "key:admin", traceId: `ac-c${++n}` });
  const desk = (seed: Seed) => ({ actor: "key:desk", traceId: `ac-d${++n}`, venueId: seed.venue });
  const COMBO = (seed: Seed) => ({ partySize: 6, assignment: { kind: "combo", id: seed.combos[0]!.id } }) as const;
  /** The hold's assignment: the i-th unit of the venue. */
  const onUnit = (seed: Seed, i: number): Partial<HoldInput> => ({ assignment: { kind: "unit", id: seed.units[i]! } });

  function input(seed: Seed, startsAt: string, over: Partial<HoldInput> = {}): HoldInput {
    n += 1;
    return {
      venueId: seed.venue, actor: `key:ac${n}`, traceId: `ac-t${n}`, idempotencyKey: `ac-k${n}`,
      partySize: 2, startsAt, durationMinutes: 90, assignment: { kind: "unit", id: seed.units[0]! }, ...over,
    };
  }
  /** One hold through the engine; a refusal fails the test with its code. */
  async function place(seed: Seed, startsAt: string, over: Partial<HoldInput> = {}): Promise<string> {
    const out = await hold(app, input(seed, startsAt, over));
    if (!out.ok) throw new Error(out.error.code);
    return out.receipt.reservationId;
  }
  async function confirmedAt(seed: Seed, startsAt: string, over: Partial<HoldInput> = {}): Promise<string> {
    const id = await place(seed, startsAt, over);
    await confirm(app, { reservationId: id, ...desk(seed) });
    return id;
  }
  async function seatedAt(seed: Seed, startsAt: string, over: Partial<HoldInput> = {}): Promise<string> {
    const id = await confirmedAt(seed, startsAt, over);
    await seat(app, { reservationId: id, ...desk(seed) });
    return id;
  }

  /** The outcome of a write that must refuse, narrowed to the refusal. */
  function refused<T>(out: AdminOutcome<T>): Extract<AdminOutcome<T>, { ok: false }> {
    if (out.ok) throw new Error(`expected a refusal, got ok with cancelled=[${out.cancelled.join(",")}]`);
    return out;
  }
  /** The outcome of a write that must succeed, narrowed to the success. */
  function accepted<T>(out: AdminOutcome<T>): Extract<AdminOutcome<T>, { ok: true }> {
    if (!out.ok) throw new Error(`expected ok, got ${out.error.code}: ${out.error.message}`);
    return out;
  }
  const settled = <T>(o: Outcome<T>): T => {
    if (!o.ok) throw o.error instanceof Error ? o.error : new Error(String(o.error));
    return o.value;
  };

  const storedRow = async (id: string) =>
    (await owner.query("select status, cancel_reason from dastar.reservation where id = $1", [id])).rows[0] as { status: string; cancel_reason: string | null };
  const cancelEvents = async (venueId: string, id: string): Promise<Record<string, unknown>[]> =>
    (await owner.query(
      "select payload from dastar.outbox where venue_id = $1 and topic = 'reservation.cancelled' and payload->>'reservation_id' = $2",
      [venueId, id],
    )).rows.map((r) => r.payload as Record<string, unknown>);
  const cancelEventCount = async (venueId: string): Promise<number> =>
    (await owner.query("select count(*)::int as n from dastar.outbox where venue_id = $1 and topic = 'reservation.cancelled'", [venueId])).rows[0].n as number;
  const configVersion = async (venueId: string): Promise<number> =>
    Number((await owner.query("select config_version from dastar.venue where id = $1", [venueId])).rows[0].config_version);
  const reservationsBy = async (actor: string): Promise<number> =>
    (await owner.query("select count(*)::int as n from dastar.reservation where created_by = $1", [actor])).rows[0].n as number;
  const advisoryHeld = async (appName: string, mode: "ExclusiveLock" | "ShareLock"): Promise<number> =>
    (await owner.query(
      `select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid = l.pid
        where a.datname = current_database() and a.application_name = $1 and l.locktype = 'advisory' and l.granted and l.mode = $2`,
      [appName, mode],
    )).rows[0].n as number;
  const scheduleRow = async (id: string) =>
    (await owner.query(
      "select venue_id, day_of_week, opens::text as opens, closes::text as closes, closes_next_day, duration_by_size, gap_minutes, active from dastar.schedule where id = $1",
      [id],
    )).rows[0] as Record<string, unknown>;
  const scheduleCount = async (venueId: string): Promise<number> =>
    (await owner.query("select count(*)::int as n from dastar.schedule where venue_id = $1", [venueId])).rows[0].n as number;
  const blackoutRows = async (venueId: string) =>
    (await owner.query(
      "select id, lower(during) as starts_at, upper(during) as ends_at, reason, active from dastar.blackout where venue_id = $1 order by lower(during), id",
      [venueId],
    )).rows as { id: string; starts_at: Date; ends_at: Date; reason: string; active: boolean }[];
  const blackoutCount = async (venueId: string): Promise<number> => (await blackoutRows(venueId)).length;
  const blackoutRow = async (id: string) =>
    (await owner.query("select venue_id, reason, active, lower(during) as starts_at, upper(during) as ends_at from dastar.blackout where id = $1", [id])).rows[0] as
      { venue_id: string; reason: string; active: boolean; starts_at: Date; ends_at: Date };

  /** A reservation the admin write cancelled: stored cancelled with the reason, one outbox event, one audit row written under the write's actor and trace. */
  async function expectCancelledByAdmin(seed: Seed, id: string, reason: string, c: AdminContext): Promise<void> {
    expect(await storedRow(id), id).toEqual({ status: "cancelled", cancel_reason: reason });
    const events = await cancelEvents(seed.venue, id);
    expect(events, id).toHaveLength(1);
    expect(events[0], id).toMatchObject({ reservation_id: id, venue_id: seed.venue, status: "cancelled" });
    const audit = (await owner.query("select actor, trace_id from dastar.audit_log where entity_id = $1 and action like 'update:%>cancelled'", [id])).rows;
    expect(audit, id).toEqual([{ actor: c.actor, trace_id: c.traceId }]);
  }
  /** A reservation the admin write left alone: its stored status is unchanged and nothing was published for it. */
  async function expectUntouched(seed: Seed, id: string, status: string): Promise<void> {
    expect(await storedRow(id), id).toEqual({ status, cancel_reason: null });
    expect(await cancelEvents(seed.venue, id), id).toEqual([]);
  }

  // ---- schedules ----

  const DURATIONS = { "2": 90, "4": 120 };
  const sched = (over: Partial<CreateScheduleInput> = {}): CreateScheduleInput =>
    ({ dayOfWeek: 5, opens: "17:00", closes: "23:00", durationBySize: DURATIONS, ...over });
  /** A schedule input with fields the type does not allow, as a caller that is not type-checked would send. */
  const sloppy = (over: Record<string, unknown>): CreateScheduleInput => ({ ...sched(), ...over }) as unknown as CreateScheduleInput;
  const sloppyUpdate = (scheduleId: string, over: Record<string, unknown>): UpdateScheduleInput => ({ scheduleId, ...over }) as unknown as UpdateScheduleInput;

  describe("schedules", () => {
    it("createSchedule computes closes_next_day from the times, returns HH:MM views with the defaults, and steps the config version once", async () => {
      const S = await fresh();
      const cases: [string, string, boolean][] = [
        ["22:00", "04:00", true],
        ["17:00", "23:00", false],
        ["00:00", "00:00", true],
        ["10:00", "10:00", true],
        ["23:59", "00:00", true],
        ["00:00", "23:59", false],
      ];
      for (const [opens, closes, nextDay] of cases) {
        const before = await configVersion(S.venue);
        const view = await createSchedule(app, ctx(S), sched({ opens, closes }));
        expect(view, `${opens}-${closes}`).toEqual({
          id: expect.stringMatching(UUID), dayOfWeek: 5, opens, closes, closesNextDay: nextDay,
          durationBySize: DURATIONS, gapMinutes: 0, active: true,
        });
        expect(await scheduleRow(view.id), `${opens}-${closes}`).toMatchObject({
          venue_id: S.venue, opens: `${opens}:00`, closes: `${closes}:00`, closes_next_day: nextDay, duration_by_size: DURATIONS, gap_minutes: 0, active: true,
        });
        expect(await configVersion(S.venue), `${opens}-${closes}`).toBe(before + 1);
      }
      expect(await scheduleCount(S.venue)).toBe(cases.length);

      // closes_next_day is never an input: a value supplied for it is ignored
      const supplied = await createSchedule(app, ctx(S), sloppy({ opens: "22:00", closes: "04:00", closesNextDay: false }));
      expect(supplied.closesNextDay).toBe(true);
      const other = await createSchedule(app, ctx(S), sloppy({ opens: "09:00", closes: "11:00", closesNextDay: true }));
      expect(other.closesNextDay).toBe(false);

      // explicit gap and activity
      const explicit = await createSchedule(app, ctx(S), sched({ dayOfWeek: 1, gapMinutes: 15, active: false, durationBySize: { "999": 720 } }));
      expect(explicit).toMatchObject({ dayOfWeek: 1, gapMinutes: 15, active: false, durationBySize: { "999": 720 } });
    });

    it("updateSchedule recomputes closes_next_day from the final times, so a change of closes or opens alone can flip it", async () => {
      const S = await fresh();
      const view = await createSchedule(app, ctx(S), sched({ gapMinutes: 15 }));
      const id = view.id;
      expect(view.closesNextDay).toBe(false);
      const steps: [string, Partial<CreateScheduleInput>, string, string, boolean][] = [
        ["closes after midnight", { closes: "02:00" }, "17:00", "02:00", true],
        ["closes back the same evening", { closes: "23:30" }, "17:00", "23:30", false],
        ["opens after it closes", { opens: "23:45" }, "23:45", "23:30", true],
        ["opens early", { opens: "09:00" }, "09:00", "23:30", false],
        ["both across midnight", { opens: "22:00", closes: "04:00" }, "22:00", "04:00", true],
        ["both within the day", { opens: "12:00", closes: "13:00" }, "12:00", "13:00", false],
        ["closes where it opens", { closes: "12:00" }, "12:00", "12:00", true],
      ];
      let version = await configVersion(S.venue);
      for (const [label, change, opens, closes, nextDay] of steps) {
        const out = await updateSchedule(app, ctx(S), { scheduleId: id, ...change });
        expect(out, label).toEqual({
          id, dayOfWeek: 5, opens, closes, closesNextDay: nextDay, durationBySize: DURATIONS, gapMinutes: 15, active: true,
        });
        expect(await scheduleRow(id), label).toMatchObject({ opens: `${opens}:00`, closes: `${closes}:00`, closes_next_day: nextDay, duration_by_size: DURATIONS, gap_minutes: 15 });
        expect(await configVersion(S.venue), label).toBe(version + 1);
        version += 1;
      }
      // fields left out keep their stored values; every field can change
      const all = await updateSchedule(app, ctx(S), { scheduleId: id, dayOfWeek: 2, durationBySize: { "6": 150 }, gapMinutes: 30, active: false });
      expect(all).toEqual({ id, dayOfWeek: 2, opens: "12:00", closes: "12:00", closesNextDay: true, durationBySize: { "6": 150 }, gapMinutes: 30, active: false });
      const back = await updateSchedule(app, ctx(S), { scheduleId: id, active: true });
      expect(back).toEqual({ ...all, active: true });
      // a stored time with seconds is kept when the other time changes
      await owner.query("update dastar.schedule set opens = '12:00:30', closes = '13:00:45', closes_next_day = false where id = $1", [id]);
      await updateSchedule(app, ctx(S), { scheduleId: id, gapMinutes: 0 });
      expect(await scheduleRow(id)).toMatchObject({ opens: "12:00:30", closes: "13:00:45", closes_next_day: false, gap_minutes: 0 });
    });

    // Fields the command refuses before it writes (a malformed value Postgres would answer with a non-CHECK error) and
    // fields the table's CHECK refuses; every one is `invalid_input`, and the CHECK ones carry the 23514 state.
    const BAD: [string, Record<string, unknown>, boolean][] = [
      ["day 0", { dayOfWeek: 0 }, false],
      ["day 8", { dayOfWeek: 8 }, false],
      ["a fractional day", { dayOfWeek: 1.5 }, false],
      ["a day given as text", { dayOfWeek: "5" }, false],
      ["no day", { dayOfWeek: undefined }, false],
      ["opens at 25:00", { opens: "25:00" }, false],
      ["opens without a leading zero", { opens: "9:00" }, false],
      ["opens with seconds", { opens: "17:00:00" }, false],
      ["opens as a word", { opens: "noon" }, false],
      ["opens empty", { opens: "" }, false],
      ["closes at 24:00", { closes: "24:00" }, false],
      ["no closes", { closes: undefined }, false],
      ["durations that are an array", { durationBySize: [90] }, false],
      ["durations that are an empty array", { durationBySize: [] }, false],
      ["durations that are text", { durationBySize: "90" }, false],
      ["durations that are null", { durationBySize: null }, false],
      ["no durations", { durationBySize: undefined }, false],
      ["durations with a NUL in a key", { durationBySize: { "2\u0000": 90 } }, false],
      ["durations with no key", { durationBySize: {} }, true],
      ["a key of 0", { durationBySize: { "0": 60 } }, true],
      ["a key of 1000", { durationBySize: { "1000": 60 } }, true],
      ["a key that is a word", { durationBySize: { two: 60 } }, true],
      ["a value of 4", { durationBySize: { "2": 4 } }, true],
      ["a value of 721", { durationBySize: { "2": 721 } }, true],
      ["a fractional value", { durationBySize: { "2": 90.5 } }, true],
      ["a value given as text", { durationBySize: { "2": "90" } }, true],
      ["a null value", { durationBySize: { "2": null } }, true],
      ["a gap of -1", { gapMinutes: -1 }, false],
      ["a gap of 721", { gapMinutes: 721 }, false],
      ["a fractional gap", { gapMinutes: 1.5 }, false],
      ["a gap that is not a number", { gapMinutes: Number.NaN }, false],
      ["a gap given as text", { gapMinutes: "15" }, false],
      ["a gap of null", { gapMinutes: null }, false],
      ["an activity given as text", { active: "yes" }, false],
      ["an activity of null", { active: null }, false],
    ];

    it("createSchedule refuses malformed, out-of-range, and mistyped fields as invalid_input, writes nothing, and leaves the connection usable", async () => {
      const S = await fresh();
      const version = await configVersion(S.venue);
      for (const [label, over, fromCheck] of BAD) {
        const refusal = await createSchedule(app, ctx(S), sloppy(over)).then(() => null, (e: unknown) => e);
        expect(refusal, label).toMatchObject({ name: "DastarError", code: "invalid_input", retryable: false });
        if (fromCheck) expect(refusal, label).toMatchObject({ sqlstate: "23514" });
      }
      expect(await scheduleCount(S.venue)).toBe(0);
      expect(await configVersion(S.venue)).toBe(version);
      // control: the same input without the fault is stored, so the refusals above were the faults'
      expect(await createSchedule(app, ctx(S), sched())).toMatchObject({ opens: "17:00" });
      expect(await scheduleCount(S.venue)).toBe(1);
    });

    it("updateSchedule refuses the same fields as invalid_input and changes nothing, even beside a valid change", async () => {
      const S = await fresh();
      const id = (await createSchedule(app, ctx(S), sched({ gapMinutes: 15 }))).id;
      const stored = await scheduleRow(id);
      const version = await configVersion(S.venue);
      for (const [label, over, fromCheck] of BAD) {
        // a field set to undefined is left out of an update, so only the faults that name a value are tried
        if (Object.values(over).every((v) => v === undefined)) continue;
        // a change that would be valid on its own rides along: it must not be written either
        const refusal = await updateSchedule(app, ctx(S), sloppyUpdate(id, { ...over, opens: over.opens ?? "08:00" })).then(() => null, (e: unknown) => e);
        expect(refusal, label).toMatchObject({ name: "DastarError", code: "invalid_input", retryable: false });
        if (fromCheck) expect(refusal, label).toMatchObject({ sqlstate: "23514" });
      }
      expect(await scheduleRow(id)).toEqual(stored);
      expect(await configVersion(S.venue)).toBe(version);
      // control: the valid change alone is written
      expect(await updateSchedule(app, ctx(S), { scheduleId: id, opens: "08:00" })).toMatchObject({ opens: "08:00" });
      expect(await scheduleRow(id)).toMatchObject({ opens: "08:00:00" });
    });

    it("listSchedules returns every schedule of the venue, inactive ones included, by day, opening time, and id, as HH:MM, and none of another venue", async () => {
      const S = await fresh(); const O = await fresh();
      const a = await createSchedule(app, ctx(S), sched({ dayOfWeek: 3, opens: "17:00", closes: "23:00" }));
      const b = await createSchedule(app, ctx(S), sched({ dayOfWeek: 1, opens: "18:00", closes: "23:00", gapMinutes: 10 }));
      const c = await createSchedule(app, ctx(S), sched({ dayOfWeek: 1, opens: "09:30", closes: "14:00", active: false }));
      const d = await createSchedule(app, ctx(S), sched({ dayOfWeek: 3, opens: "17:00", closes: "22:00" }));
      const e = await createSchedule(app, ctx(S), sched({ dayOfWeek: 7, opens: "00:00", closes: "00:00", durationBySize: { "999": 600 } }));
      await createSchedule(app, ctx(O), sched({ dayOfWeek: 2 }));

      const list = await listSchedules(app, S.venue);
      // a and d share a day and an opening time, so their ids order them
      const tied = [a, d].sort((x, y) => (x.id < y.id ? -1 : 1));
      expect(list).toEqual([c, b, ...tied, e]);
      expect(list.map((s) => `${s.dayOfWeek} ${s.opens}`)).toEqual(["1 09:30", "1 18:00", "3 17:00", "3 17:00", "7 00:00"]);
      expect(list.find((s) => s.id === c.id)).toMatchObject({ active: false, closes: "14:00", closesNextDay: false });
      expect(list.find((s) => s.id === e.id)).toMatchObject({ closesNextDay: true, durationBySize: { "999": 600 } });
      expect(await listSchedules(app, O.venue)).toHaveLength(1);
    });

    it("a schedule of another venue, or one that does not exist, is not_found, and the other venue's schedule is left as it was", async () => {
      const S = await fresh(); const O = await fresh();
      const theirs = (await createSchedule(app, ctx(O), sched())).id;
      const stored = await scheduleRow(theirs);
      const versions = [await configVersion(S.venue), await configVersion(O.venue)];
      for (const scheduleId of [theirs, ABSENT]) {
        await expect(updateSchedule(app, ctx(S), { scheduleId, opens: "08:00", active: false }))
          .rejects.toMatchObject({ name: "DastarError", code: "not_found", message: "schedule not found" });
      }
      expect(await scheduleRow(theirs)).toEqual(stored);
      expect([await configVersion(S.venue), await configVersion(O.venue)]).toEqual(versions);
      // control: the owning venue's own context updates it
      expect(await updateSchedule(app, ctx(O), { scheduleId: theirs, opens: "08:00" })).toMatchObject({ id: theirs, opens: "08:00" });
    });
  });

  // ---- blackouts ----

  /** A blackout over 18:00 to 22:00 of the day, with the default reservation (19:00 for 90 minutes) inside it. */
  const bo = (day: number, over: Partial<CreateBlackoutInput> = {}): CreateBlackoutInput =>
    ({ startsAt: at(day, 18), endsAt: at(day, 22), reason: "private event", ...over });
  const STRANDS = (count: number): string => `this blackout would strand ${count} live reservation${count === 1 ? "" : "s"}; cancel them or retry with force`;
  const CONFLICT = (ids: string[]) => ({ ok: false, error: { code: "blackout_conflict", message: STRANDS(ids.length) }, stranded: ids });

  describe("createBlackout", () => {
    it("without live reservations it stores the blackout, returns its view with UTC instants, cancels nothing, and steps the config version once", async () => {
      const S = await fresh(); const O = await fresh();
      const day = nextDay();
      const theirs = await place(O, at(day, 19));
      const before = await configVersion(S.venue);

      const out = accepted(await createBlackout(app, ctx(S), bo(day)));
      expect(out.cancelled).toEqual([]);
      expect(out.value).toEqual({ id: expect.stringMatching(UUID), startsAt: at(day, 18), endsAt: at(day, 22), reason: "private event", active: true });
      expect(await blackoutRow(out.value.id)).toMatchObject({ venue_id: S.venue, reason: "private event", active: true, starts_at: new Date(at(day, 18)), ends_at: new Date(at(day, 22)) });
      expect(await configVersion(S.venue)).toBe(before + 1);
      // another venue's reservation over the same range is not stranded, and is left alone
      await expectUntouched(O, theirs, "held");

      // instants given with an offset are stored as the same instants in UTC
      const day2 = nextDay();
      const offset = accepted(await createBlackout(app, ctx(S), { startsAt: written(day2, 18, 2), endsAt: written(day2, 19, -5), reason: "offset" }));
      expect(written(day2, 18, 2)).toMatch(/T20:00:00\+02:00$/);
      expect(offset.value).toMatchObject({ startsAt: at(day2, 18), endsAt: at(day2, 19) });

      // an inactive blackout is stored inactive
      const off = accepted(await createBlackout(app, ctx(S), bo(nextDay(), { active: false })));
      expect(off.value.active).toBe(false);
      expect((await blackoutRow(off.value.id)).active).toBe(false);
    });

    it("a live reservation over the range, held, confirmed, seated, or of a combination, refuses it as blackout_conflict naming the reservation, and no blackout is stored", async () => {
      for (const make of [place, confirmedAt, seatedAt]) {
        const S = await fresh(); const day = nextDay();
        const id = await make(S, at(day, 19));
        const status = (await storedRow(id)).status;
        expect(refused(await createBlackout(app, ctx(S), bo(day))), status).toEqual(CONFLICT([id]));
        expect(await blackoutCount(S.venue), status).toBe(0);
        await expectUntouched(S, id, status);
      }
      const S = await fresh(); const day = nextDay();
      const comboRes = await place(S, at(day, 19), COMBO(S));
      expect(refused(await createBlackout(app, ctx(S), bo(day)))).toEqual(CONFLICT([comboRes]));
      expect(await blackoutCount(S.venue)).toBe(0);
      await expectUntouched(S, comboRes, "held");
      expect(await cancelEventCount(S.venue)).toBe(0);
    });

    it("only live reservations that overlap the range are stranded, read in start order: boundaries, cancelled, and completed ones are not, and a forced blackout cancels exactly the stranded", async () => {
      const S = await fresh(); const day = nextDay();
      const early = await place(S, at(day, 18, 30), onUnit(S, 0));
      const late = await confirmedAt(S, at(day, 20, 30), onUnit(S, 1));
      const before = await place(S, at(day, 15), onUnit(S, 4));
      const endsAtStart = await place(S, at(day, 16, 30), onUnit(S, 2));
      const startsAtEnd = await place(S, at(day, 22), onUnit(S, 3));
      const gone = await place(S, at(day, 19), onUnit(S, 5));
      await cancel(app, { reservationId: gone, ...desk(S), reason: "guest" });
      const done = await seatedAt(S, at(day, 21), onUnit(S, 0));
      await complete(app, { reservationId: done, ...desk(S) });
      expect(await cancelEventCount(S.venue)).toBe(1);

      expect(refused(await createBlackout(app, ctx(S), bo(day)))).toEqual(CONFLICT([early, late]));
      expect(await blackoutCount(S.venue)).toBe(0);

      const c = ctx(S);
      const out = accepted(await createBlackout(app, c, bo(day, { force: true })));
      expect(out.cancelled).toEqual([early, late].sort());
      for (const id of [early, late]) await expectCancelledByAdmin(S, id, "venue change", c);
      for (const id of [before, endsAtStart, startsAtEnd]) await expectUntouched(S, id, "held");
      expect(await storedRow(done)).toEqual({ status: "completed", cancel_reason: null });
      expect(await storedRow(gone)).toEqual({ status: "cancelled", cancel_reason: "guest" });
      // the guest cancel and the two forced ones
      expect(await cancelEventCount(S.venue)).toBe(3);
    });

    for (const reason of [undefined, "private event"]) {
      it(`with force it cancels the stranded held, confirmed, and seated reservations ${reason ? `with the reason "${reason}"` : "with the default reason"}, stores the blackout, and then blocks holds in the range`, async () => {
        const S = await fresh(); const O = await fresh(); const day = nextDay();
        const held = await place(S, at(day, 19), onUnit(S, 0));
        const conf = await confirmedAt(S, at(day, 19), onUnit(S, 1));
        const seated = await seatedAt(S, at(day, 19), onUnit(S, 2));
        const kept = await place(S, at(day, 22, 30), onUnit(S, 3));
        const theirs = await place(O, at(day, 19));
        const c = ctx(S);
        const version = await configVersion(S.venue);

        const out = accepted(await createBlackout(app, c, bo(day, { force: true, ...(reason ? { cancelReason: reason } : {}) })));
        expect(out.cancelled).toEqual([held, conf, seated].sort());
        for (const id of [held, conf, seated]) await expectCancelledByAdmin(S, id, reason ?? "venue change", c);
        await expectUntouched(S, kept, "held");
        await expectUntouched(O, theirs, "held");
        expect(await cancelEventCount(S.venue)).toBe(3);
        expect(await cancelEventCount(O.venue)).toBe(0);
        expect(await blackoutRow(out.value.id)).toMatchObject({ venue_id: S.venue, active: true, reason: "private event" });
        expect(await blackoutCount(S.venue)).toBe(1);
        expect(await configVersion(S.venue)).toBe(version + 1);
        expect(await hold(app, input(S, at(day, 19), onUnit(S, 4)))).toMatchObject({ ok: false, error: { code: "blackout" } });
      });
    }

    it("force refuses a started reservation as reservation_in_progress naming only the started ones, cancels nothing, stores nothing, and succeeds when none has started", async () => {
      const S = await fresh();
      const day = nextDay();
      // confirmed reservations: a hold whose start has passed by the moved clock is also past its expiry, so it is not live
      const first = await confirmedAt(S, at(day, 19));
      const second = await confirmedAt(S, at(day + 1, 19));
      const range = bo(day, { endsAt: at(day + 1, 22) });
      try {
        await setClock(app, at(day, 19, 1));
        // control: without force both are stranded, started or not
        expect(refused(await createBlackout(app, ctx(S), range))).toEqual(CONFLICT([first, second]));
        const forced = refused(await createBlackout(app, ctx(S), { ...range, force: true }));
        expect(forced).toEqual({
          ok: false,
          error: { code: "reservation_in_progress", message: "1 stranded reservation has already started; close it first" },
          stranded: [first],
        });
      } finally {
        await setClock(app, null);
      }
      await expectUntouched(S, first, "confirmed");
      await expectUntouched(S, second, "confirmed");
      expect(await blackoutCount(S.venue)).toBe(0);
      expect(await cancelEventCount(S.venue)).toBe(0);

      // by the real clock neither has started, so the same forced write cancels both
      const control = accepted(await createBlackout(app, ctx(S), { ...range, force: true }));
      expect(control.cancelled).toEqual([first, second].sort());
      expect(await blackoutCount(S.venue)).toBe(1);
    });

    it("an inactive blackout over live reservations is written without judgment, even with force, and cancels nothing", async () => {
      const S = await fresh(); const day = nextDay();
      const id = await place(S, at(day, 19));
      const out = accepted(await createBlackout(app, ctx(S), bo(day, { active: false, force: true })));
      expect(out.cancelled).toEqual([]);
      expect(out.value.active).toBe(false);
      await expectUntouched(S, id, "held");
      expect(await cancelEventCount(S.venue)).toBe(0);
      // control: the same range active is judged
      expect(refused(await createBlackout(app, ctx(S), bo(day))).stranded).toEqual([id]);
    });

    // Inputs refused before the transaction (a malformed instant or reason) and by the CHECK (an empty or long reason).
    // With force and a live reservation in range the write would cancel it first, so each case also shows the cancellation rolled back.
    it("an empty or reversed range, a malformed instant, and a reason that is empty, too long, or mistyped are invalid_input, and nothing is cancelled or stored, even with force", async () => {
      const S = await fresh(); const day = nextDay();
      const id = await place(S, at(day, 19));
      const version = await configVersion(S.venue);
      const cases: [string, Record<string, unknown>, boolean][] = [
        ["starts where it ends", { endsAt: at(day, 18) }, false],
        ["starts after it ends", { startsAt: at(day, 22), endsAt: at(day, 18) }, false],
        ["a start that is not a date", { startsAt: "soon" }, false],
        ["a start without a time", { startsAt: "2062-01-05" }, false],
        ["a start without an offset", { startsAt: "2062-01-05T18:00:00" }, false],
        ["a day that does not exist", { startsAt: "2062-02-30T18:00:00Z" }, false],
        ["year zero", { startsAt: "0000-01-01T00:00:00Z" }, false],
        ["no end", { endsAt: undefined }, false],
        ["an end that is a number", { endsAt: 1_000 }, false],
        ["an empty reason", { reason: "" }, true],
        ["a reason of 501 characters", { reason: "x".repeat(501) }, true],
        ["a reason with a NUL", { reason: "a\u0000b" }, false],
        ["a reason that is not text", { reason: 7 }, false],
        ["no reason", { reason: undefined }, false],
        ["an activity given as text", { active: "yes" }, false],
      ];
      for (const [label, over, fromCheck] of cases) {
        const refusal = await createBlackout(app, ctx(S), { ...bo(day), force: true, ...over } as unknown as CreateBlackoutInput).then(() => null, (e: unknown) => e);
        expect(refusal, label).toMatchObject({ name: "DastarError", code: "invalid_input", retryable: false });
        if (fromCheck) expect(refusal, label).toMatchObject({ sqlstate: "23514" });
      }
      expect(await blackoutCount(S.venue)).toBe(0);
      await expectUntouched(S, id, "held");
      expect(await cancelEventCount(S.venue)).toBe(0);
      expect(await configVersion(S.venue)).toBe(version);
      // control: a reason of 500 characters is accepted, so the refusals above were the faults'
      const longest = accepted(await createBlackout(app, ctx(S), bo(day, { reason: "x".repeat(500), force: true })));
      expect(longest.cancelled).toEqual([id]);
    });
  });

  describe("updateBlackout", () => {
    it("activating an inactive blackout is judged like a new active one: refused naming the live reservations in start order, then with force they are cancelled and it is activated", async () => {
      const S = await fresh(); const day = nextDay();
      const created = accepted(await createBlackout(app, ctx(S), bo(day, { active: false }))).value;
      const held = await place(S, at(day, 19), onUnit(S, 0));
      const conf = await confirmedAt(S, at(day, 19, 15), onUnit(S, 1));
      // the blackout is inactive, so a hold in its range is allowed
      const third = await place(S, at(day, 19, 30), onUnit(S, 2));
      const outside = await place(S, at(day, 23), onUnit(S, 3));

      expect(refused(await updateBlackout(app, ctx(S), { blackoutId: created.id, active: true }))).toEqual(CONFLICT([held, conf, third]));
      expect((await blackoutRow(created.id)).active).toBe(false);
      for (const [id, status] of [[held, "held"], [conf, "confirmed"], [third, "held"]] as const) await expectUntouched(S, id, status);
      expect(await cancelEventCount(S.venue)).toBe(0);

      const c = ctx(S);
      const out = accepted(await updateBlackout(app, c, { blackoutId: created.id, active: true, force: true, cancelReason: "closed" }));
      expect(out.cancelled).toEqual([held, conf, third].sort());
      expect(out.value).toEqual({ ...created, active: true });
      for (const id of [held, conf, third]) await expectCancelledByAdmin(S, id, "closed", c);
      await expectUntouched(S, outside, "held");
      expect((await blackoutRow(created.id)).active).toBe(true);
      expect(await hold(app, input(S, at(day, 19), onUnit(S, 4)))).toMatchObject({ ok: false, error: { code: "blackout" } });

      // deactivating is not judged; a reservation made while it is off is judged when it is activated again
      expect(accepted(await updateBlackout(app, ctx(S), { blackoutId: created.id, active: false, force: true })).cancelled).toEqual([]);
      const again = await place(S, at(day, 20), onUnit(S, 4));
      expect(refused(await updateBlackout(app, ctx(S), { blackoutId: created.id, active: true })).stranded).toEqual([again]);
      expect((await blackoutRow(created.id)).active).toBe(false);
      await cancel(app, { reservationId: again, ...desk(S), reason: "guest" });
      expect(accepted(await updateBlackout(app, ctx(S), { blackoutId: created.id, active: true })).cancelled).toEqual([]);
      expect((await blackoutRow(created.id)).active).toBe(true);
    });

    it("a started reservation refuses a forced activation as reservation_in_progress and cancels nothing", async () => {
      const S = await fresh(); const day = nextDay();
      const created = accepted(await createBlackout(app, ctx(S), bo(day, { active: false }))).value;
      const id = await confirmedAt(S, at(day, 19));
      try {
        await setClock(app, at(day, 19, 1));
        const out = refused(await updateBlackout(app, ctx(S), { blackoutId: created.id, active: true, force: true }));
        expect(out).toEqual({
          ok: false,
          error: { code: "reservation_in_progress", message: "1 stranded reservation has already started; close it first" },
          stranded: [id],
        });
      } finally {
        await setClock(app, null);
      }
      expect((await blackoutRow(created.id)).active).toBe(false);
      await expectUntouched(S, id, "confirmed");
    });

    it("a change of reason, or setting active on an active blackout, is never judged, though a live reservation lies in its range; only the reactivation is", async () => {
      const S = await fresh(); const day = nextDay();
      const id = await place(S, at(day, 19));
      // a blackout written on a clock an hour ahead judges the hold expired, so it is admitted over the hold; by the real clock the hold is live
      const created = await clockAhead(3_600_000, async () => {
        const out = accepted(await createBlackout(app, ctx(S), bo(day)));
        expect(out.cancelled).toEqual([]);
        return out.value;
      });
      await expectUntouched(S, id, "held");

      const renamed = accepted(await updateBlackout(app, ctx(S), { blackoutId: created.id, reason: "closed for a wedding", force: true }));
      expect(renamed.cancelled).toEqual([]);
      expect(renamed.value).toEqual({ ...created, reason: "closed for a wedding" });
      expect(accepted(await updateBlackout(app, ctx(S), { blackoutId: created.id, reason: "closed for the night" })).value.reason).toBe("closed for the night");
      expect(accepted(await updateBlackout(app, ctx(S), { blackoutId: created.id, active: true, force: true })).cancelled).toEqual([]);
      expect(await blackoutRow(created.id)).toMatchObject({ reason: "closed for the night", active: true });
      await expectUntouched(S, id, "held");

      // control: the reservation is live and in range, so reactivating the blackout is judged and names it
      expect(accepted(await updateBlackout(app, ctx(S), { blackoutId: created.id, active: false })).value.active).toBe(false);
      const off = accepted(await updateBlackout(app, ctx(S), { blackoutId: created.id, reason: "still off", force: true }));
      expect(off).toMatchObject({ cancelled: [], value: { reason: "still off", active: false } });
      expect(refused(await updateBlackout(app, ctx(S), { blackoutId: created.id, active: true })).stranded).toEqual([id]);
      await expectUntouched(S, id, "held");
      expect(await cancelEventCount(S.venue)).toBe(0);
    });

    it("a blackout of another venue, or one that does not exist, is not_found, and the other venue's blackout and reservations are left as they were", async () => {
      const S = await fresh(); const O = await fresh(); const day = nextDay();
      const theirs = accepted(await createBlackout(app, ctx(O), bo(day, { active: false }))).value;
      const theirRes = await place(O, at(day, 19));
      const notFound = { name: "DastarError", code: "not_found", message: "blackout not found" };
      for (const blackoutId of [theirs.id, ABSENT]) {
        await expect(updateBlackout(app, ctx(S), { blackoutId, reason: "Hijacked", active: true, force: true })).rejects.toMatchObject(notFound);
      }
      expect(await blackoutRow(theirs.id)).toMatchObject({ venue_id: O.venue, reason: "private event", active: false });
      await expectUntouched(O, theirRes, "held");
      expect(await cancelEventCount(O.venue)).toBe(0);
      // control: the owning venue's own context judges the activation
      expect(refused(await updateBlackout(app, ctx(O), { blackoutId: theirs.id, active: true })).stranded).toEqual([theirRes]);
    });
  });

  describe("listBlackouts", () => {
    it("returns the blackouts overlapping a half-open window, inactive ones included, by start and id, and none of another venue", async () => {
      const S = await fresh(); const O = await fresh(); const day = nextDay();
      const x1 = accepted(await createBlackout(app, ctx(S), { startsAt: at(day, 18), endsAt: at(day, 22), reason: "x1" })).value;
      const x2 = accepted(await createBlackout(app, ctx(S), { startsAt: at(day, 22), endsAt: at(day, 23), reason: "x2" })).value;
      const x3 = accepted(await createBlackout(app, ctx(S), { startsAt: at(day, 10), endsAt: at(day, 12), reason: "x3", active: false })).value;
      const x4 = accepted(await createBlackout(app, ctx(S), { startsAt: at(day + 2, 10), endsAt: at(day + 2, 12), reason: "x4" })).value;
      accepted(await createBlackout(app, ctx(O), { startsAt: at(day, 18), endsAt: at(day, 22), reason: "theirs" }));

      const list = (from: string, to: string) => listBlackouts(app, S.venue, { from, to });
      // the window's own range matches x1 exactly; x2 starts where the window ends and x3 ended long before
      expect(await list(at(day, 18), at(day, 22))).toEqual([x1]);
      // a minute of overlap on either side counts, in start order
      expect(await list(at(day, 11, 59), at(day, 18, 1))).toEqual([x3, x1]);
      // a window that ends where x1 starts, or starts where x3 ends, does not overlap either
      expect(await list(at(day, 12), at(day, 18))).toEqual([]);
      // everything of the venue, inactive and later ones included
      expect(await list(at(day - 1, 0), at(day + 5, 0))).toEqual([x3, x1, x2, x4]);
      expect(await listBlackouts(app, O.venue, { from: at(day - 1, 0), to: at(day + 5, 0) })).toHaveLength(1);
      // instants with an offset are taken as the instants they name
      expect(await list(written(day, 18, 2), written(day, 22, 1))).toEqual([x1]);
    });

    it("refuses an empty, reversed, or too long window and a malformed instant as invalid_input, and accepts exactly the longest window", async () => {
      const S = await fresh(); const day = nextDay();
      const inside = accepted(await createBlackout(app, ctx(S), bo(day))).value;
      const from = "2062-01-01T00:00:00Z";
      const plus = (ms: number): string => new Date(Date.parse(from) + ms).toISOString();
      const DAYS = BOUNDS.blackoutListing.windowDays * 86_400_000;
      expect(BOUNDS.blackoutListing.windowDays).toBe(400);

      const bad: [string, string, string][] = [
        ["an empty window", from, from],
        ["a reversed window", plus(1_000), from],
        ["a window a second over the limit", from, plus(DAYS + 1_000)],
        ["a window of 401 days", from, plus(DAYS + 86_400_000)],
        ["a start that is not a date", "yesterday", plus(1_000)],
        ["a start without a time", "2062-01-01", plus(1_000)],
        ["a start without an offset", "2062-01-01T10:00:00", plus(1_000)],
        ["a day that does not exist", "2062-02-30T10:00:00Z", plus(1_000)],
        ["an hour of 25", "2062-01-01T25:00:00Z", plus(1_000)],
        ["year zero", "0000-01-01T00:00:00Z", plus(1_000)],
        ["an empty start", "", plus(1_000)],
        ["an end that is not a date", from, "tomorrow"],
        ["no end", from, undefined as unknown as string],
        ["an end that is a number", from, 12_345 as unknown as string],
      ];
      for (const [label, f, t] of bad) {
        await expect(listBlackouts(app, S.venue, { from: f, to: t }), label).rejects.toMatchObject({ name: "DastarError", code: "invalid_input", retryable: false });
      }
      // controls: the connection is usable, and a window of exactly 400 days is accepted and finds the blackout
      const wide = await listBlackouts(app, S.venue, { from: at(day, 0), to: new Date(Date.parse(at(day, 0)) + DAYS).toISOString() });
      expect(wide).toEqual([inside]);
      expect(await listBlackouts(app, S.venue, { from, to: plus(1_000) })).toEqual([]);
    });

    it(`returns at most ${BOUNDS.blackoutListing.rows} rows, the earliest by start, and every row when fewer are in the window`, async () => {
      const R = await fresh();
      const base = at(nextDay(), 0);
      const LIMIT = BOUNDS.blackoutListing.rows;
      expect(LIMIT).toBe(500);
      // 501 blackouts half an hour long, an hour apart, every other one inactive; the owner inserts them in one statement
      const inserted = await owner.query(
        `insert into dastar.blackout (venue_id, during, reason, active)
         select $1::uuid, tstzrange($2::timestamptz + i * interval '1 hour', $2::timestamptz + i * interval '1 hour' + interval '30 minutes'), 'bulk ' || i, i % 2 = 0
           from generate_series(0, ${LIMIT}) i`,
        [R.venue, base],
      );
      expect(inserted.rowCount).toBe(LIMIT + 1);

      const from = new Date(Date.parse(base) - 3_600_000).toISOString();
      const to = new Date(Date.parse(base) + (LIMIT + 5) * 3_600_000).toISOString();
      const rows = await listBlackouts(app, R.venue, { from, to });
      expect(rows).toHaveLength(LIMIT);
      expect(rows.map((r) => r.reason)).toEqual(Array.from({ length: LIMIT }, (_, i) => `bulk ${i}`));
      expect(rows.filter((r) => !r.active)).toHaveLength(LIMIT / 2);
      expect(rows.every((r, i) => i === 0 || rows[i - 1]!.startsAt < r.startsAt)).toBe(true);

      // the last two of the 501 are in a window of their own, which is under the bound
      const tail = await listBlackouts(app, R.venue, {
        from: new Date(Date.parse(base) + (LIMIT - 1) * 3_600_000).toISOString(),
        to: new Date(Date.parse(base) + (LIMIT + 2) * 3_600_000).toISOString(),
      });
      expect(tail.map((r) => r.reason)).toEqual([`bulk ${LIMIT - 1}`, `bulk ${LIMIT}`]);
    }, 60_000);
  });

  describe("the handle's admin methods", () => {
    it("run each command on a pooled client under its own command name and trace id, and return the client idle", async () => {
      const S = await fresh(); const day = nextDay();
      const seen: string[] = [];
      const pool = new Pool({ connectionString: conn.app, max: 2, application_name: "ac-pool" });
      pool.on("error", () => undefined);
      const d = createDastar({ pool, onAcquire: (info) => { seen.push(`${info.command}:${info.traceId}`); } });
      try {
        const c1 = ctx(S); const c2 = ctx(S); const c3 = ctx(S); const c4 = ctx(S); const c5 = ctx(S); const c6 = ctx(S);
        const schedule = await d.admin.createSchedule(c1, sched());
        expect((await d.admin.listSchedules(S.venue)).map((s) => s.id)).toEqual([schedule.id]);
        expect(await d.admin.updateSchedule(c2, { scheduleId: schedule.id, closes: "02:00" })).toMatchObject({ id: schedule.id, closesNextDay: true });
        const created = await d.admin.createBlackout(c3, bo(day));
        expect(created).toMatchObject({ ok: true, cancelled: [], value: { reason: "private event", active: true } });
        const blackoutId = (created as { value: BlackoutView }).value.id;
        expect((await d.admin.listBlackouts(S.venue, { from: at(day, 0), to: at(day + 1, 0) })).map((b) => b.id)).toEqual([blackoutId]);
        expect(await d.admin.updateBlackout(c4, { blackoutId, active: false })).toMatchObject({ ok: true, cancelled: [], value: { id: blackoutId, active: false } });
        await expect(d.admin.updateBlackout(c5, { blackoutId: ABSENT, active: false })).rejects.toMatchObject({ code: "not_found" });
        await expect(d.admin.createSchedule(c6, sloppy({ opens: "noon" }))).rejects.toMatchObject({ code: "invalid_input" });
        await expect(d.admin.listBlackouts(S.venue, { from: at(day, 1), to: at(day, 0) })).rejects.toMatchObject({ code: "invalid_input" });
        expect(pool.idleCount).toBe(pool.totalCount);
        expect(seen).toEqual([
          `createSchedule:${c1.traceId}`, "listSchedules:null", `updateSchedule:${c2.traceId}`, `createBlackout:${c3.traceId}`, "listBlackouts:null",
          `updateBlackout:${c4.traceId}`, `updateBlackout:${c5.traceId}`, `createSchedule:${c6.traceId}`, "listBlackouts:null",
        ]);
        expect(await scheduleCount(S.venue)).toBe(1);
        expect(await blackoutCount(S.venue)).toBe(1);
      } finally {
        await d.close();
        await pool.end();
      }
    });
  });

  describe("two connections", () => {
    const receiptOf = (out: HoldOutcome): string => (out as { receipt: { reservationId: string } }).receipt.reservationId;

    it("(a) a forced blackout queues on the venue lock behind a hold that holds it, then cancels the hold's reservation and stores the blackout", async () => {
      const before = await deadlockCountStable(owner);
      const S = await fresh(); const day = nextDay();
      const i = input(S, at(day, 19));
      const c = ctx(S);
      const p = pause();
      const pHold = outcome(hold(H, i, { beforeUnitLocks: p.hook }));
      let pBlackout: Promise<Outcome<AdminOutcome<BlackoutView>>> | undefined;
      let reservationId = "";
      try {
        await p.reached;
        // the hold holds the venue lock shared and has stored nothing
        expect(await advisoryHeld("ac-H", "ShareLock")).toBe(1);
        expect(await advisoryHeld("ac-H", "ExclusiveLock")).toBe(0);
        expect(await reservationsBy(i.actor)).toBe(0);
        pBlackout = outcome(createBlackout(W, c, bo(day, { force: true })));
        await waitForBackend(owner, "ac-W", { type: "Lock", event: "advisory" });
        // the command has decided nothing and stored nothing while it waits
        expect(await blackoutCount(S.venue)).toBe(0);
        p.release();
        reservationId = receiptOf(settled(await pHold));
        const out = accepted(settled(await pBlackout));
        // the command saw the hold's reservation only because it waited for the hold to commit
        expect(out.cancelled).toEqual([reservationId]);
        expect(out.value).toMatchObject({ startsAt: at(day, 18), endsAt: at(day, 22), reason: "private event", active: true });
      } finally {
        p.release();
        await pHold;
        if (pBlackout) await pBlackout;
        await W.query("rollback").catch(() => undefined);
      }
      await expectCancelledByAdmin(S, reservationId, "venue change", c);
      expect(await blackoutCount(S.venue)).toBe(1);
      expect(await cancelEventCount(S.venue)).toBe(1);
      expect(await advisoryHeld("ac-H", "ShareLock") + await advisoryHeld("ac-W", "ExclusiveLock")).toBe(0);
      expect(await deadlockCountStable(owner)).toBe(before);
    });

    it("(b) a blackout without force, queued behind the same hold, is refused naming the hold's reservation, and stores nothing", async () => {
      const before = await deadlockCountStable(owner);
      const S = await fresh(); const day = nextDay();
      const i = input(S, at(day, 19));
      const p = pause();
      const pHold = outcome(hold(H, i, { beforeUnitLocks: p.hook }));
      let pBlackout: Promise<Outcome<AdminOutcome<BlackoutView>>> | undefined;
      let reservationId = "";
      try {
        await p.reached;
        pBlackout = outcome(createBlackout(W, ctx(S), bo(day)));
        await waitForBackend(owner, "ac-W", { type: "Lock", event: "advisory" });
        p.release();
        reservationId = receiptOf(settled(await pHold));
        expect(refused(settled(await pBlackout))).toEqual(CONFLICT([reservationId]));
      } finally {
        p.release();
        await pHold;
        if (pBlackout) await pBlackout;
        await W.query("rollback").catch(() => undefined);
      }
      await expectUntouched(S, reservationId, "held");
      expect(await blackoutCount(S.venue)).toBe(0);
      expect(await deadlockCountStable(owner)).toBe(before);
    });
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { Client, ClientBase, QueryResultRow } from "pg";
import { BOUNDS, type RankingStrategy } from "@dastar/core";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { setClock } from "./helpers/clock.js";
import { seedVenue, type Seed } from "./helpers/seed.js";
import { hold, rangeLiteral, type HoldInput } from "../src/commands/hold.js";
import { confirm } from "../src/commands/confirm.js";
import { cancel } from "../src/commands/cancel.js";
import { seat, complete } from "../src/commands/seat.js";
import { bindVenue } from "../src/context.js";
import { availability, SnapshotCache, PERIODS_SQL, OCCUPANCY_SQL, type AvailabilityInput, type AvailabilityResult } from "../src/commands/availability.js";

describe("availability", () => {
  let conn: Conn; let owner: Client; let app: Client;
  let n = 0; let dayN = 0;

  beforeAll(async () => {
    conn = await cloneDatabase("availability_test");
    owner = await connect(conn.owner);
    app = await connect(conn.app);
  });
  afterAll(async () => {
    await app.end(); await owner.end();
    await dropDatabase("availability_test");
  });

  /** A fresh day in 2060 for each scenario. Every scenario also gets a venue of its own, so no hold of another is in its way. */
  const nextDay = (): number => ++dayN;
  const at = (day: number, hour: number, minute = 0): string => new Date(Date.UTC(2060, 0, day, hour, minute)).toISOString();
  /** ISO weekday of a day of January 2060: Monday is 1, Sunday is 7. */
  const isoDow = (day: number): number => new Date(Date.UTC(2060, 0, day)).getUTCDay() || 7;
  const minutes = (hour: number, minute = 0): number => hour * 60 + minute;
  const clock = (total: number): string => `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  /** "HH:MM" of every grid start from `from` to `to` inclusive. */
  const grid = (from: number, to: number, step: number): string[] => {
    const out: string[] = [];
    for (let t = from; t <= to; t += step) out.push(clock(t));
    return out;
  };
  /** The "HH:MM" of each slot's start; every window below is one UTC day. */
  const starts = (r: AvailabilityResult): string[] => r.slots.map((s) => s.startsAt.slice(11, 16));

  const DURATIONS = '{"2":90,"4":120,"8":150}';

  /** The seed venue as a UTC venue, so a local time is its UTC time; the seed's venue is in Berlin. */
  async function utcVenue(over: { slotMinutes?: number; windowDays?: number } = {}): Promise<Seed> {
    const seed = await seedVenue(owner);
    await owner.query(
      "update dastar.venue set timezone = 'UTC', max_live_holds_per_actor = 100, slot_minutes = $2, availability_window_days = $3 where id = $1",
      [seed.venue, over.slotMinutes ?? 15, over.windowDays ?? 14],
    );
    return seed;
  }

  type Service = { opens: string; closes: string; nextDay: boolean; durations: string; gap: number; active: boolean };
  /** One weekly service period on the weekday of `day`, written by the owner; the default is 17:00 to 23:00. */
  async function addSchedule(venueId: string, day: number, over: Partial<Service> = {}): Promise<string> {
    const r: Service = { opens: "17:00", closes: "23:00", nextDay: false, durations: DURATIONS, gap: 0, active: true, ...over };
    return (await owner.query(
      `insert into dastar.schedule(venue_id, day_of_week, opens, closes, closes_next_day, duration_by_size, gap_minutes, active)
       values ($1, $2, $3::time, $4::time, $5, $6::jsonb, $7, $8) returning id`,
      [venueId, isoDow(day), r.opens, r.closes, r.nextDay, r.durations, r.gap, r.active],
    )).rows[0].id as string;
  }
  async function addBlackout(venueId: string, during: string, active = true): Promise<void> {
    await owner.query("insert into dastar.blackout(venue_id, during, reason, active) values ($1, $2::tstzrange, 'closed', $3)", [venueId, during, active]);
  }

  function holdInput(seed: Seed, startsAt: string, over: Partial<HoldInput> = {}): HoldInput {
    n += 1;
    return {
      venueId: seed.venue, actor: `key:av${n}`, traceId: `av-t${n}`, idempotencyKey: `av-k${n}`,
      partySize: 2, startsAt, durationMinutes: 90, assignment: { kind: "unit", id: seed.units[0]! }, ...over,
    };
  }
  /** One hold through the engine; a refusal fails the test with its code. */
  async function place(seed: Seed, startsAt: string, over: Partial<HoldInput> = {}): Promise<string> {
    const out = await hold(app, holdInput(seed, startsAt, over));
    if (!out.ok) throw new Error(out.error.code);
    return out.receipt.reservationId;
  }
  const unit = (seed: Seed, index: number) => ({ kind: "unit", id: seed.units[index]! }) as const;
  /** Live holds from 11:00 to 23:00 on the units at `indexes`, so no booking inside a period of that day can use them. */
  async function occupy(seed: Seed, day: number, indexes: number[]): Promise<void> {
    for (const i of indexes) await place(seed, at(day, 11), { partySize: 1, durationMinutes: 720, assignment: unit(seed, i) });
  }
  /** A hold made on a clock an hour in the past is already due; nothing sweeps it until `expireDue` runs. */
  async function dueHold(seed: Seed, startsAt: string, over: Partial<HoldInput> = {}): Promise<string> {
    await setClock(app, new Date(Date.now() - 3_600_000).toISOString());
    return await place(seed, startsAt, over).finally(() => setClock(app, null));
  }
  const ctx = (seed: Seed) => ({ actor: "key:desk", traceId: `av-c${++n}`, venueId: seed.venue });
  const storedStatus = async (id: string): Promise<string> =>
    (await owner.query("select status from dastar.reservation where id = $1", [id])).rows[0].status as string;

  const dayWindow = (day: number) => ({ from: at(day, 0), to: at(day + 1, 0) });
  /** The slots a party is offered over one UTC day. */
  function offer(seed: Seed, day: number, partySize: number, over: Partial<AvailabilityInput> = {}, cache?: SnapshotCache): Promise<AvailabilityResult> {
    return availability(app, { venueId: seed.venue, partySize, ...dayWindow(day), ...over }, cache);
  }
  const onUnit = (r: AvailabilityResult, id: string): boolean => r.slots.every((s) => s.assignment.kind === "unit" && s.assignment.id === id);

  /** A statement read-only, bound to the venue, as a command binds its reads. */
  async function readBound(venueId: string, sql: string, params: unknown[]): Promise<QueryResultRow[]> {
    await app.query("begin isolation level repeatable read read only");
    try {
      await bindVenue(app, venueId);
      const rows = (await app.query(sql, params)).rows;
      await app.query("commit");
      return rows;
    } catch (e) {
      await app.query("rollback").catch(() => undefined);
      throw e;
    }
  }

  describe("service periods in the venue's zone (PERIODS_SQL)", () => {
    async function bareVenue(timezone: string): Promise<string> {
      return (await owner.query("insert into dastar.venue(name, timezone) values ('Periods', $1) returning id", [timezone])).rows[0].id as string;
    }
    /** The weekly row, written by the owner; `day` is the ISO weekday itself, not a date. */
    async function insertWeekly(venueId: string, day: number, opens: string, closes: string, nextDay: boolean, active = true): Promise<string> {
      return (await owner.query(
        `insert into dastar.schedule(venue_id, day_of_week, opens, closes, closes_next_day, duration_by_size, gap_minutes, active)
         values ($1, $2, $3::time, $4::time, $5, '{"2":90}'::jsonb, 0, $6) returning id`,
        [venueId, day, opens, closes, nextDay, active],
      )).rows[0].id as string;
    }
    async function periodsOf(venueId: string, from: string, to: string): Promise<{ scheduleId: string; startsAt: string; endsAt: string }[]> {
      const rows = await readBound(venueId, PERIODS_SQL, [venueId, from, to]);
      return rows.map((r) => ({ scheduleId: r.schedule_id as string, startsAt: new Date(r.starts_at).toISOString(), endsAt: new Date(r.ends_at).toISOString() }));
    }
    const hoursBetween = (p: { startsAt: string; endsAt: string }): number => (Date.parse(p.endsAt) - Date.parse(p.startsAt)) / 3_600_000;

    it("a Friday evening in winter time is the local hours shifted by one", async () => {
      const venue = await bareVenue("Europe/Berlin");
      const id = await insertWeekly(venue, 5, "17:00", "23:00", false);
      expect(await periodsOf(venue, "2061-03-25T00:00:00Z", "2061-03-26T00:00:00Z"))
        .toEqual([{ scheduleId: id, startsAt: "2061-03-25T16:00:00.000Z", endsAt: "2061-03-25T22:00:00.000Z" }]);
    });

    it("a Saturday period that ends after midnight is 5 hours on the spring night and 7 on the autumn night", async () => {
      const venue = await bareVenue("Europe/Berlin");
      const id = await insertWeekly(venue, 6, "22:00", "04:00", true);
      const spring = await periodsOf(venue, "2061-03-26T00:00:00Z", "2061-03-27T00:00:00Z");
      expect(spring).toEqual([{ scheduleId: id, startsAt: "2061-03-26T21:00:00.000Z", endsAt: "2061-03-27T02:00:00.000Z" }]);
      expect(hoursBetween(spring[0]!)).toBe(5);
      const autumn = await periodsOf(venue, "2061-10-29T00:00:00Z", "2061-10-30T00:00:00Z");
      expect(autumn).toEqual([{ scheduleId: id, startsAt: "2061-10-29T20:00:00.000Z", endsAt: "2061-10-30T03:00:00.000Z" }]);
      expect(hoursBetween(autumn[0]!)).toBe(7);
    });

    it("an opening in the spring gap takes the offset before the transition, an ambiguous autumn opening the later instant; Sunday is 7", async () => {
      const venue = await bareVenue("Europe/Berlin");
      const id = await insertWeekly(venue, 7, "02:30", "05:00", false);
      expect(await periodsOf(venue, "2061-03-27T00:00:00Z", "2061-03-27T12:00:00Z"))
        .toEqual([{ scheduleId: id, startsAt: "2061-03-27T01:30:00.000Z", endsAt: "2061-03-27T03:00:00.000Z" }]);
      expect(await periodsOf(venue, "2061-10-30T00:00:00Z", "2061-10-30T12:00:00Z"))
        .toEqual([{ scheduleId: id, startsAt: "2061-10-30T01:30:00.000Z", endsAt: "2061-10-30T04:00:00.000Z" }]);
    });

    it("a window that starts inside an overnight period returns the previous local day's period, and the Sunday opening overlaps the Saturday period by 30 minutes", async () => {
      const venue = await bareVenue("Europe/Berlin");
      const saturday = await insertWeekly(venue, 6, "22:00", "04:00", true);
      const sunday = await insertWeekly(venue, 7, "02:30", "05:00", false);
      // 00:30Z to 01:00Z of the spring Sunday lies inside the Saturday period; the Sunday period opens at 01:30Z
      expect(await periodsOf(venue, "2061-03-27T00:30:00Z", "2061-03-27T01:00:00Z"))
        .toEqual([{ scheduleId: saturday, startsAt: "2061-03-26T21:00:00.000Z", endsAt: "2061-03-27T02:00:00.000Z" }]);
      expect(await periodsOf(venue, "2061-03-27T00:00:00Z", "2061-03-27T04:00:00Z")).toEqual([
        { scheduleId: saturday, startsAt: "2061-03-26T21:00:00.000Z", endsAt: "2061-03-27T02:00:00.000Z" },
        { scheduleId: sunday, startsAt: "2061-03-27T01:30:00.000Z", endsAt: "2061-03-27T03:00:00.000Z" },
      ]);
    });

    it("an inactive schedule returns nothing, and Monday is 1", async () => {
      const venue = await bareVenue("Europe/Berlin");
      await insertWeekly(venue, 1, "12:00", "15:00", false, false);
      const active = await insertWeekly(venue, 1, "18:00", "22:00", false);
      // Monday 2061-03-28 is in summer time
      expect(await periodsOf(venue, "2061-03-28T00:00:00Z", "2061-03-29T00:00:00Z"))
        .toEqual([{ scheduleId: active, startsAt: "2061-03-28T16:00:00.000Z", endsAt: "2061-03-28T20:00:00.000Z" }]);
    });
  });

  describe("what blocks a start", () => {
    /** T2 to T4 blocked all day and a booking of T1 over [19:00, 20:30), which a party of 3 can use only on T1: starts that avoid it are 17:00 and 20:30 on. */
    const AROUND_T1_BOOKING = ["17:00", "20:30", "20:45", "21:00"];

    async function venueWithT1Booking(day: number): Promise<Seed> {
      const V = await utcVenue();
      await addSchedule(V.venue, day);
      await occupy(V, day, [1, 2, 3]);
      return V;
    }

    it("a live hold blocks its unit for the starts that overlap it and for no others", async () => {
      const day = nextDay();
      const V = await venueWithT1Booking(day);
      await place(V, at(day, 19), { partySize: 3, assignment: unit(V, 0) });
      const r = await offer(V, day, 3);
      expect(starts(r)).toEqual(AROUND_T1_BOOKING);
      expect(onUnit(r, V.units[0]!)).toBe(true);
      expect(r.slots.map((s) => s.durationMinutes)).toEqual([120, 120, 120, 120]);
      expect(r.truncated).toBe(false);
    });

    it("an unswept expired hold does not block, and holding the offered slot on its unit succeeds", async () => {
      const day = nextDay();
      const V = await venueWithT1Booking(day);
      const stale = await dueHold(V, at(day, 19), { partySize: 3, assignment: unit(V, 0) });
      // past its expiry and not swept: stored held, effective status expired
      expect(await storedStatus(stale)).toBe("held");
      const r = await offer(V, day, 3);
      expect(starts(r)).toEqual(grid(minutes(17), minutes(21), 15));
      expect(onUnit(r, V.units[0]!)).toBe(true);
      const slot = r.slots.find((s) => s.startsAt === at(day, 19));
      expect(slot).toBeDefined();
      const out = await hold(app, holdInput(V, slot!.startsAt, { partySize: 3, durationMinutes: slot!.durationMinutes, assignment: slot!.assignment, enforceSchedule: true }));
      expect(out).toMatchObject({ ok: true });
      expect(await storedStatus(stale)).toBe("expired");
    });

    it("a completed reservation blocks, since it keeps its unit rows", async () => {
      const day = nextDay();
      const V = await venueWithT1Booking(day);
      const id = await place(V, at(day, 19), { partySize: 3, assignment: unit(V, 0) });
      await confirm(app, { reservationId: id, ...ctx(V) });
      await seat(app, { reservationId: id, ...ctx(V) });
      await complete(app, { reservationId: id, ...ctx(V) });
      expect(await storedStatus(id)).toBe("completed");
      const r = await offer(V, day, 3);
      expect(starts(r)).toEqual(AROUND_T1_BOOKING);
      expect(onUnit(r, V.units[0]!)).toBe(true);
    });

    it("a cancelled reservation does not block", async () => {
      const day = nextDay();
      const V = await venueWithT1Booking(day);
      const id = await place(V, at(day, 19), { partySize: 3, assignment: unit(V, 0) });
      await cancel(app, { reservationId: id, ...ctx(V), reason: "guest" });
      const r = await offer(V, day, 3);
      expect(starts(r)).toEqual(grid(minutes(17), minutes(21), 15));
      expect(onUnit(r, V.units[0]!)).toBe(true);
    });

    it("the occupancy read returns the bound venue's rows and no other venue's", async () => {
      const day = nextDay();
      const A = await utcVenue();
      const B = await utcVenue();
      await place(A, at(day, 19));
      await place(B, at(day, 19));
      const rows = await readBound(A.venue, OCCUPANCY_SQL, [at(day, 12), at(day + 1, 12)]);
      expect(rows.map((r) => r.unit_id)).toEqual([A.units[0]]);
    });

    it("a blackout drops the starts whose booking overlaps it; one that only touches a booking, and an inactive one, drop nothing", async () => {
      const day = nextDay();
      const V = await utcVenue();
      await addSchedule(V.venue, day);
      await addBlackout(V.venue, rangeLiteral(at(day, 19), 60)); // [19:00, 20:00)
      await addBlackout(V.venue, rangeLiteral(at(day, 20, 30), 60), false);
      const r = await offer(V, day, 3);
      // a booking of 120 minutes from 17:00 ends where the blackout starts; from 17:15 to 19:45 it overlaps; from 20:00 it starts where the blackout ends
      expect(starts(r)).toEqual(["17:00", "20:00", "20:15", "20:30", "20:45", "21:00"]);
    });

    it("a gap blocks a start within it on both sides of a booking and allows one at its edge", async () => {
      const startsWithGap = async (gap: number): Promise<string[]> => {
        const day = nextDay();
        const V = await utcVenue({ slotMinutes: 5 });
        await addSchedule(V.venue, day, { opens: "12:00", closes: "23:00", gap });
        await occupy(V, day, [1, 2, 3]);
        await place(V, at(day, 16), { partySize: 3, assignment: unit(V, 0) }); // [16:00, 17:30) on T1
        return starts(await offer(V, day, 3));
      };
      // a booking of 120 minutes ends at 16:00 from 14:00 and starts at 17:30 from then on
      expect(await startsWithGap(0)).toEqual([...grid(minutes(12), minutes(14), 5), ...grid(minutes(17, 30), minutes(21), 5)]);
      // 15 minutes of gap: the last start before ends 15 minutes before 16:00, and 17:40 starts 10 minutes after the booking ends
      expect(await startsWithGap(15)).toEqual([...grid(minutes(12), minutes(13, 45), 5), ...grid(minutes(17, 45), minutes(21), 5)]);
    });
  });

  describe("fitting and ranking", () => {
    it("a party of 6 is offered a combo, the first by label while every combo is free, and the first one over free units when T1 is busy", async () => {
      const day = nextDay();
      const V = await utcVenue();
      await addSchedule(V.venue, day);
      const free = await offer(V, day, 6);
      expect(starts(free)).toEqual(grid(minutes(17), minutes(20, 30), 15));
      expect(free.slots.every((s) => s.assignment.kind === "combo" && s.assignment.id === V.combos[0]!.id)).toBe(true);
      expect(free.slots.every((s) => s.durationMinutes === 150)).toBe(true);
      // C12, C13, C14 contain T1: C23 is the first of what is left
      await occupy(V, day, [0]);
      const busy = await offer(V, day, 6);
      expect(starts(busy)).toEqual(starts(free));
      expect(busy.slots.every((s) => s.assignment.kind === "combo" && s.assignment.id === V.combos[5]!.id)).toBe(true);
    });

    it("an inactive unit is not offered", async () => {
      const day = nextDay();
      const V = await utcVenue();
      await addSchedule(V.venue, day);
      await owner.query("update dastar.unit set active = false where id = $1", [V.units[0]]);
      const r = await offer(V, day, 3);
      expect(starts(r)).toEqual(grid(minutes(17), minutes(21), 15));
      // among T2 to T4, which tie, the label settles it; T1 would rank first if it were offered
      expect(onUnit(r, V.units[1]!)).toBe(true);
    });

    it("a combo over a deactivated member unit is not offered", async () => {
      const day = nextDay();
      const V = await utcVenue();
      await addSchedule(V.venue, day);
      await owner.query("update dastar.unit set active = false where id = $1", [V.units[0]]);
      const r = await offer(V, day, 6);
      expect(starts(r)).toEqual(grid(minutes(17), minutes(20, 30), 15));
      // C12, C13, C14 are over T1; the first usable by label is C23
      expect(r.slots.every((s) => s.assignment.kind === "combo" && s.assignment.id === V.combos[5]!.id)).toBe(true);
    });

    it("a party of 2 gets a capacity-2 unit before a capacity-4 one, and a capacity-4 unit once both capacity-2 units are busy", async () => {
      const day = nextDay();
      const V = await utcVenue();
      await addSchedule(V.venue, day);
      const small = await offer(V, day, 2);
      expect(starts(small)).toEqual(grid(minutes(17), minutes(21, 30), 15));
      expect(onUnit(small, V.units[4]!)).toBe(true);
      await occupy(V, day, [4, 5]);
      const large = await offer(V, day, 2);
      expect(starts(large)).toEqual(starts(small));
      expect(onUnit(large, V.units[0]!)).toBe(true);
    });

    it("a ranking strategy the caller passes chooses the assignment", async () => {
      const day = nextDay();
      const V = await utcVenue();
      await addSchedule(V.venue, day);
      const lastLabel: RankingStrategy = { name: "lastLabel", choose: (free) => [...free].sort((a, b) => (a.label < b.label ? 1 : -1))[0] ?? null };
      const r = await offer(V, day, 3, { ranking: lastLabel });
      expect(starts(r)).toEqual(grid(minutes(17), minutes(21), 15));
      expect(onUnit(r, V.units[3]!)).toBe(true);
    });
  });

  describe("the candidate order a ranking strategy receives", () => {
    it("is by label then id, whatever the order the rows were inserted in, with and without a cache", async () => {
      const day = nextDay();
      const V = await utcVenue();
      await addSchedule(V.venue, day);
      // inserted after T1 to T6, so insertion order alone would put it last of the fitting units
      const added = (await owner.query("insert into dastar.unit(venue_id, label, capacity_min, capacity_max) values ($1, 'A0', 1, 4) returning id", [V.venue])).rows[0].id as string;
      await occupy(V, day, [0]);
      const seen: string[][] = [];
      const first: RankingStrategy = { name: "first", choose: (free) => { seen.push(free.map((c) => c.label)); return free[0] ?? null; } };
      const cache = new SnapshotCache();
      const expected = grid(minutes(17), minutes(21), 15);
      for (const [name, c] of [["cold cache", cache], ["warm cache", cache], ["no cache", undefined]] as const) {
        seen.length = 0;
        const r = await offer(V, day, 3, { ranking: first }, c);
        // T1 is busy; a party of 3 fits T2 to T4 and A0
        expect(starts(r), name).toEqual(expected);
        expect(seen.length, name).toBe(expected.length);
        expect(seen.every((labels) => labels.join() === "A0,T2,T3,T4"), name).toBe(true);
        expect(onUnit(r, added), name).toBe(true);
      }
      expect(cache.size).toBe(1);
    });
  });

  describe("the window, the clock, and the limit", () => {
    it("starts before the database clock are dropped, a start at the clock is kept", async () => {
      const day = nextDay();
      const V = await utcVenue();
      await addSchedule(V.venue, day);
      const run = async (now: string): Promise<string[]> => {
        await setClock(app, now);
        try {
          return starts(await offer(V, day, 2));
        } finally {
          await setClock(app, null);
        }
      };
      expect(await run(at(day, 19, 7))).toEqual(grid(minutes(19, 15), minutes(21, 30), 15));
      expect(await run(at(day, 19, 15))).toEqual(grid(minutes(19, 15), minutes(21, 30), 15));
      expect(await run(at(day, 19, 16))).toEqual(grid(minutes(19, 30), minutes(21, 30), 15));
    });

    it("overlapping periods give one slot per start, with the duration of the period that opens first", async () => {
      const day = nextDay();
      const V = await utcVenue();
      await addSchedule(V.venue, day); // 17:00 to 23:00, 90 minutes for a party of 2
      await addSchedule(V.venue, day, { opens: "18:00", closes: "23:30", durations: '{"2":60,"4":60,"8":60}' });
      const r = await offer(V, day, 2);
      expect(starts(r)).toEqual(grid(minutes(17), minutes(22, 30), 15));
      // the first period's last start is 21:30; later starts exist only in the second
      expect(r.slots.map((s) => s.durationMinutes)).toEqual(starts(r).map((t) => (t <= "21:30" ? 90 : 60)));
    });

    it("a window one minute longer than availability_window_days is refused window_too_large, and one of exactly that length is read", async () => {
      const V = await utcVenue({ windowDays: 2 });
      const from = at(1, 0);
      const exactly = new Date(Date.parse(from) + 2 * 86_400_000).toISOString();
      const over = new Date(Date.parse(from) + 2 * 86_400_000 + 60_000).toISOString();
      await expect(availability(app, { venueId: V.venue, partySize: 2, from, to: over })).rejects.toMatchObject({ code: "window_too_large" });
      expect(await availability(app, { venueId: V.venue, partySize: 2, from, to: exactly })).toEqual({ slots: [], truncated: false });
    });

    it("a venue that does not exist is not_found, and the connection is usable afterwards", async () => {
      const day = nextDay();
      await expect(availability(app, { venueId: randomUUID(), partySize: 2, ...dayWindow(day) })).rejects.toMatchObject({ code: "not_found" });
      const V = await utcVenue();
      await addSchedule(V.venue, day);
      expect((await offer(V, day, 2)).slots.length).toBeGreaterThan(0);
    });

    it("an empty or reversed window and a party below 1 have no slots", async () => {
      const day = nextDay();
      const V = await utcVenue();
      await addSchedule(V.venue, day);
      expect((await offer(V, day, 2)).slots.length).toBeGreaterThan(0);
      const none = { slots: [], truncated: false };
      expect(await offer(V, day, 2, { from: at(day, 18), to: at(day, 18) })).toEqual(none);
      expect(await offer(V, day, 2, { from: at(day, 20), to: at(day, 18) })).toEqual(none);
      expect(await offer(V, day, 0)).toEqual(none);
    });

    it("a party larger than every duration key has no slots", async () => {
      const day = nextDay();
      const V = await utcVenue();
      await addSchedule(V.venue, day, { durations: '{"2":90,"4":120}' });
      expect((await offer(V, day, 4)).slots.length).toBeGreaterThan(0);
      expect(await offer(V, day, 5)).toEqual({ slots: [], truncated: false });
    });

    it("a limit below the free starts returns that many slots and says truncated; a limit equal to them does not", async () => {
      const day = nextDay();
      const V = await utcVenue();
      await addSchedule(V.venue, day);
      const limited = await offer(V, day, 2, { limit: 2 });
      expect(starts(limited)).toEqual(["17:00", "17:15"]);
      expect(limited.truncated).toBe(true);
      // two starts in the window, the limit is two
      const exact = await offer(V, day, 2, { from: at(day, 17), to: at(day, 17, 30), limit: 2 });
      expect(starts(exact)).toEqual(["17:00", "17:15"]);
      expect(exact.truncated).toBe(false);
      const all = await offer(V, day, 2);
      expect(starts(all)).toEqual(grid(minutes(17), minutes(21, 30), 15));
      expect(all.truncated).toBe(false);
    });

    it("a limit that is not a finite number is the default limit, not no limit", async () => {
      const day = nextDay();
      const V = await utcVenue({ slotMinutes: 5 });
      // 10:00 to 22:00 with 90 minutes for a party of 2: 127 grid starts, above the default of 100
      await addSchedule(V.venue, day, { opens: "10:00", closes: "22:00" });
      const byDefault = await offer(V, day, 2);
      expect(byDefault.slots).toHaveLength(BOUNDS.availabilityResults.default);
      expect(byDefault.truncated).toBe(true);
      for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(await offer(V, day, 2, { limit }), `limit ${limit}`).toEqual(byDefault);
      }
    });

    it("every returned slot is held unchanged: its start, duration, and assignment, under the schedule policy", async () => {
      const day = nextDay();
      const V = await utcVenue();
      await addSchedule(V.venue, day);
      for (const party of [2, 3, 6]) {
        const slots = (await offer(V, day, party)).slots;
        expect(slots.length, `party ${party}`).toBeGreaterThanOrEqual(3);
        for (const index of new Set([0, Math.floor(slots.length / 2), slots.length - 1])) {
          const slot = slots[index]!;
          const input = holdInput(V, slot.startsAt, { partySize: party, durationMinutes: slot.durationMinutes, assignment: slot.assignment, enforceSchedule: true });
          const out = await hold(app, input);
          expect(out, `party ${party}, ${slot.startsAt} ${slot.assignment.kind}`).toMatchObject({ ok: true });
          if (out.ok) await cancel(app, { reservationId: out.receipt.reservationId, ...ctx(V), reason: "guest" });
        }
      }
    });
  });

  describe("query bounds", () => {
    /**
     * A UTC venue with one candidate, T5 (capacity 1 to 2, a party of 2), every other unit deactivated so no combination is usable,
     * and one period of the weekday of `day`; durations are 720 minutes, so a gap of 720 reaches the padding the bounds allow for.
     */
    async function lone(day: number, period: { opens: string; closes: string; gap: number }): Promise<Seed> {
      const V = await utcVenue({ slotMinutes: 60 });
      await owner.query("update dastar.unit set active = false where venue_id = $1 and id <> $2", [V.venue, V.units[4]]);
      await addSchedule(V.venue, day, { ...period, nextDay: true, durations: '{"2":720}' });
      return V;
    }
    /** A hold on T5 of `minutesLong` from `startsAt`, outside any schedule. */
    const holdT5 = (V: Seed, startsAt: string, minutesLong: number): Promise<string> =>
      place(V, startsAt, { partySize: 2, durationMinutes: minutesLong, assignment: unit(V, 4) });

    it("occupancy is read from 12 hours before the window: a hold ending a minute into the start's padding blocks it", async () => {
      // a 24-hour period from D 00:00 with 720 minutes: its first start is D 00:00, whose padded range [D-12h, D+24h) takes a gap of 720 on both sides
      const day = nextDay();
      const blocked = await lone(day, { opens: "00:00", closes: "00:00", gap: 720 });
      // [D-13h, D-12h+1min) overlaps the padded range by one minute and ends well before the 01:00 start's padding begins (D-11h)
      await holdT5(blocked, at(day - 1, 11), 61);
      const withHold = await offer(blocked, day, 2);
      expect(starts(withHold)).not.toContain("00:00");
      expect(starts(withHold)).toContain("01:00");
      const controlDay = nextDay();
      const control = await lone(controlDay, { opens: "00:00", closes: "00:00", gap: 720 });
      expect(starts(await offer(control, controlDay, 2))).toContain("00:00");
    });

    it("occupancy is read to 24 hours after the window: a hold starting a minute before the end of the padding blocks the start", async () => {
      // the period D 23:00 to D+1 11:00 holds one start, D 23:00, booked [D 23:00, D+1 11:00); a gap of 720 pads it to [D 11:00, D+1 23:00)
      const day = nextDay();
      const blocked = await lone(day, { opens: "23:00", closes: "11:00", gap: 720 });
      await holdT5(blocked, at(day + 1, 22, 59), 60); // [D+1 22:59, D+1 23:59) overlaps the padding by a minute; a bound of to + 12h (D+1 12:00) would miss it
      expect(starts(await offer(blocked, day, 2))).toEqual([]);
      const controlDay = nextDay();
      const control = await lone(controlDay, { opens: "23:00", closes: "11:00", gap: 720 });
      expect(starts(await offer(control, controlDay, 2))).toEqual(["23:00"]);
    });

    it("closures are read to 12 hours after the window: a blackout that begins after it and overlaps the booking drops the start", async () => {
      // the same period with no gap: booked [D 23:00, D+1 11:00); the blackout [D+1 10:59, D+1 11:30) overlaps the end of the booking and begins after the window
      const day = nextDay();
      const closed = await lone(day, { opens: "23:00", closes: "11:00", gap: 0 });
      await addBlackout(closed.venue, rangeLiteral(at(day + 1, 10, 59), 31));
      expect(starts(await offer(closed, day, 2))).toEqual([]);
      const controlDay = nextDay();
      const control = await lone(controlDay, { opens: "23:00", closes: "11:00", gap: 0 });
      expect(starts(await offer(control, controlDay, 2))).toEqual(["23:00"]);
    });
  });

  describe("across a change of the clocks, end to end", () => {
    /** The seed's venue in Berlin, hourly slots, and one Saturday period from 22:00 to 04:00 the next day, 60 minutes for a party of 2. */
    async function berlinNight(): Promise<Seed> {
      const V = await seedVenue(owner);
      await owner.query("update dastar.venue set max_live_holds_per_actor = 100, slot_minutes = 60 where id = $1", [V.venue]);
      await owner.query(
        `insert into dastar.schedule(venue_id, day_of_week, opens, closes, closes_next_day, duration_by_size, gap_minutes)
         values ($1, 6, '22:00', '04:00', true, '{"2":60}'::jsonb, 0)`,
        [V.venue],
      );
      return V;
    }
    async function offeredAndHeld(from: string, to: string): Promise<{ starts: string[]; held: unknown }> {
      const V = await berlinNight();
      const r = await availability(app, { venueId: V.venue, partySize: 2, from, to });
      const last = r.slots[r.slots.length - 1]!;
      const held = await hold(app, holdInput(V, last.startsAt, { durationMinutes: last.durationMinutes, assignment: last.assignment, enforceSchedule: true }));
      return { starts: r.slots.map((s) => s.startsAt), held };
    }

    it("the spring night offers five starts, 21:00Z to 01:00Z, and the last is held under the schedule policy", async () => {
      const out = await offeredAndHeld("2061-03-26T00:00:00Z", "2061-03-27T12:00:00Z");
      expect(out.starts).toEqual(["2061-03-26T21:00:00.000Z", "2061-03-26T22:00:00.000Z", "2061-03-26T23:00:00.000Z", "2061-03-27T00:00:00.000Z", "2061-03-27T01:00:00.000Z"]);
      expect(out.held).toMatchObject({ ok: true });
    });

    it("the autumn night offers seven starts, 20:00Z to 02:00Z, and the last is held under the schedule policy", async () => {
      const out = await offeredAndHeld("2061-10-29T00:00:00Z", "2061-10-30T12:00:00Z");
      expect(out.starts).toEqual([
        "2061-10-29T20:00:00.000Z", "2061-10-29T21:00:00.000Z", "2061-10-29T22:00:00.000Z", "2061-10-29T23:00:00.000Z",
        "2061-10-30T00:00:00.000Z", "2061-10-30T01:00:00.000Z", "2061-10-30T02:00:00.000Z",
      ]);
      expect(out.held).toMatchObject({ ok: true });
    });
  });

  describe("the snapshot cache", () => {
    it("a unit the owner adds is offered on the next call and is not once the owner deactivates it, through one cache", async () => {
      const day = nextDay();
      const V = await utcVenue();
      await addSchedule(V.venue, day);
      const cache = new SnapshotCache();
      const before = await offer(V, day, 3, {}, cache);
      expect(before.slots.length).toBeGreaterThan(0);
      expect(cache.size).toBe(1);
      // outside every combo, so it ranks ahead of T1 to T4, which each break combos
      const added = (await owner.query("insert into dastar.unit(venue_id, label, capacity_min, capacity_max) values ($1, 'A0', 1, 4) returning id", [V.venue])).rows[0].id as string;
      const withAdded = await offer(V, day, 3, {}, cache);
      expect(withAdded.slots.length).toBe(before.slots.length);
      expect(onUnit(withAdded, added)).toBe(true);
      await owner.query("update dastar.unit set active = false where id = $1", [added]);
      const without = await offer(V, day, 3, {}, cache);
      expect(without.slots.length).toBe(before.slots.length);
      expect(without.slots.some((s) => s.assignment.id === added)).toBe(false);
      expect(cache.size).toBe(1);
    });

    it("units and combos are read once per config version, and again after a write", async () => {
      const day = nextDay();
      const V = await utcVenue();
      await addSchedule(V.venue, day);
      const seen: string[] = [];
      const spy = { query: (text: string, values?: unknown[]) => { seen.push(text); return app.query(text, values); } } as unknown as ClientBase;
      const reads = (): number => seen.filter((q) => /from dastar\.unit(_combo)? where/.test(q)).length;
      const cache = new SnapshotCache();
      await availability(spy, { venueId: V.venue, partySize: 2, ...dayWindow(day) }, cache);
      expect(reads()).toBe(2);
      await availability(spy, { venueId: V.venue, partySize: 2, ...dayWindow(day) }, cache);
      expect(reads()).toBe(2);
      await owner.query("insert into dastar.unit(venue_id, label, capacity_min, capacity_max) values ($1, 'A0', 1, 4)", [V.venue]);
      await availability(spy, { venueId: V.venue, partySize: 2, ...dayWindow(day) }, cache);
      expect(reads()).toBe(4);
      // without a cache every call reads
      await availability(spy, { venueId: V.venue, partySize: 2, ...dayWindow(day) });
      expect(reads()).toBe(6);
    });

    it("keeps at most max venues and evicts the least recently used", () => {
      const snapshot = { units: [], combos: [] };
      const cache = new SnapshotCache(2);
      cache.set("a", "1", snapshot);
      cache.set("b", "1", snapshot);
      expect(cache.get("a", "1")).toBe(snapshot); // a is now the most recently used
      cache.set("c", "1", snapshot);
      expect(cache.size).toBe(2);
      expect(cache.get("b", "1")).toBeUndefined();
      expect(cache.get("a", "1")).toBe(snapshot);
      expect(cache.get("c", "1")).toBe(snapshot);
      // a different version is a miss, and a write replaces the venue's entry
      expect(cache.get("a", "2")).toBeUndefined();
      const replaced = { units: [], combos: [] };
      cache.set("a", "2", replaced);
      expect(cache.get("a", "1")).toBeUndefined();
      expect(cache.get("a", "2")).toBe(replaced);
      for (let i = 0; i < 10; i++) cache.set(`v${i}`, "1", snapshot);
      expect(cache.size).toBe(2);
    });
  });

  describe("the hold policy (enforceSchedule)", () => {
    const stored = async (venueId: string, key: string): Promise<number> =>
      (await owner.query("select count(*)::int as n from dastar.idempotency where venue_id = $1 and key = $2", [venueId, key])).rows[0].n as number;
    const reservationsBy = async (actor: string): Promise<number> =>
      (await owner.query("select count(*)::int as n from dastar.reservation where created_by = $1", [actor])).rows[0].n as number;

    it("a range inside a period is held; one that runs past the close is refused outside_schedule and stores nothing, and the same key and payload succeed once a schedule covers it", async () => {
      const day = nextDay();
      const V = await utcVenue();
      await addSchedule(V.venue, day); // 17:00 to 23:00
      expect(await hold(app, holdInput(V, at(day, 19), { enforceSchedule: true }))).toMatchObject({ ok: true, replayed: false });
      expect(await hold(app, holdInput(V, at(day, 21, 30), { enforceSchedule: true, assignment: unit(V, 1) }))).toMatchObject({ ok: true }); // ends at 23:00

      const late = holdInput(V, at(day, 22), { enforceSchedule: true, assignment: unit(V, 2) }); // ends at 23:30
      await expect(hold(app, late)).rejects.toMatchObject({ code: "outside_schedule" });
      expect(await stored(V.venue, late.idempotencyKey)).toBe(0);
      expect(await reservationsBy(late.actor)).toBe(0);

      await addSchedule(V.venue, day, { opens: "22:00", closes: "23:59" });
      expect(await hold(app, late)).toMatchObject({ ok: true, replayed: false });
      expect(await stored(V.venue, late.idempotencyKey)).toBe(1);
    });

    it("a range that starts before the opening, or spans two adjacent periods, is refused; an overnight period contains a range across midnight", async () => {
      const day = nextDay();
      const V = await utcVenue();
      await addSchedule(V.venue, day, { opens: "17:00", closes: "20:00" });
      await addSchedule(V.venue, day, { opens: "20:00", closes: "23:00" });
      const refused = (startsAt: string, minutesLong: number, index: number) =>
        expect(hold(app, holdInput(V, startsAt, { enforceSchedule: true, durationMinutes: minutesLong, assignment: unit(V, index) }))).rejects.toMatchObject({ code: "outside_schedule" });
      await refused(at(day, 19, 30), 90, 0); // [19:30, 21:00) spans both
      await refused(at(day, 16, 30), 90, 0); // [16:30, 18:00) starts before the opening
      expect(await hold(app, holdInput(V, at(day, 18), { enforceSchedule: true, durationMinutes: 90, assignment: unit(V, 0) }))).toMatchObject({ ok: true });
      expect(await hold(app, holdInput(V, at(day, 20), { enforceSchedule: true, durationMinutes: 180, assignment: unit(V, 1) }))).toMatchObject({ ok: true });

      const night = nextDay();
      const W = await utcVenue();
      await addSchedule(W.venue, night, { opens: "22:00", closes: "04:00", nextDay: true });
      // [23:00, 02:00) and, on the next date, [01:00, 02:00), which belongs to the period begun the evening before
      expect(await hold(app, holdInput(W, at(night, 23), { enforceSchedule: true, durationMinutes: 180 }))).toMatchObject({ ok: true });
      expect(await hold(app, holdInput(W, at(night + 1, 1), { enforceSchedule: true, durationMinutes: 60, assignment: unit(W, 1) }))).toMatchObject({ ok: true });
      await expect(hold(app, holdInput(W, at(night, 21), { enforceSchedule: true, durationMinutes: 90, assignment: unit(W, 2) }))).rejects.toMatchObject({ code: "outside_schedule" });
    });

    it("a venue with no active schedule is unrestricted", async () => {
      const day = nextDay();
      const none = await utcVenue();
      expect(await hold(app, holdInput(none, at(day, 3), { enforceSchedule: true }))).toMatchObject({ ok: true });
      const inactive = await utcVenue();
      await addSchedule(inactive.venue, day, { active: false });
      expect(await hold(app, holdInput(inactive, at(day, 3), { enforceSchedule: true }))).toMatchObject({ ok: true });
    });

    it("without the flag the out-of-hours range is held; with it the same range is refused", async () => {
      const day = nextDay();
      const V = await utcVenue();
      await addSchedule(V.venue, day);
      expect(await hold(app, holdInput(V, at(day, 3)))).toMatchObject({ ok: true });
      await expect(hold(app, holdInput(V, at(day, 3), { enforceSchedule: true, assignment: unit(V, 1) }))).rejects.toMatchObject({ code: "outside_schedule" });
    });

    it("a stored success replays with replayed true after the owner deactivates the schedule that covered it, with or without the flag", async () => {
      const day = nextDay();
      const V = await utcVenue();
      const covering = await addSchedule(V.venue, day);
      // the venue keeps hours on another weekday, so it is still restricted once the covering schedule is off
      await addSchedule(V.venue, day + 1, { opens: "12:00", closes: "15:00" });
      const input = holdInput(V, at(day, 19), { enforceSchedule: true });
      expect(await hold(app, input)).toMatchObject({ ok: true, replayed: false });
      await owner.query("update dastar.schedule set active = false where id = $1", [covering]);
      expect(await hold(app, input)).toMatchObject({ ok: true, replayed: true });
      // the flag is a policy, not part of the request: the same key with it off is the same request
      expect(await hold(app, { ...input, enforceSchedule: false })).toMatchObject({ ok: true, replayed: true });
      // a new key for the same range is judged now, and refused
      await expect(hold(app, holdInput(V, at(day, 19), { enforceSchedule: true, assignment: unit(V, 1) }))).rejects.toMatchObject({ code: "outside_schedule" });
    });
  });
});

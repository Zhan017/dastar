import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { hold, type HoldInput } from "../src/commands/hold.js";
import { cancel } from "../src/commands/cancel.js";
import { availability } from "../src/commands/availability.js";

const SEED = Number(process.env.DASTAR_PROPERTY_SEED ?? 20261017);
const SCENARIOS = 20;
const MINUTE = 60_000;

/** mulberry32: a 32-bit generator, enough to make every scenario reproducible from the seed in the test name. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type RawUnit = { id: string; capacity_min: number; capacity_max: number; active: boolean };
type RawCombo = { id: string; unit_ids: string[]; capacity_min: number; capacity_max: number; active: boolean };
type RawSchedule = { opens: string; closes: string; closes_next_day: boolean; duration_by_size: Record<string, number>; gap_minutes: number };
type RawInterval = { s: Date; e: Date };
type RawBusy = RawInterval & { unit_id: string };

const pad2 = (n: number): string => String(n).padStart(2, "0");
/** Minutes since midnight of a time column read as text ("14:00:00"). */
const minutesOfDay = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** The duration of the smallest key at or above the party, or null when every key is smaller. */
function minutesFor(durations: Record<string, number>, party: number): number | null {
  let bestKey = Infinity;
  let minutes: number | null = null;
  for (const key of Object.keys(durations)) {
    const k = Number(key);
    if (k >= party && k < bestKey) { bestKey = k; minutes = durations[key]!; }
  }
  return minutes;
}

describe("availability against a model", () => {
  let conn: Conn; let owner: Client; let app: Client;

  beforeAll(async () => {
    conn = await cloneDatabase("availability_property_test");
    owner = await connect(conn.owner);
    app = await connect(conn.app);
  });
  afterAll(async () => {
    await app.end(); await owner.end();
    await dropDatabase("availability_property_test");
  });

  it(`${SCENARIOS} random venues: every offered slot is sound, the offered starts equal a minute-by-minute model, and offered slots are granted (seed ${SEED})`, async () => {
    const rng = mulberry32(SEED);
    const int = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
    const chance = (p: number): boolean => rng() < p;
    const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;

    let offeredTotal = 0;
    let scenariosWithSlots = 0;
    let droppedTotal = 0;
    let granted = 0;
    let preplacedGranted = 0;
    let occupancyRefused = 0;
    let holdSeq = 0;

    for (let k = 0; k < SCENARIOS; k++) {
      const where = `scenario ${k}, seed ${SEED}`;
      const dayStart = Date.UTC(2062, 0, 1 + k);
      const dow = new Date(dayStart).getUTCDay() || 7;
      const iso = (relMinutes: number): string => new Date(dayStart + relMinutes * MINUTE).toISOString();

      // ---- the scenario, written by the owner ----
      const venue = (await owner.query(
        "insert into dastar.venue(name, timezone, hold_ttl_seconds, max_live_holds_per_actor) values ($1, 'UTC', 3600, 100) returning id",
        [`prop-${k}`],
      )).rows[0].id as string;

      const unitCount = int(3, 8);
      const unitIds: string[] = [];
      const unitCaps: number[] = [];
      for (let i = 0; i < unitCount; i++) {
        const cap = int(2, 6);
        unitCaps.push(cap);
        unitIds.push((await owner.query(
          "insert into dastar.unit(venue_id, label, capacity_min, capacity_max) values ($1, $2, 1, $3) returning id",
          [venue, `U${i}`, cap],
        )).rows[0].id as string);
      }
      const comboIds: string[] = [];
      for (let j = int(0, 3); j > 0; j--) {
        const pool = unitIds.map((_, i) => i);
        const members: number[] = [];
        for (let m = int(2, 3); m > 0; m--) members.push(pool.splice(int(0, pool.length - 1), 1)[0]!);
        comboIds.push((await owner.query(
          "insert into dastar.unit_combo(venue_id, label, unit_ids, capacity_min, capacity_max) values ($1, $2, $3::uuid[], 3, $4) returning id",
          [venue, `K${j}`, members.map((i) => unitIds[i]!).sort(), members.reduce((sum, i) => sum + unitCaps[i]!, 0)],
        )).rows[0].id as string);
      }
      for (const id of unitIds) if (chance(0.15)) await owner.query("update dastar.unit set active = false where id = $1", [id]);
      for (const id of comboIds) if (chance(0.1)) await owner.query("update dastar.unit_combo set active = false where id = $1", [id]);

      const insertSchedule = (opens: string, closes: string, nextDay: boolean, gap: number, active: boolean) => owner.query(
        `insert into dastar.schedule(venue_id, day_of_week, opens, closes, closes_next_day, duration_by_size, gap_minutes, active)
         values ($1, $2, $3::time, $4::time, $5, '{"2":60,"4":90,"6":120}'::jsonb, $6, $7)`,
        [venue, dow, opens, closes, nextDay, gap, active],
      );
      const services: { opens: number; length: number }[] = [{ opens: int(10, 18), length: int(2, 6) }];
      const first = services[0]!;
      if (first.opens + first.length < 24 && chance(0.5)) {
        const opens = first.opens + first.length + int(0, 2);
        if (opens <= 23) services.push({ opens, length: int(2, 6) });
      }
      for (const s of services) {
        const end = s.opens + s.length;
        await insertSchedule(`${pad2(s.opens)}:00`, `${pad2(end % 24)}:00`, end >= 24, pick([0, 10, 15]), true);
      }
      if (chance(0.3)) await insertSchedule("08:00", "12:00", false, 0, false);

      const insertBlackout = (startMinutes: number, length: number, active: boolean) => owner.query(
        "insert into dastar.blackout(venue_id, during, reason, active) values ($1, $2::tstzrange, 'prop', $3)",
        [venue, `[${iso(startMinutes)},${iso(startMinutes + length)})`, active],
      );
      if (chance(0.5)) await insertBlackout(15 * int(40, 88), pick([30, 60, 90, 120]), true);
      if (chance(0.3)) await insertBlackout(15 * int(40, 88), pick([30, 60, 90, 120]), false);

      // holds at random aligned times, over active assignments only; a refused hold (conflict, blackout) is a legitimate outcome
      const unitRows = (await owner.query("select id, capacity_min, capacity_max, active from dastar.unit where venue_id = $1", [venue])).rows as RawUnit[];
      const comboRows = (await owner.query("select id, unit_ids, capacity_min, capacity_max, active from dastar.unit_combo where venue_id = $1", [venue])).rows as RawCombo[];
      const targets = [
        ...unitRows.filter((u) => u.active).map((u) => ({ kind: "unit" as const, id: u.id, min: u.capacity_min, max: u.capacity_max })),
        ...comboRows.filter((c) => c.active).map((c) => ({ kind: "combo" as const, id: c.id, min: c.capacity_min, max: c.capacity_max })),
      ];
      if (targets.length > 0) {
        for (let h = int(0, 6); h > 0; h--) {
          const target = pick(targets);
          holdSeq += 1;
          const placed = await hold(app, {
            venueId: venue, actor: `key:prop${holdSeq}`, traceId: `prop-t${holdSeq}`, idempotencyKey: `prop-k${holdSeq}`,
            partySize: int(target.min, Math.min(target.max, 6)), startsAt: iso(15 * int(32, 88)), durationMinutes: pick([60, 90, 120, 150]),
            assignment: { kind: target.kind, id: target.id },
          });
          if (placed.ok) preplacedGranted += 1;
        }
      }

      // ---- the read under test ----
      const party = int(1, 6);
      const result = await availability(app, { venueId: venue, partySize: party, from: iso(0), to: iso(1440), limit: 500 });
      expect(result.truncated, where).toBe(false);

      // ---- the raw rows the checks and the model read, independently of the command ----
      const slotMinutes = (await owner.query("select slot_minutes from dastar.venue where id = $1", [venue])).rows[0].slot_minutes as number;
      const schedules = (await owner.query(
        "select opens::text as opens, closes::text as closes, closes_next_day, duration_by_size, gap_minutes from dastar.schedule where venue_id = $1 and active",
        [venue],
      )).rows as RawSchedule[];
      const blackouts = (await owner.query("select lower(during) as s, upper(during) as e from dastar.blackout where venue_id = $1 and active", [venue])).rows as RawInterval[];
      const busy = (await owner.query(
        `select ru.unit_id, lower(ru.during) as s, upper(ru.during) as e
           from dastar.reservation_unit ru join dastar.reservation r on r.id = ru.reservation_id
          where ru.venue_id = $1 and ru.active and dastar.effective_status(r.status, r.hold_expires_at) <> 'expired'`,
        [venue],
      )).rows as RawBusy[];
      const unitById = new Map(unitRows.map((u) => [u.id, u]));
      const comboById = new Map(comboRows.map((c) => [c.id, c]));
      /** The unit ids an assignment books when it fits the party and every unit it needs is active; null otherwise. */
      const unitsOf = (kind: string, id: string): string[] | null => {
        if (kind === "unit") {
          const u = unitById.get(id);
          return u && u.active && u.capacity_min <= party && party <= u.capacity_max ? [id] : null;
        }
        const c = comboById.get(id);
        if (!c || !c.active || !(c.capacity_min <= party && party <= c.capacity_max)) return null;
        return c.unit_ids.every((m) => unitById.get(m)?.active === true) ? [...c.unit_ids] : null;
      };
      const periods = schedules.map((s) => ({
        from: dayStart + minutesOfDay(s.opens) * MINUTE,
        to: dayStart + (minutesOfDay(s.closes) + (s.closes_next_day ? 1440 : 0)) * MINUTE,
        minutes: minutesFor(s.duration_by_size, party),
        gap: s.gap_minutes,
      }));

      // ---- (a) every offered slot is sound ----
      const starts = result.slots.map((s) => s.startsAt);
      expect(starts, `${where}: starts are in order, one slot per start`).toEqual([...new Set(starts)].sort());
      for (const slot of result.slots) {
        const at = `${where}, slot ${slot.startsAt} ${slot.assignment.kind} ${slot.assignment.id}, party ${party}`;
        const s = Date.parse(slot.startsAt);
        const e = s + slot.durationMinutes * MINUTE;
        const units = unitsOf(slot.assignment.kind, slot.assignment.id);
        expect(units, `${at}: the assignment fits the party and its units are active`).not.toBeNull();
        const period = periods.find((p) => p.minutes !== null && p.from <= s && e <= p.to);
        expect(period, `${at}: the booking lies in one period`).toBeDefined();
        expect(slot.durationMinutes, `${at}: the duration is the period's for the party`).toBe(period!.minutes);
        for (const b of blackouts) expect(b.s.getTime() < e && b.e.getTime() > s, `${at}: overlaps a blackout`).toBe(false);
        const paddedFrom = s - period!.gap * MINUTE;
        const paddedTo = e + period!.gap * MINUTE;
        for (const row of busy) {
          if (!units!.includes(row.unit_id)) continue;
          expect(row.s.getTime() < paddedTo && row.e.getTime() > paddedFrom, `${at}: padded range overlaps a unit row of ${row.unit_id}`).toBe(false);
        }
      }

      // ---- (b) the offered starts equal a model that walks the raw rows minute by minute ----
      const OFFSET = 1440;
      const busyMinutes = new Map<string, Uint8Array>();
      for (const u of unitRows) busyMinutes.set(u.id, new Uint8Array(OFFSET + 1440 + OFFSET));
      for (const row of busy) {
        const marks = busyMinutes.get(row.unit_id)!;
        const from = Math.max((row.s.getTime() - dayStart) / MINUTE, -OFFSET);
        const to = Math.min((row.e.getTime() - dayStart) / MINUTE, 1440 + OFFSET);
        for (let m = from; m < to; m++) marks[m + OFFSET] = 1;
      }
      const closedMinutes = new Uint8Array(OFFSET + 1440 + OFFSET);
      for (const b of blackouts) {
        const from = Math.max((b.s.getTime() - dayStart) / MINUTE, -OFFSET);
        const to = Math.min((b.e.getTime() - dayStart) / MINUTE, 1440 + OFFSET);
        for (let m = from; m < to; m++) closedMinutes[m + OFFSET] = 1;
      }
      const freeOver = (unit: string, from: number, to: number): boolean => {
        const marks = busyMinutes.get(unit)!;
        for (let m = from; m < to; m++) if (marks[m + OFFSET] === 1) return false;
        return true;
      };
      const modelStarts = new Set<string>();
      let gridStarts = 0;
      for (const s of schedules) {
        const minutes = minutesFor(s.duration_by_size, party);
        if (minutes === null) continue;
        const opens = minutesOfDay(s.opens);
        const closes = minutesOfDay(s.closes) + (s.closes_next_day ? 1440 : 0);
        for (let start = opens; start + minutes <= closes; start += slotMinutes) {
          if (start < 0 || start >= 1440) continue;
          gridStarts += 1;
          let closed = false;
          for (let m = start; m < start + minutes; m++) if (closedMinutes[m + OFFSET] === 1) closed = true;
          if (closed) continue;
          const lo = start - s.gap_minutes;
          const hi = start + minutes + s.gap_minutes;
          const bookable = [
            ...unitRows.filter((u) => u.active && u.capacity_min <= party && party <= u.capacity_max).map((u) => [u.id]),
            ...comboRows
              .filter((c) => c.active && c.capacity_min <= party && party <= c.capacity_max && c.unit_ids.every((m) => unitById.get(m)?.active === true))
              .map((c) => c.unit_ids),
          ];
          if (bookable.some((needed) => needed.every((u) => freeOver(u, lo, hi)))) modelStarts.add(iso(start));
          else if (bookable.length > 0) occupancyRefused += 1;
        }
      }
      expect([...starts].sort(), `${where}, party ${party}: offered starts`).toEqual([...modelStarts].sort());
      droppedTotal += gridStarts - modelStarts.size;
      offeredTotal += result.slots.length;
      if (result.slots.length > 0) scenariosWithSlots += 1;

      // ---- (c) offered slots are granted, one at a time and cancelled after ----
      const n = result.slots.length;
      const sample = n <= 5 ? result.slots : [0, 1, 2, 3, 4].map((i) => result.slots[Math.floor((i * (n - 1)) / 4)]!);
      for (const slot of sample) {
        holdSeq += 1;
        const input: HoldInput = {
          venueId: venue, actor: `key:prop${holdSeq}`, traceId: `prop-t${holdSeq}`, idempotencyKey: `prop-k${holdSeq}`,
          partySize: party, startsAt: slot.startsAt, durationMinutes: slot.durationMinutes, assignment: slot.assignment, enforceSchedule: true,
        };
        const out = await hold(app, input);
        expect(out, `${where}: holding ${slot.startsAt} ${slot.assignment.kind} ${slot.assignment.id}`).toMatchObject({ ok: true });
        if (out.ok) {
          await cancel(app, { reservationId: out.receipt.reservationId, actor: input.actor, traceId: `prop-c${holdSeq}`, venueId: venue, reason: "property" });
          granted += 1;
        }
      }
    }

    // the scenarios must have asked something: slots were offered, some grid starts were refused, and slots were granted
    expect(offeredTotal, "slots offered across the scenarios").toBeGreaterThan(0);
    expect(scenariosWithSlots, "scenarios with at least one offered slot").toBeGreaterThanOrEqual(SCENARIOS / 2);
    expect(droppedTotal, "grid starts refused by a hold, a blackout, an inactive unit, or a gap").toBeGreaterThan(0);
    expect(granted, "slots held and cancelled").toBeGreaterThan(0);
    expect(preplacedGranted, "pre-placed holds that were granted").toBeGreaterThan(0);
    expect(occupancyRefused, "open starts with a bookable candidate, refused by occupancy alone").toBeGreaterThan(0);
  }, 300_000);
});

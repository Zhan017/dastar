import type { ClientBase, QueryResultRow } from "pg";
import { BOUNDS } from "@dastar/core";
import { DastarError } from "../errors.js";
import {
  adminRead, adminTx, adminWrite, jsonText, settleStranded, STRANDED_COLUMNS, STRANDED_TAIL, LIVE,
  type AdminContext, type AdminOutcome, type ForceOption, type Stranded,
} from "./admin.js";

/** Times are `HH:MM` in the venue's own time zone. */
export type ScheduleView = {
  id: string; dayOfWeek: number; opens: string; closes: string; closesNextDay: boolean;
  durationBySize: Record<string, number>; gapMinutes: number; active: boolean;
};
/** `startsAt` and `endsAt` are UTC instants (ISO 8601); the range is half-open. */
export type BlackoutView = { id: string; startsAt: string; endsAt: string; reason: string; active: boolean };

/** `closes_next_day` is never an input: it follows from `opens` and `closes`. */
export type CreateScheduleInput = {
  dayOfWeek: number; opens: string; closes: string; durationBySize: Record<string, number>; gapMinutes?: number; active?: boolean;
};
export type UpdateScheduleInput = { scheduleId: string } & Partial<CreateScheduleInput>;
export type CreateBlackoutInput = { startsAt: string; endsAt: string; reason: string; active?: boolean } & ForceOption;
export type UpdateBlackoutInput = { blackoutId: string; reason?: string; active?: boolean } & ForceOption;
export type ListBlackoutsInput = { from: string; to: string };

const SCHEDULE_COLUMNS =
  "id, day_of_week, to_char(opens, 'HH24:MI') as opens, to_char(closes, 'HH24:MI') as closes, closes_next_day, duration_by_size, gap_minutes, active";
const BLACKOUT_COLUMNS = "id, lower(during) as starts_at, upper(during) as ends_at, reason, active";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// a date and time with an explicit offset; the day is checked against its month below
const INSTANT = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const DAY_MS = 86_400_000;

const scheduleView = (r: QueryResultRow): ScheduleView => ({
  id: r.id, dayOfWeek: r.day_of_week, opens: r.opens, closes: r.closes, closesNextDay: r.closes_next_day,
  durationBySize: r.duration_by_size, gapMinutes: r.gap_minutes, active: r.active,
});
const blackoutView = (r: QueryResultRow): BlackoutView => ({
  id: r.id, startsAt: new Date(r.starts_at).toISOString(), endsAt: new Date(r.ends_at).toISOString(), reason: r.reason, active: r.active,
});
const strandedOf = (rows: QueryResultRow[]): Stranded[] => rows.map((r) => ({ id: r.id as string, started: r.started === true }));

// Each check below refuses an input Postgres would reject with an error that is not a CHECK violation (a malformed time,
// a fractional integer, a NUL character, an unparseable date), so it surfaces as `invalid_input` and not as `internal`.
const invalid = (message: string): DastarError => new DastarError("invalid_input", message);

function checkDay(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 7) throw invalid("day_of_week must be a whole number from 1 (Monday) to 7 (Sunday)");
  return v;
}
function checkTime(name: string, v: unknown): string {
  if (typeof v !== "string" || !TIME.test(v)) throw invalid(`${name} must be a time of day as HH:MM`);
  return v;
}
function checkGap(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 720) throw invalid("gap_minutes must be a whole number from 0 to 720");
  return v;
}
function checkActive(v: unknown): boolean {
  if (typeof v !== "boolean") throw invalid("active must be true or false");
  return v;
}
/** The durations as JSON text; their keys and values are judged by the table's CHECK. */
function durationsJson(v: unknown): string {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw invalid("duration_by_size must be an object of party sizes to minutes");
  return jsonText("duration_by_size", v, "duration_by_size must be plain JSON without NUL characters");
}
function checkReason(v: unknown): string {
  if (typeof v !== "string" || v.includes("\0")) throw invalid("reason must be text without NUL characters");
  return v;
}
/** An instant given with an offset, as a Date; a day the month does not have, or a year Postgres does not take, is refused. */
function instant(name: string, v: unknown): Date {
  const m = typeof v === "string" ? INSTANT.exec(v) : null;
  const d = m ? new Date(v as string) : null;
  if (!m || !d || Number.isNaN(d.getTime()) || new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDate() !== Number(m[3])
      || d.getUTCFullYear() < 1 || d.getUTCFullYear() > 9999) {
    throw invalid(`${name} must be an ISO 8601 date and time with an offset`);
  }
  return d;
}
function checkRange(startsAt: unknown, endsAt: unknown): [string, string] {
  const s = instant("starts_at", startsAt); const e = instant("ends_at", endsAt);
  if (s.getTime() >= e.getTime()) throw invalid("starts_at must be before ends_at");
  return [s.toISOString(), e.toISOString()];
}

/** The venue's service periods, inactive ones included, by day, opening time, and id. */
export function listSchedules(client: ClientBase, venueId: string): Promise<ScheduleView[]> {
  return adminRead(client, venueId, async () => {
    const r = await client.query(`select ${SCHEDULE_COLUMNS} from dastar.schedule where venue_id = $1 order by day_of_week, opens, id`, [venueId]);
    return r.rows.map(scheduleView);
  });
}

/**
 * `closes_next_day` is computed from the final times: a period closes the next day when it closes at or before it opens.
 * A malformed field is `invalid_input`, and so is a CHECK violation (durations or gap out of range).
 */
export async function createSchedule(client: ClientBase, ctx: AdminContext, input: CreateScheduleInput): Promise<ScheduleView> {
  const day = checkDay(input.dayOfWeek);
  const opens = checkTime("opens", input.opens);
  const closes = checkTime("closes", input.closes);
  const durations = durationsJson(input.durationBySize);
  const gap = input.gapMinutes === undefined ? 0 : checkGap(input.gapMinutes);
  const active = input.active === undefined ? true : checkActive(input.active);
  return adminTx(client, ctx, async () => {
    const r = await client.query(
      `insert into dastar.schedule (venue_id, day_of_week, opens, closes, closes_next_day, duration_by_size, gap_minutes, active)
       values ($1, $2, $3::time, $4::time, ($4::time <= $3::time), $5::jsonb, $6, $7) returning ${SCHEDULE_COLUMNS}`,
      [ctx.venueId, day, opens, closes, durations, gap, active],
    );
    return scheduleView(r.rows[0]);
  });
}

/**
 * A field left out keeps its stored value, and `closes_next_day` is recomputed from the final times, so a change of
 * `opens` or `closes` alone can flip it. `not_found` for a schedule of another venue.
 */
export async function updateSchedule(client: ClientBase, ctx: AdminContext, input: UpdateScheduleInput): Promise<ScheduleView> {
  const day = input.dayOfWeek === undefined ? null : checkDay(input.dayOfWeek);
  const opens = input.opens === undefined ? null : checkTime("opens", input.opens);
  const closes = input.closes === undefined ? null : checkTime("closes", input.closes);
  const durations = input.durationBySize === undefined ? null : durationsJson(input.durationBySize);
  const gap = input.gapMinutes === undefined ? null : checkGap(input.gapMinutes);
  const active = input.active === undefined ? null : checkActive(input.active);
  return adminTx(client, ctx, async () => {
    const r = await client.query(
      `update dastar.schedule set
         day_of_week = coalesce($3::smallint, day_of_week),
         opens = coalesce($4::time, opens),
         closes = coalesce($5::time, closes),
         closes_next_day = (coalesce($5::time, closes) <= coalesce($4::time, opens)),
         duration_by_size = coalesce($6::jsonb, duration_by_size),
         gap_minutes = coalesce($7::int, gap_minutes),
         active = coalesce($8::boolean, active)
       where id = $1 and venue_id = $2 returning ${SCHEDULE_COLUMNS}`,
      [input.scheduleId, ctx.venueId, day, opens, closes, durations, gap, active],
    );
    if (r.rowCount === 0) throw new DastarError("not_found", "schedule not found");
    return scheduleView(r.rows[0]);
  });
}

/**
 * Blackouts overlapping [from, to), inactive ones included, by start and id: at most BOUNDS.blackoutListing.rows of them,
 * over a window of at most BOUNDS.blackoutListing.windowDays days. A window that is empty, reversed, or longer is
 * `invalid_input`.
 */
export async function listBlackouts(client: ClientBase, venueId: string, input: ListBlackoutsInput): Promise<BlackoutView[]> {
  const from = instant("from", input.from); const to = instant("to", input.to);
  if (from.getTime() >= to.getTime()) throw invalid("from must be before to");
  if (to.getTime() - from.getTime() > BOUNDS.blackoutListing.windowDays * DAY_MS) {
    throw invalid(`the window is at most ${BOUNDS.blackoutListing.windowDays} days`);
  }
  return adminRead(client, venueId, async () => {
    const r = await client.query(
      `select ${BLACKOUT_COLUMNS} from dastar.blackout
        where venue_id = $1 and during && tstzrange($2::timestamptz, $3::timestamptz)
        order by lower(during), id limit ${BOUNDS.blackoutListing.rows}`,
      [venueId, from.toISOString(), to.toISOString()],
    );
    return r.rows.map(blackoutView);
  });
}

/**
 * A blackout that is active strands the live reservations with an active unit row over its range (the blackout guard's
 * set), read earliest start first; an inactive one is written without judgment. The range is half-open and fixed.
 */
export async function createBlackout(client: ClientBase, ctx: AdminContext, input: CreateBlackoutInput): Promise<AdminOutcome<BlackoutView>> {
  const [startsAt, endsAt] = checkRange(input.startsAt, input.endsAt);
  const reason = checkReason(input.reason);
  const active = input.active === undefined ? true : checkActive(input.active);
  return adminWrite(client, ctx, async () => {
    const stranded = !active ? [] : strandedOf((await client.query(
      `select ${STRANDED_COLUMNS} from dastar.reservation r
        where r.venue_id = $1 and ${LIVE}
          and exists (select 1 from dastar.occupancy o where o.reservation_id = r.id and o.during && tstzrange($2::timestamptz, $3::timestamptz))
        ${STRANDED_TAIL}`,
      [ctx.venueId, startsAt, endsAt],
    )).rows);
    const settled = await settleStranded(client, ctx, stranded, "blackout_conflict", "this blackout", input);
    if (!settled.ok) return settled;

    const ins = await client.query(
      `insert into dastar.blackout (venue_id, during, reason, active)
       values ($1, tstzrange($2::timestamptz, $3::timestamptz), $4, $5) returning ${BLACKOUT_COLUMNS}`,
      [ctx.venueId, startsAt, endsAt, reason, active],
    );
    return { ok: true, value: blackoutView(ins.rows[0]), cancelled: settled.cancelled };
  });
}

/**
 * Only activating an inactive blackout is judged, against its stored range; a change of reason, a deactivation, and
 * setting active on an active blackout strand nothing. `not_found` for a blackout of another venue.
 */
export async function updateBlackout(client: ClientBase, ctx: AdminContext, input: UpdateBlackoutInput): Promise<AdminOutcome<BlackoutView>> {
  const reason = input.reason === undefined ? undefined : checkReason(input.reason);
  const active = input.active === undefined ? undefined : checkActive(input.active);
  return adminWrite(client, ctx, async () => {
    const found = await client.query(`select ${BLACKOUT_COLUMNS} from dastar.blackout where id = $1 and venue_id = $2`, [input.blackoutId, ctx.venueId]);
    if (found.rowCount === 0) throw new DastarError("not_found", "blackout not found");
    const cur = blackoutView(found.rows[0]);
    const next = { reason: reason ?? cur.reason, active: active ?? cur.active };
    const activating = !cur.active && next.active;
    const stranded = !activating ? [] : strandedOf((await client.query(
      `select ${STRANDED_COLUMNS} from dastar.reservation r
        where r.venue_id = $1 and ${LIVE}
          and exists (select 1 from dastar.occupancy o where o.reservation_id = r.id
                       and o.during && (select b.during from dastar.blackout b where b.id = $2))
        ${STRANDED_TAIL}`,
      [ctx.venueId, input.blackoutId],
    )).rows);
    const settled = await settleStranded(client, ctx, stranded, "blackout_conflict", "this blackout", input);
    if (!settled.ok) return settled;

    const upd = await client.query(
      `update dastar.blackout set reason = $3, active = $4 where id = $1 and venue_id = $2 returning ${BLACKOUT_COLUMNS}`,
      [input.blackoutId, ctx.venueId, next.reason, next.active],
    );
    return { ok: true, value: blackoutView(upd.rows[0]), cancelled: settled.cancelled };
  });
}

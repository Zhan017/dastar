import type { ClientBase } from "pg";
import { BOUNDS, DastarError, computeAvailability, type ComboSnapshot, type RankingStrategy, type Slot, type UnitSnapshot } from "@dastar/core";
import { asDastarError } from "../errors.js";
import { bindVenue } from "../context.js";

export type AvailabilityInput = { venueId: string; partySize: number; from: string; to: string; limit?: number; ranking?: RankingStrategy };
export type AvailabilityResult = { slots: Slot[]; truncated: boolean };

/**
 * The venue's service periods overlapping [$2, $3) as instants, converted with the venue's zone by Postgres: a
 * local time in a spring gap takes the offset before the transition, an ambiguous autumn time the offset after it.
 * Local dates run from the day before $2's, so an overnight period begun the previous evening is included.
 */
export const PERIODS_SQL = `select s.id as schedule_id,
       ((d.local_date + s.opens) at time zone v.timezone) as starts_at,
       (((d.local_date + case when s.closes_next_day then 1 else 0 end) + s.closes) at time zone v.timezone) as ends_at,
       s.duration_by_size, s.gap_minutes
  from dastar.venue v
  cross join lateral generate_series(0, ($3::timestamptz at time zone v.timezone)::date - ($2::timestamptz at time zone v.timezone)::date + 1) as g(i)
  cross join lateral (select ($2::timestamptz at time zone v.timezone)::date - 1 + g.i as local_date) d
  join dastar.schedule s on s.venue_id = v.id and s.active and s.day_of_week = extract(isodow from d.local_date)::int
 where v.id = $1
   and (((d.local_date + case when s.closes_next_day then 1 else 0 end) + s.closes) at time zone v.timezone) > $2::timestamptz
   and ((d.local_date + s.opens) at time zone v.timezone) < $3::timestamptz
 order by starts_at, schedule_id`;

/** Active unit rows of the bound venue over [$1, $2), except those of reservations expired by effective status. */
export const OCCUPANCY_SQL = `select o.unit_id, lower(o.during) as starts_at, upper(o.during) as ends_at
  from dastar.occupancy o join dastar.reservation r on r.id = o.reservation_id
 where o.during && tstzrange($1::timestamptz, $2::timestamptz)
   and dastar.effective_status(r.status, r.hold_expires_at) <> 'expired'`;

/** The venue's active blackouts over [$2, $3). */
export const CLOSURES_SQL = `select lower(during) as starts_at, upper(during) as ends_at
  from dastar.blackout where venue_id = $1 and active and during && tstzrange($2::timestamptz, $3::timestamptz)`;

const VENUE_SQL = "select slot_minutes, availability_window_days, config_version, dastar.dastar_now() as now from dastar.venue where id = $1";
const UNITS_SQL = "select id, label, capacity_min, capacity_max, active from dastar.unit where venue_id = $1";
const COMBOS_SQL = "select id, label, unit_ids, capacity_min, capacity_max, active from dastar.unit_combo where venue_id = $1";

type Snapshot = { units: UnitSnapshot[]; combos: ComboSnapshot[] };

/**
 * A venue's units and combos for one config version. Every write to either bumps the version (t46), and the version
 * is read in the same repeatable-read transaction that loads them, so an entry is never stale for its key. One entry
 * per venue, the most recently used kept, at most `max` venues.
 */
export class SnapshotCache {
  private readonly entries = new Map<string, { version: string; snapshot: Snapshot }>();
  constructor(private readonly max = 64) {}
  get(venueId: string, version: string): Snapshot | undefined {
    const hit = this.entries.get(venueId);
    if (!hit || hit.version !== version) return undefined;
    this.entries.delete(venueId);
    this.entries.set(venueId, hit);
    return hit.snapshot;
  }
  set(venueId: string, version: string, snapshot: Snapshot): void {
    this.entries.delete(venueId);
    this.entries.set(venueId, { version, snapshot });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }
  get size(): number { return this.entries.size; }
}

const HOUR = 3_600_000;

/**
 * Bookable starts for a party in [from, to), read in one repeatable-read transaction bound to the venue. Advisory:
 * a hold is still the judge. The window may not be longer than the venue's availability_window_days
 * (`window_too_large`); an empty window or a party below 1 has no slots.
 */
export async function availability(client: ClientBase, input: AvailabilityInput, cache?: SnapshotCache): Promise<AvailabilityResult> {
  const from = new Date(input.from);
  const to = new Date(input.to);
  const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? BOUNDS.availabilityResults.default)), BOUNDS.availabilityResults.max);
  await client.query("begin isolation level repeatable read read only");
  try {
    await bindVenue(client, input.venueId);
    const v = await client.query(VENUE_SQL, [input.venueId]);
    if (v.rowCount === 0) throw new DastarError("not_found", "venue not found");
    const venue = v.rows[0] as { slot_minutes: number; availability_window_days: number; config_version: string; now: Date };
    if (to.getTime() - from.getTime() > venue.availability_window_days * 24 * HOUR) {
      throw new DastarError("window_too_large", `the window is longer than the venue's ${venue.availability_window_days} days`);
    }
    if (!(to.getTime() > from.getTime()) || !(input.partySize >= 1)) {
      await client.query("commit");
      return { slots: [], truncated: false };
    }
    const version = String(venue.config_version);
    let snapshot = cache?.get(input.venueId, version);
    if (!snapshot) {
      const units = await client.query(UNITS_SQL, [input.venueId]);
      const combos = await client.query(COMBOS_SQL, [input.venueId]);
      snapshot = {
        units: units.rows.map((r) => ({ id: r.id, label: r.label, capacityMin: r.capacity_min, capacityMax: r.capacity_max, active: r.active })),
        combos: combos.rows.map((r) => ({ id: r.id, label: r.label, unitIds: r.unit_ids as string[], capacityMin: r.capacity_min, capacityMax: r.capacity_max, active: r.active })),
      };
      cache?.set(input.venueId, version, snapshot);
    }
    const periods = await client.query(PERIODS_SQL, [input.venueId, from.toISOString(), to.toISOString()]);
    const closures = await client.query(CLOSURES_SQL, [input.venueId, from.toISOString(), new Date(to.getTime() + 12 * HOUR).toISOString()]);
    // the gap and the duration are each at most 720 minutes, so a padded booking starting in [from, to) lies in this range
    const busy = await client.query(OCCUPANCY_SQL, [new Date(from.getTime() - 12 * HOUR).toISOString(), new Date(to.getTime() + 24 * HOUR).toISOString()]);
    await client.query("commit");
    return computeAvailability({
      partySize: input.partySize, from, to, now: new Date(venue.now), slotMinutes: venue.slot_minutes, limit,
      periods: periods.rows.map((r) => ({ scheduleId: r.schedule_id, startsAt: new Date(r.starts_at), endsAt: new Date(r.ends_at), durationBySize: r.duration_by_size, gapMinutes: r.gap_minutes })),
      units: snapshot.units, combos: snapshot.combos,
      closures: closures.rows.map((r) => ({ startsAt: new Date(r.starts_at), endsAt: new Date(r.ends_at) })),
      busy: busy.rows.map((r) => ({ unitId: r.unit_id, startsAt: new Date(r.starts_at), endsAt: new Date(r.ends_at) })),
      ...(input.ranking ? { ranking: input.ranking } : {}),
    });
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw asDastarError(e);
  }
}

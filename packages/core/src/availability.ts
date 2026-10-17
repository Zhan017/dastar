import type { Assignment } from "./reservation.js";
import { BOUNDS } from "./bounds.js";

/** A service period as instants, computed by the database from a schedule row in the venue's zone. */
export type ServicePeriod = { scheduleId: string; startsAt: Date; endsAt: Date; durationBySize: Record<string, number>; gapMinutes: number };
export type UnitSnapshot = { id: string; label: string; capacityMin: number; capacityMax: number; active: boolean };
export type ComboSnapshot = { id: string; label: string; unitIds: string[]; capacityMin: number; capacityMax: number; active: boolean };
/** An active unit row whose reservation is not expired by effective status. */
export type Busy = { unitId: string; startsAt: Date; endsAt: Date };
/** An active blackout. */
export type Closure = { startsAt: Date; endsAt: Date };
/** Exactly what a hold accepts for this party. */
export type Slot = { startsAt: string; durationMinutes: number; assignment: Assignment };
export type Candidate = { assignment: Assignment; label: string; capacityMax: number; unitIds: string[] };
export type RankingContext = {
  /** The range the booking would take, padded by the period's gap on both sides. */
  paddedFrom: Date;
  paddedTo: Date;
  /** True when none of the units has busy time overlapping [from, to). */
  isFree: (unitIds: readonly string[], from: Date, to: Date) => boolean;
  /** Active combos whose member units are all active. */
  combos: readonly ComboSnapshot[];
};
export type RankingStrategy = { name: string; choose: (free: readonly Candidate[], ctx: RankingContext) => Candidate | null };

const MINUTE = 60_000;

/** The duration of the smallest party-size key at or above the party; null when every key is smaller. */
export function durationFor(durationBySize: Record<string, number>, partySize: number): number | null {
  let best: number | null = null;
  let bestSize = Infinity;
  for (const [key, minutes] of Object.entries(durationBySize)) {
    const size = Number(key);
    if (Number.isInteger(size) && size >= partySize && size < bestSize) { bestSize = size; best = minutes; }
  }
  return best;
}

/** Starts on the slot grid from the period's opening whose booking ends by its close; a RangeError unless the grid step is positive. */
export function slotStarts(period: { startsAt: Date; endsAt: Date }, slotMinutes: number, durationMinutes: number): Date[] {
  if (!(slotMinutes > 0)) throw new RangeError("slotMinutes must be a positive number of minutes");
  const out: Date[] = [];
  const last = period.endsAt.getTime() - durationMinutes * MINUTE;
  for (let t = period.startsAt.getTime(); t <= last; t += slotMinutes * MINUTE) out.push(new Date(t));
  return out;
}

/** Active combos whose member units all exist among `units` and are active. */
export function usableCombos(units: readonly UnitSnapshot[], combos: readonly ComboSnapshot[]): ComboSnapshot[] {
  const active = new Set(units.filter((u) => u.active).map((u) => u.id));
  return combos.filter((c) => c.active && c.unitIds.every((id) => active.has(id)));
}

/** Active units, then usable combos, whose capacity range includes the party. */
export function fittingCandidates(units: readonly UnitSnapshot[], combos: readonly ComboSnapshot[], partySize: number): Candidate[] {
  const out: Candidate[] = [];
  for (const u of units) {
    if (u.active && u.capacityMin <= partySize && partySize <= u.capacityMax) {
      out.push({ assignment: { kind: "unit", id: u.id }, label: u.label, capacityMax: u.capacityMax, unitIds: [u.id] });
    }
  }
  for (const c of usableCombos(units, combos)) {
    if (c.capacityMin <= partySize && partySize <= c.capacityMax) {
      out.push({ assignment: { kind: "combo", id: c.id }, label: c.label, capacityMax: c.capacityMax, unitIds: [...c.unitIds] });
    }
  }
  return out;
}

type RankKey = { capacity: number; kind: number; broken: number; label: string; id: string };
function compareKeys(a: RankKey, b: RankKey): number {
  const byNumber = a.capacity - b.capacity || a.kind - b.kind || a.broken - b.broken;
  if (byNumber !== 0) return byNumber;
  if (a.label !== b.label) return a.label < b.label ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * Smallest fitting capacity first, a unit before a combo, then for units the fewest free combos broken: a combo
 * that contains the unit and is entirely free over the same padded range, which booking the unit would take away
 * from a larger party. Label, then id, settle ties, so the choice is deterministic.
 */
export const restaurantHost: RankingStrategy = {
  name: "restaurantHost",
  choose(free, ctx) {
    let best: Candidate | null = null;
    let bestKey: RankKey | null = null;
    for (const c of free) {
      const unit = c.assignment.kind === "unit" ? c.unitIds[0]! : null;
      const broken = unit === null ? 0 : ctx.combos.filter((k) => k.unitIds.includes(unit) && ctx.isFree(k.unitIds, ctx.paddedFrom, ctx.paddedTo)).length;
      const key: RankKey = { capacity: c.capacityMax, kind: unit === null ? 1 : 0, broken, label: c.label, id: c.assignment.id };
      if (bestKey === null || compareKeys(key, bestKey) < 0) { best = c; bestKey = key; }
    }
    return best;
  },
};

type Interval = { s: number; e: number };
function indexBusy(busy: readonly Busy[]): Map<string, Interval[]> {
  const byUnit = new Map<string, Interval[]>();
  for (const b of busy) {
    const list = byUnit.get(b.unitId) ?? [];
    list.push({ s: b.startsAt.getTime(), e: b.endsAt.getTime() });
    byUnit.set(b.unitId, list);
  }
  for (const list of byUnit.values()) list.sort((a, b) => a.s - b.s);
  return byUnit;
}
/** Active unit rows of one unit never overlap (the exclusion constraint), so sorted by start they are sorted by end. */
function unitFree(list: Interval[] | undefined, from: number, to: number): boolean {
  if (!list) return true;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.e <= from) lo = mid + 1; else hi = mid;
  }
  return lo === list.length || list[lo]!.s >= to;
}

export type AvailabilityComputation = {
  partySize: number; from: Date; to: Date; now: Date; slotMinutes: number;
  periods: readonly ServicePeriod[]; units: readonly UnitSnapshot[]; combos: readonly ComboSnapshot[];
  closures: readonly Closure[]; busy: readonly Busy[]; limit: number; ranking?: RankingStrategy;
};

/**
 * One slot per start in [from, to) at or after `now`, in start order. A start belongs to the first period, by opening
 * and then schedule id, that admits it. A start whose booking overlaps a closure is dropped; an assignment is free
 * when its units are free over the booking padded by the period's gap. Stops at `limit` slots, or after
 * BOUNDS.availabilityStartsExamined starts, and says so with `truncated`.
 */
export function computeAvailability(i: AvailabilityComputation): { slots: Slot[]; truncated: boolean } {
  const ranking = i.ranking ?? restaurantHost;
  const candidates = fittingCandidates(i.units, i.combos, i.partySize);
  const combos = usableCombos(i.units, i.combos);
  const busy = indexBusy(i.busy);
  const isFree = (unitIds: readonly string[], from: Date, to: Date): boolean =>
    unitIds.every((u) => unitFree(busy.get(u), from.getTime(), to.getTime()));

  const ordered = [...i.periods].sort((a, b) =>
    a.startsAt.getTime() - b.startsAt.getTime() || (a.scheduleId < b.scheduleId ? -1 : a.scheduleId > b.scheduleId ? 1 : 0));
  const byStart = new Map<number, { period: ServicePeriod; duration: number }>();
  for (const p of ordered) {
    const duration = durationFor(p.durationBySize, i.partySize);
    if (duration === null) continue;
    for (const s of slotStarts(p, i.slotMinutes, duration)) {
      const t = s.getTime();
      if (t < i.from.getTime() || t >= i.to.getTime() || t < i.now.getTime()) continue;
      if (!byStart.has(t)) byStart.set(t, { period: p, duration });
    }
  }

  const slots: Slot[] = [];
  let truncated = false;
  let examined = 0;
  for (const t of [...byStart.keys()].sort((a, b) => a - b)) {
    if (examined >= BOUNDS.availabilityStartsExamined) { truncated = true; break; }
    examined += 1;
    const { period, duration } = byStart.get(t)!;
    const end = t + duration * MINUTE;
    if (i.closures.some((c) => c.startsAt.getTime() < end && c.endsAt.getTime() > t)) continue;
    const gap = period.gapMinutes * MINUTE;
    const paddedFrom = new Date(t - gap);
    const paddedTo = new Date(end + gap);
    const free = candidates.filter((c) => isFree(c.unitIds, paddedFrom, paddedTo));
    if (free.length === 0) continue;
    if (slots.length >= i.limit) { truncated = true; break; }
    const chosen = ranking.choose(free, { paddedFrom, paddedTo, isFree, combos });
    if (chosen === null) continue;
    slots.push({ startsAt: new Date(t).toISOString(), durationMinutes: duration, assignment: chosen.assignment });
  }
  return { slots, truncated };
}

import type { HoldInput } from "@dastar/db";
import type { BenchSeed } from "./seed.js";
import type { Rng } from "./rng.js";

/** The four request shapes of the design's workload target (system design, section 6.5). */
export type Mix = "overlapping" | "distinct_dates" | "disjoint_units" | "combos";
export const MIXES: readonly Mix[] = ["overlapping", "distinct_dates", "disjoint_units", "combos"];
export type Blend = Record<Mix, number>;
export const TARGET_BLEND: Blend = { overlapping: 0.4, distinct_dates: 0.3, disjoint_units: 0.2, combos: 0.1 };

export function parseBlend(text: string): Blend {
  if (text === "target") return TARGET_BLEND;
  if ((MIXES as readonly string[]).includes(text)) {
    return { overlapping: 0, distinct_dates: 0, disjoint_units: 0, combos: 0, [text]: 1 } as Blend;
  }
  throw new Error(`blend must be "target" or one of ${MIXES.join(", ")}`);
}

export function pickMix(blend: Blend, r: Rng): Mix {
  const total = MIXES.reduce((s, m) => s + blend[m], 0);
  let x = r.next() * total;
  for (const m of MIXES) {
    x -= blend[m];
    if (x < 0) return m;
  }
  return MIXES[MIXES.length - 1]!;
}

const DAY = 86_400_000;
const RUSH_EVENING = Date.UTC(2046, 0, 1, 18);
const UNIT_DATES_FROM = Date.UTC(2047, 0, 1, 19);
const COMBO_DATES_FROM = Date.UTC(2050, 0, 1, 19);

/**
 * Builds hold requests for one venue.
 *  - overlapping: the ten most popular units, sixteen 15-minute start times on one evening, 90 minutes each,
 *    so neighbours collide and most requests lose;
 *  - distinct_dates: the same ten units, every request on its own day, so nothing conflicts and the only
 *    shared resource is the unit's advisory lock;
 *  - disjoint_units: the remaining units, every request on its own day;
 *  - combos: a pair combo on its own day, in a date range no unit request uses.
 */
export function holdFactory(seed: BenchSeed, r: Rng, runId: string): (mix: Mix, seq: number) => HoldInput {
  if (seed.units.length < 20 || seed.combos.length < 1) throw new Error("workload: needs at least 20 units and one combo");
  const popular = seed.units.slice(0, 10);
  const others = seed.units.slice(10);
  const nextDay = new Map<string, number>();
  const ownDay = (id: string, from: number): string => {
    const d = nextDay.get(id) ?? 0;
    nextDay.set(id, d + 1);
    return new Date(from + d * DAY).toISOString();
  };
  return (mix, seq) => {
    const base = { venueId: seed.venue, actor: `${runId}:${seq}`, traceId: `${runId}-h${seq}`, idempotencyKey: `${runId}-h${seq}`, durationMinutes: 90 };
    if (mix === "overlapping") {
      return { ...base, partySize: 2, startsAt: new Date(RUSH_EVENING + r.int(16) * 900_000).toISOString(), assignment: { kind: "unit", id: r.pick(popular) } };
    }
    if (mix === "distinct_dates") {
      const unit = r.pick(popular);
      return { ...base, partySize: 2, startsAt: ownDay(unit, UNIT_DATES_FROM), assignment: { kind: "unit", id: unit } };
    }
    if (mix === "disjoint_units") {
      const unit = r.pick(others);
      return { ...base, partySize: 2, startsAt: ownDay(unit, UNIT_DATES_FROM), assignment: { kind: "unit", id: unit } };
    }
    const combo = r.pick(seed.combos);
    return { ...base, partySize: 6, startsAt: ownDay(combo, COMBO_DATES_FROM), assignment: { kind: "combo", id: combo } };
  };
}

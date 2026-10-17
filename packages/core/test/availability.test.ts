import { describe, it, expect } from "vitest";
import {
  BOUNDS, durationFor, slotStarts, fittingCandidates, restaurantHost, computeAvailability,
  type AvailabilityComputation, type Busy, type Candidate, type ComboSnapshot, type RankingContext, type ServicePeriod, type UnitSnapshot,
} from "../src/index.js";

const MINUTE = 60_000;
const at = (y: number, mo: number, d: number, h = 0, mi = 0): Date => new Date(Date.UTC(y, mo - 1, d, h, mi));
const iso = (y: number, mo: number, d: number, h = 0, mi = 0): string => at(y, mo, d, h, mi).toISOString();

const unit = (id: string, label: string, capacityMin: number, capacityMax: number, active = true): UnitSnapshot =>
  ({ id, label, capacityMin, capacityMax, active });
const combo = (id: string, label: string, unitIds: string[], capacityMin: number, capacityMax: number, active = true): ComboSnapshot =>
  ({ id, label, unitIds, capacityMin, capacityMax, active });

describe("durationFor", () => {
  it("takes the smallest party-size key at or above the party, and none when every key is smaller", () => {
    const d = { "2": 90, "4": 120 };
    expect([1, 2, 3, 4, 5].map((n) => durationFor(d, n))).toEqual([90, 90, 120, 120, null]);
  });

  it("does not depend on the order of the keys", () => {
    const d = { "6": 150, "2": 90 };
    expect(durationFor(d, 3)).toBe(150);
    expect(durationFor(d, 2)).toBe(90);
    expect(durationFor(d, 7)).toBeNull();
  });

  it("ignores a key that is not a whole number", () => {
    expect(durationFor({ "x": 10, "2.5": 20, "4": 120 }, 1)).toBe(120);
  });
});

describe("slotStarts", () => {
  it("lists the grid starts from the opening whose booking ends by the close", () => {
    const starts = slotStarts({ startsAt: at(2060, 6, 1, 17), endsAt: at(2060, 6, 1, 23) }, 15, 90);
    expect(starts).toHaveLength(19);
    expect(starts[0]).toEqual(at(2060, 6, 1, 17));
    expect(starts[starts.length - 1]).toEqual(at(2060, 6, 1, 21, 30));
    expect(starts.every((s, k) => k === 0 || s.getTime() - starts[k - 1]!.getTime() === 15 * MINUTE)).toBe(true);
  });

  it("throws a RangeError for a slot length that is zero, negative, or not a number, instead of looping", () => {
    const period = { startsAt: at(2060, 6, 1, 17), endsAt: at(2060, 6, 1, 23) };
    for (const slotMinutes of [0, -15, Number.NaN]) {
      expect(() => slotStarts(period, slotMinutes, 90), `slotMinutes ${slotMinutes}`).toThrow(RangeError);
    }
  });

  it("offers nothing when the period is shorter than the duration", () => {
    expect(slotStarts({ startsAt: at(2060, 6, 1, 17), endsAt: at(2060, 6, 1, 18) }, 15, 90)).toEqual([]);
  });

  it("offers one start when the period is exactly the duration", () => {
    expect(slotStarts({ startsAt: at(2060, 6, 1, 17), endsAt: at(2060, 6, 1, 18, 30) }, 15, 90)).toEqual([at(2060, 6, 1, 17)]);
  });
});

describe("fittingCandidates", () => {
  const ids = (cs: Candidate[]) => cs.map((c) => `${c.assignment.kind}:${c.assignment.id}`);

  it("includes both ends of a capacity range", () => {
    const units = [unit("a", "A", 2, 4)];
    const combos = [combo("k", "K", ["a", "b"], 5, 8)];
    const all = [unit("a", "A", 2, 4), unit("b", "B", 2, 4)];
    expect([1, 2, 4, 5].map((n) => ids(fittingCandidates(units, [], n)))).toEqual([[], ["unit:a"], ["unit:a"], []]);
    expect([4, 5, 8, 9].map((n) => ids(fittingCandidates(all, combos, n)))).toEqual([["unit:a", "unit:b"], ["combo:k"], ["combo:k"], []]);
  });

  it("leaves out an inactive unit", () => {
    expect(ids(fittingCandidates([unit("a", "A", 1, 4, false), unit("b", "B", 1, 4)], [], 2))).toEqual(["unit:b"]);
  });

  it("leaves out an inactive combo", () => {
    const units = [unit("a", "A", 1, 2), unit("b", "B", 1, 2)];
    expect(ids(fittingCandidates(units, [combo("k", "K", ["a", "b"], 3, 4, false)], 3))).toEqual([]);
  });

  it("leaves out a combo with an inactive member", () => {
    const units = [unit("a", "A", 1, 2), unit("b", "B", 1, 2, false)];
    expect(ids(fittingCandidates(units, [combo("k", "K", ["a", "b"], 3, 4)], 3))).toEqual([]);
  });

  it("leaves out a combo with a member that is not among the units", () => {
    const units = [unit("a", "A", 1, 2)];
    expect(ids(fittingCandidates(units, [combo("k", "K", ["a", "ghost"], 3, 4)], 3))).toEqual([]);
  });

  it("lists the units before the combos, and describes each candidate", () => {
    const units = [unit("a", "A", 1, 4), unit("b", "B", 1, 4)];
    const found = fittingCandidates(units, [combo("k", "K", ["a", "b"], 3, 6)], 3);
    expect(ids(found)).toEqual(["unit:a", "unit:b", "combo:k"]);
    expect(found).toEqual([
      { assignment: { kind: "unit", id: "a" }, label: "A", capacityMax: 4, unitIds: ["a"] },
      { assignment: { kind: "unit", id: "b" }, label: "B", capacityMax: 4, unitIds: ["b"] },
      { assignment: { kind: "combo", id: "k" }, label: "K", capacityMax: 6, unitIds: ["a", "b"] },
    ]);
  });
});

describe("restaurantHost", () => {
  const cand = (kind: "unit" | "combo", id: string, label: string, capacityMax: number, unitIds: string[] = [id]): Candidate =>
    ({ assignment: { kind, id }, label, capacityMax, unitIds });
  const ctx = (combos: ComboSnapshot[] = [], busyUnits: string[] = []): RankingContext => ({
    paddedFrom: at(2060, 6, 1, 18), paddedTo: at(2060, 6, 1, 20),
    isFree: (unitIds) => unitIds.every((u) => !busyUnits.includes(u)),
    combos,
  });
  const pick = (free: Candidate[], c: RankingContext = ctx()) => restaurantHost.choose(free, c)?.assignment.id;

  it("chooses nothing from nothing", () => {
    expect(restaurantHost.choose([], ctx())).toBeNull();
  });

  it("prefers the smaller capacity, whatever the label", () => {
    const big = cand("unit", "big", "A", 4);
    const small = cand("unit", "small", "B", 2);
    expect(pick([big, small])).toBe("small");
    expect(pick([small, big])).toBe("small");
  });

  it("prefers a unit to a combo of the same capacity", () => {
    const k = cand("combo", "k", "A", 4, ["x", "y"]);
    const u = cand("unit", "u", "Z", 4);
    expect(pick([k, u])).toBe("u");
    expect(pick([u, k])).toBe("u");
  });

  it("prefers the unit that breaks fewer free combos", () => {
    const t1 = cand("unit", "t1", "T1", 4);
    const t2 = cand("unit", "t2", "T2", 4);
    const withT1 = combo("k1", "K1", ["t1", "t3"], 5, 8);
    expect(pick([t1, t2], ctx([withT1]))).toBe("t2");
    expect(pick([t2, t1], ctx([withT1]))).toBe("t2");
    const alsoT1 = combo("k2", "K2", ["t1", "t4"], 5, 8);
    const alsoT2 = combo("k3", "K3", ["t2", "t5"], 5, 8);
    expect(pick([t1, t2], ctx([withT1, alsoT1, alsoT2]))).toBe("t2");
  });

  it("falls back to label order when the combo that would be broken is not free", () => {
    const t1 = cand("unit", "t1", "T1", 4);
    const t2 = cand("unit", "t2", "T2", 4);
    const withT1 = combo("k1", "K1", ["t1", "t3"], 5, 8);
    expect(pick([t2, t1], ctx([withT1], ["t3"]))).toBe("t1");
  });

  it("settles a tie by label, then by id", () => {
    expect(pick([cand("unit", "a", "T2", 4), cand("unit", "b", "T1", 4)])).toBe("b");
    expect(pick([cand("unit", "b", "T1", 4), cand("unit", "a", "T2", 4)])).toBe("b");
    expect(pick([cand("unit", "b", "T1", 4), cand("unit", "a", "T1", 4)])).toBe("a");
    expect(pick([cand("unit", "a", "T1", 4), cand("unit", "b", "T1", 4)])).toBe("a");
  });
});

describe("computeAvailability", () => {
  const period = (scheduleId: string, startsAt: Date, endsAt: Date, durationBySize: Record<string, number>, gapMinutes = 0): ServicePeriod =>
    ({ scheduleId, startsAt, endsAt, durationBySize, gapMinutes });
  const busy = (unitId: string, from: Date, to: Date): Busy => ({ unitId, startsAt: from, endsAt: to });
  const evening = (durationBySize: Record<string, number> = { "4": 60 }, gapMinutes = 0) =>
    period("s1", at(2060, 6, 1, 17), at(2060, 6, 1, 23), durationBySize, gapMinutes);
  const run = (over: Partial<AvailabilityComputation> = {}) => computeAvailability({
    partySize: 2, from: at(2060, 6, 1, 0), to: at(2060, 6, 2, 0), now: at(2060, 1, 1), slotMinutes: 30,
    periods: [evening()], units: [unit("u1", "T1", 1, 4)], combos: [], closures: [], busy: [], limit: BOUNDS.availabilityResults.max,
    ...over,
  });
  const starts = (r: { slots: { startsAt: string }[] }) => r.slots.map((s) => s.startsAt);

  it("gives a start in two periods to the one that opens first, with its duration, and lists it once", () => {
    const early = period("s2", at(2060, 6, 1, 17), at(2060, 6, 1, 20), { "4": 60 });
    const late = period("s1", at(2060, 6, 1, 18), at(2060, 6, 1, 22), { "4": 120 });
    for (const periods of [[early, late], [late, early]]) {
      const r = run({ periods, slotMinutes: 60 });
      expect(r.slots.map((s) => [s.startsAt, s.durationMinutes])).toEqual([
        [iso(2060, 6, 1, 17), 60], [iso(2060, 6, 1, 18), 60], [iso(2060, 6, 1, 19), 60], [iso(2060, 6, 1, 20), 120],
      ]);
    }
  });

  it("breaks a tie between periods that open together by schedule id", () => {
    const a = period("a", at(2060, 6, 1, 17), at(2060, 6, 1, 19), { "4": 60 });
    const b = period("b", at(2060, 6, 1, 17), at(2060, 6, 1, 19), { "4": 90 });
    for (const periods of [[a, b], [b, a]]) {
      const r = run({ periods, slotMinutes: 60 });
      expect(r.slots.map((s) => [s.startsAt, s.durationMinutes])).toEqual([[iso(2060, 6, 1, 17), 60], [iso(2060, 6, 1, 18), 60]]);
    }
  });

  it("offers nothing from a period that has no duration for the party", () => {
    const small = period("s1", at(2060, 6, 1, 17), at(2060, 6, 1, 19), { "2": 60 });
    const big = period("s2", at(2060, 6, 1, 17), at(2060, 6, 1, 19), { "6": 60 });
    const r = run({ partySize: 4, periods: [small, big], slotMinutes: 60, units: [unit("u1", "T1", 1, 6)] });
    expect(starts(r)).toEqual([iso(2060, 6, 1, 17), iso(2060, 6, 1, 18)]);
  });

  it("offers no slots to a party above every duration key", () => {
    const r = run({ partySize: 5, periods: [evening({ "2": 90, "4": 120 })], units: [unit("u1", "T1", 1, 8)] });
    expect(r).toEqual({ slots: [], truncated: false });
  });

  it("drops a start whose booking overlaps a closure, and keeps one that only touches it", () => {
    const r = run({ slotMinutes: 60, periods: [period("s1", at(2060, 6, 1, 17), at(2060, 6, 1, 21), { "4": 60 })],
      closures: [{ startsAt: at(2060, 6, 1, 19), endsAt: at(2060, 6, 1, 20) }] });
    expect(starts(r)).toEqual([iso(2060, 6, 1, 17), iso(2060, 6, 1, 18), iso(2060, 6, 1, 20)]);
  });

  it("drops a start whose booking a closure overlaps, however the closure sits in it", () => {
    const p = period("s1", at(2060, 6, 1, 17), at(2060, 6, 1, 21), { "4": 60 });
    const inside = run({ slotMinutes: 60, periods: [p], closures: [{ startsAt: at(2060, 6, 1, 18, 20), endsAt: at(2060, 6, 1, 18, 40) }] });
    expect(starts(inside)).toEqual([iso(2060, 6, 1, 17), iso(2060, 6, 1, 19), iso(2060, 6, 1, 20)]);
    const wide = run({ slotMinutes: 60, periods: [p], closures: [{ startsAt: at(2060, 6, 1, 17, 30), endsAt: at(2060, 6, 1, 20, 30) }] });
    expect(starts(wide)).toEqual([]);
  });

  describe("gap", () => {
    const wide = period("s1", at(2060, 6, 1, 17), at(2060, 6, 1, 23), { "4": 60 }, 15);
    const five = { slotMinutes: 5 };

    it("blocks a start that begins less than the gap after a booking, and allows one that begins the gap after", () => {
      const rows = [busy("u1", at(2060, 6, 1, 18), at(2060, 6, 1, 19))];
      const r = starts(run({ ...five, periods: [wide], busy: rows }));
      expect(r).not.toContain(iso(2060, 6, 1, 19, 10));
      expect(r).toContain(iso(2060, 6, 1, 19, 15));
      const none = starts(run({ ...five, periods: [period("s1", at(2060, 6, 1, 17), at(2060, 6, 1, 23), { "4": 60 }, 0)], busy: rows }));
      expect(none).toContain(iso(2060, 6, 1, 19, 10));
    });

    it("blocks a start that ends less than the gap before a booking, and allows one that ends the gap before", () => {
      const rows = [busy("u1", at(2060, 6, 1, 20), at(2060, 6, 1, 21))];
      const r = starts(run({ ...five, periods: [wide], busy: rows }));
      expect(r).not.toContain(iso(2060, 6, 1, 18, 50));
      expect(r).toContain(iso(2060, 6, 1, 18, 45));
      const none = starts(run({ ...five, periods: [period("s1", at(2060, 6, 1, 17), at(2060, 6, 1, 23), { "4": 60 }, 0)], busy: rows }));
      expect(none).toContain(iso(2060, 6, 1, 18, 50));
    });

    it("uses the gap of the period that owns the start", () => {
      const tight = period("s1", at(2060, 6, 1, 17), at(2060, 6, 1, 20), { "4": 60 }, 0);
      const loose = period("s2", at(2060, 6, 1, 20), at(2060, 6, 1, 23, 30), { "4": 60 }, 30);
      const rows = [busy("u1", at(2060, 6, 1, 18), at(2060, 6, 1, 19)), busy("u1", at(2060, 6, 1, 21), at(2060, 6, 1, 22))];
      const r = starts(run({ ...five, periods: [tight, loose], busy: rows }));
      expect(r).toContain(iso(2060, 6, 1, 19));
      expect(r).not.toContain(iso(2060, 6, 1, 22));
      expect(r).toContain(iso(2060, 6, 1, 22, 30));
    });
  });

  it("finds the free starts of a unit whose busy rows arrive out of order", () => {
    const rows = [busy("u1", at(2060, 6, 1, 20), at(2060, 6, 1, 21)), busy("u1", at(2060, 6, 1, 18), at(2060, 6, 1, 19))];
    expect(starts(run({ busy: rows }))).toEqual([
      iso(2060, 6, 1, 17), iso(2060, 6, 1, 19), iso(2060, 6, 1, 21), iso(2060, 6, 1, 21, 30), iso(2060, 6, 1, 22),
    ]);
  });

  it("drops the starts before now, and keeps a start at now", () => {
    const p = period("s1", at(2060, 6, 1, 17), at(2060, 6, 1, 21), { "4": 60 });
    expect(starts(run({ slotMinutes: 60, periods: [p], now: at(2060, 6, 1, 18, 30) }))).toEqual([iso(2060, 6, 1, 19), iso(2060, 6, 1, 20)]);
    expect(starts(run({ slotMinutes: 60, periods: [p], now: at(2060, 6, 1, 19) }))).toEqual([iso(2060, 6, 1, 19), iso(2060, 6, 1, 20)]);
  });

  it("takes the window half-open: a start at from is offered, a start at to is not", () => {
    const p = period("s1", at(2060, 6, 1, 17), at(2060, 6, 1, 22), { "4": 60 });
    const r = run({ slotMinutes: 60, periods: [p], from: at(2060, 6, 1, 18), to: at(2060, 6, 1, 20) });
    expect(starts(r)).toEqual([iso(2060, 6, 1, 18), iso(2060, 6, 1, 19)]);
  });

  describe("limit", () => {
    const three = period("s1", at(2060, 6, 1, 17), at(2060, 6, 1, 20), { "4": 60 });
    const two = period("s1", at(2060, 6, 1, 17), at(2060, 6, 1, 19), { "4": 60 });

    it("stops at the limit and says more exist when a further start is free", () => {
      const r = run({ slotMinutes: 60, periods: [three], limit: 2 });
      expect(starts(r)).toEqual([iso(2060, 6, 1, 17), iso(2060, 6, 1, 18)]);
      expect(r.truncated).toBe(true);
    });

    it("is not truncated when exactly the limit's worth of starts are free", () => {
      const r = run({ slotMinutes: 60, periods: [two], limit: 2 });
      expect(starts(r)).toEqual([iso(2060, 6, 1, 17), iso(2060, 6, 1, 18)]);
      expect(r.truncated).toBe(false);
    });

    it("is not truncated when the only start past the limit has nothing free", () => {
      const r = run({ slotMinutes: 60, periods: [three], limit: 2, busy: [busy("u1", at(2060, 6, 1, 19), at(2060, 6, 1, 20))] });
      expect(starts(r)).toEqual([iso(2060, 6, 1, 17), iso(2060, 6, 1, 18)]);
      expect(r.truncated).toBe(false);
    });
  });

  describe("examined starts", () => {
    const cap = BOUNDS.availabilityStartsExamined;
    const origin = at(2060, 6, 1, 0);
    // a period holding `n` starts on a 5-minute grid for a 60-minute booking
    const long = (n: number) => period("long", origin, new Date(origin.getTime() + (60 + (n - 1) * 5) * MINUTE), { "10": 60 });
    const over = (n: number, extra: Partial<AvailabilityComputation> = {}): AvailabilityComputation => ({
      partySize: 2, from: origin, to: new Date(origin.getTime() + 365 * 24 * 60 * MINUTE), now: new Date(origin.getTime() - 60 * MINUTE), slotMinutes: 5,
      periods: [long(n)], units: [unit("u1", "T1", 1, 4)], combos: [], closures: [], busy: [], limit: BOUNDS.availabilityResults.max,
      ...extra,
    });
    const wholePeriod = (n: number): Busy[] => [busy("u1", new Date(origin.getTime() - 60 * MINUTE), new Date(origin.getTime() + (n * 5 + 120) * MINUTE))];

    it("builds the synthetic period it means to", () => {
      expect(slotStarts(long(cap + 1), 5, 60)).toHaveLength(cap + 1);
      expect(slotStarts(long(cap), 5, 60)).toHaveLength(cap);
    });

    it("stops with truncated and no slots when every candidate is busy over more starts than the cap", () => {
      expect(computeAvailability(over(cap + 1, { busy: wholePeriod(cap + 1) }))).toEqual({ slots: [], truncated: true });
    });

    it("stops with truncated and no slots when no candidate fits over more starts than the cap", () => {
      expect(computeAvailability(over(cap + 1, { partySize: 9 }))).toEqual({ slots: [], truncated: true });
    });

    it("is not truncated when exactly the cap's worth of starts is examined", () => {
      expect(computeAvailability(over(cap, { busy: wholePeriod(cap) }))).toEqual({ slots: [], truncated: false });
      expect(computeAvailability(over(cap, { partySize: 9 }))).toEqual({ slots: [], truncated: false });
    });

    it("keeps the slots found before the cap stopped the pass", () => {
      const rows = [busy("u1", new Date(origin.getTime() + 60 * MINUTE), new Date(origin.getTime() + (cap * 5 + 120) * MINUTE))];
      const r = computeAvailability(over(cap + 1, { busy: rows }));
      expect(r.truncated).toBe(true);
      expect(r.slots.map((s) => s.startsAt)).toEqual([origin.toISOString()]);
    });
  });

  describe("assignments", () => {
    const two = period("s1", at(2060, 6, 1, 17), at(2060, 6, 1, 19), { "8": 60 });

    it("returns one slot per start, however many assignments are free", () => {
      const units = [unit("u1", "T1", 1, 4), unit("u2", "T2", 1, 4), unit("u3", "T3", 1, 4)];
      const r = run({ periods: [two], units, combos: [combo("k", "K", ["u1", "u2"], 2, 8)] });
      expect(r.slots).toEqual([
        { startsAt: iso(2060, 6, 1, 17), durationMinutes: 60, assignment: { kind: "unit", id: "u3" } },
        { startsAt: iso(2060, 6, 1, 17, 30), durationMinutes: 60, assignment: { kind: "unit", id: "u3" } },
        { startsAt: iso(2060, 6, 1, 18), durationMinutes: 60, assignment: { kind: "unit", id: "u3" } },
      ]);
    });

    it("does not offer a unit that is busy at the start while another is free", () => {
      const units = [unit("u1", "T1", 1, 4), unit("u2", "T2", 1, 4)];
      const r = run({ periods: [two], units, busy: [busy("u1", at(2060, 6, 1, 17), at(2060, 6, 1, 19))] });
      expect(r.slots.map((s) => s.assignment.id)).toEqual(["u2", "u2", "u2"]);
    });

    it("offers a combo only while every member unit is free", () => {
      const units = [unit("u1", "T1", 1, 2), unit("u2", "T2", 1, 2), unit("u3", "T3", 1, 2)];
      const combos = [combo("k", "K", ["u1", "u2"], 3, 4)];
      const blockedMember = run({ partySize: 3, periods: [two], units, combos, busy: [busy("u2", at(2060, 6, 1, 17), at(2060, 6, 1, 19))] });
      expect(blockedMember.slots).toEqual([]);
      const otherUnit = run({ partySize: 3, periods: [two], units, combos, busy: [busy("u3", at(2060, 6, 1, 17), at(2060, 6, 1, 19))] });
      expect(otherUnit.slots.map((s) => s.assignment)).toEqual([{ kind: "combo", id: "k" }, { kind: "combo", id: "k" }, { kind: "combo", id: "k" }]);
    });

    it("uses a supplied ranking strategy", () => {
      const units = [unit("u1", "T1", 1, 4), unit("u2", "T2", 1, 4)];
      const last = { name: "last", choose: (free: readonly Candidate[]) => free[free.length - 1] ?? null };
      const r = run({ periods: [two], units, ranking: last });
      expect(r.slots.map((s) => s.assignment.id)).toEqual(["u2", "u2", "u2"]);
    });

    it("skips a start whose ranking chooses nothing", () => {
      const none = { name: "none", choose: () => null };
      expect(run({ periods: [two], ranking: none })).toEqual({ slots: [], truncated: false });
    });
  });
});

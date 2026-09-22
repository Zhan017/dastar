import { describe, it, expect } from "vitest";
import { rng } from "../src/rng.js";
import { planArrivals, runOpenLoop, type Arrival } from "../src/schedule.js";
import { holdFactory, parseBlend, pickMix, TARGET_BLEND, type Mix } from "../src/workload.js";
import type { BenchSeed } from "../src/seed.js";
import { dist, exact, fmt } from "../src/stats.js";
import { startSweeper, DESIGN_SWEEP } from "../src/sweeper.js";

const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const seed: BenchSeed = { venue: uuid(999), units: Array.from({ length: 40 }, (_, i) => uuid(i)), combos: Array.from({ length: 10 }, (_, i) => uuid(500 + i)) };

describe("seeded generator", () => {
  it("repeats from its seed and differs between seeds", () => {
    const a = rng(7); const b = rng(7); const c = rng(8);
    const xs = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(xs);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(() => rng(1).pick([])).toThrow(/empty/);
  });
});

describe("arrival plan", () => {
  it("is fixed by the seed, ordered, inside its steps, and close to rate times seconds", () => {
    const steps = [{ ratePerSec: 50, seconds: 20 }, { ratePerSec: 200, seconds: 10 }];
    const plan = planArrivals(steps, rng(1));
    expect(planArrivals(steps, rng(1))).toEqual(plan);
    expect(plan.map((a) => a.seq)).toEqual(plan.map((_, i) => i));
    expect(plan.every((a, i) => i === 0 || a.atMs >= plan[i - 1]!.atMs)).toBe(true);
    const first = plan.filter((a) => a.step === 0);
    const second = plan.filter((a) => a.step === 1);
    expect(first.every((a) => a.atMs < 20_000)).toBe(true);
    expect(second.every((a) => a.atMs >= 20_000 && a.atMs < 30_000)).toBe(true);
    expect(Math.abs(first.length - 1_000)).toBeLessThan(150);
    expect(Math.abs(second.length - 2_000)).toBeLessThan(200);
    expect(planArrivals([{ ratePerSec: 0, seconds: 5 }], rng(1))).toEqual([]);
  });

  it("the dispatcher never waits for work, reports how late it was, and can be stopped", async () => {
    let now = 0;
    const clock = { now: () => now, sleep: async (ms: number) => { now += ms + 5; } };
    const plan: Arrival[] = [{ seq: 0, step: 0, atMs: 100 }, { seq: 1, step: 0, atMs: 101 }, { seq: 2, step: 0, atMs: 400 }];
    const seen: [number, number][] = [];
    const out = await runOpenLoop(plan, (a, late) => { seen.push([a.seq, late]); }, { clock });
    expect(out.started).toBe(3);
    expect(seen).toEqual([[0, 5], [1, 4], [2, 5]]);
    now = 0;
    const stopped = await runOpenLoop(plan, () => undefined, { clock, stopped: () => now > 150 });
    expect(stopped.started).toBe(2);
  });
});

describe("workload", () => {
  it("draws the target blend in its proportions", () => {
    const r = rng(3);
    const counts: Record<Mix, number> = { overlapping: 0, distinct_dates: 0, disjoint_units: 0, combos: 0 };
    for (let i = 0; i < 20_000; i++) counts[pickMix(TARGET_BLEND, r)] += 1;
    expect(counts.overlapping / 20_000).toBeCloseTo(0.4, 1);
    expect(counts.distinct_dates / 20_000).toBeCloseTo(0.3, 1);
    expect(counts.disjoint_units / 20_000).toBeCloseTo(0.2, 1);
    expect(counts.combos / 20_000).toBeCloseTo(0.1, 1);
    expect(parseBlend("combos")).toEqual({ overlapping: 0, distinct_dates: 0, disjoint_units: 0, combos: 1 });
    expect(() => parseBlend("everything")).toThrow(/blend must be/);
  });

  it("only the overlapping mix can collide; every other request has its own unit and day", () => {
    const next = holdFactory(seed, rng(5), "run");
    const popular = new Set(seed.units.slice(0, 10));
    const slots = new Set<string>();
    for (let i = 0; i < 3_000; i++) {
      const mix: Mix = (["distinct_dates", "disjoint_units", "combos"] as const)[i % 3]!;
      const h = next(mix, i);
      const key = `${h.assignment.id}|${h.startsAt}`;
      expect(slots.has(key)).toBe(false);
      slots.add(key);
      expect(h.assignment.kind).toBe(mix === "combos" ? "combo" : "unit");
      if (mix === "distinct_dates") expect(popular.has(h.assignment.id)).toBe(true);
      if (mix === "disjoint_units") expect(popular.has(h.assignment.id)).toBe(false);
      expect(h.idempotencyKey).toBe(`run-h${i}`);
      expect(h.actor).toBe(`run:${i}`);
    }
    const rush = Array.from({ length: 500 }, (_, i) => next("overlapping", 10_000 + i));
    expect(rush.every((h) => popular.has(h.assignment.id) && h.startsAt.startsWith("2046-01-01T"))).toBe(true);
    expect(new Set(rush.map((h) => `${h.assignment.id}|${h.startsAt}`)).size).toBeLessThanOrEqual(160);
    expect(() => holdFactory({ ...seed, units: seed.units.slice(0, 4) }, rng(1), "x")).toThrow(/at least 20 units/);
  });
});

describe("distributions", () => {
  it("states a percentile only with three samples beyond it, and an empty one is all nulls", () => {
    expect(dist([])).toEqual({ count: 0, censored: 0, p50: null, p95: null, p99: null, max: null });
    expect(dist(exact([5, 1, 3]))).toEqual({ count: 3, censored: 0, p50: null, p95: null, p99: null, max: { atLeast: 5, atMost: 5 } });
    const sixty = dist(exact(Array.from({ length: 60 }, (_, i) => i + 1)));
    expect(sixty).toMatchObject({ count: 60, censored: 0, p50: { atLeast: 31, atMost: 31 }, p95: { atLeast: 58, atMost: 58 }, p99: null });
    expect(dist(exact(Array.from({ length: 300 }, (_, i) => i + 1))).p99).toEqual({ atLeast: 298, atMost: 298 });
  });

  it("a censored sample is a lower bound: it can prove a limit broken, and it takes enough exact samples above it to prove a limit kept", () => {
    // 300 requests that all ended 8 ms into the phase say nothing about how long the phase takes
    const all = dist(Array.from({ length: 300 }, () => ({ ms: 8, censored: true })));
    expect(all.p99).toEqual({ atLeast: 8, atMost: null });
    expect(all.max).toEqual({ atLeast: 8, atMost: null });
    // two censored among 400: the p99 position still falls on an exact sample even if both never finished
    const few = dist([...exact(Array.from({ length: 398 }, (_, i) => i + 1)), { ms: 5, censored: true }, { ms: 6, censored: true }]);
    expect(few.censored).toBe(2);
    expect(few.p99!.atMost).not.toBeNull();
    expect(few.p99!.atMost!).toBeGreaterThanOrEqual(few.p99!.atLeast);
    // five censored among 400 reach past the p99 position: the upper bound is gone, the lower bound stays
    const many = dist([...exact(Array.from({ length: 395 }, (_, i) => i + 1)), ...Array.from({ length: 5 }, () => ({ ms: 10_000, censored: true }))]);
    expect(many.p99).toEqual({ atLeast: 10_000, atMost: null });
    expect(many.p50!.atMost).not.toBeNull();
    expect([fmt(null), fmt(1.26), fmt(3, 0), fmt({ atLeast: 2, atMost: 2 }), fmt({ atLeast: 2, atMost: 7.25 }), fmt({ atLeast: 8, atMost: null })]).toEqual(["n/a", "1.3", "3", "2.0", "2.0..7.3", ">=8.0"]);
  });
});

describe("sweeper", () => {
  it("is the design's by default: every five seconds, twenty at a time, repeated while a batch comes back full", async () => {
    expect(DESIGN_SWEEP).toEqual({ everyMs: 5_000, limit: 20, drain: true });
    let due = 45;
    const limits: number[] = [];
    const worker = { expireDue: async (o?: { limit?: number }) => { const n = Math.min(due, o?.limit ?? 0); due -= n; limits.push(o?.limit ?? 0); return { expired: Array.from({ length: n }, () => "x") }; } };
    const s = startSweeper(worker, DESIGN_SWEEP);
    await new Promise((res) => setImmediate(res));
    await s.stop();
    expect(limits).toEqual([20, 20, 20]);
    expect(s.stats).toMatchObject({ ticks: 1, batches: 3, expired: 45, errors: 0, maxBatchesInTick: 3, config: DESIGN_SWEEP });
  });

  it("takes one batch per tick without drain, skips ticks while paused, counts errors, and stops without waiting out its interval", async () => {
    let due = 45;
    let paused = true;
    let fail = false;
    const worker = { expireDue: async (o?: { limit?: number }) => { if (fail) throw new Error("down"); const n = Math.min(due, o?.limit ?? 0); due -= n; return { expired: Array.from({ length: n }, () => "x") }; } };
    const s = startSweeper(worker, { everyMs: 5, limit: 20, drain: false }, () => paused);
    await new Promise((res) => setTimeout(res, 30));
    expect(s.stats.ticks).toBe(0);
    paused = false;
    while (s.stats.expired < 45) await new Promise((res) => setTimeout(res, 5));
    expect(s.stats.batches).toBeGreaterThanOrEqual(3);
    expect(s.stats.maxBatchesInTick).toBe(1);
    fail = true;
    while (s.stats.errors === 0) await new Promise((res) => setTimeout(res, 5));
    const long = startSweeper(worker, { everyMs: 60_000, limit: 20, drain: true });
    const t0 = Date.now();
    await Promise.all([s.stop(), long.stop()]);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

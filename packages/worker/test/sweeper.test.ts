import { describe, it, expect } from "vitest";
import { startSweeper, DESIGN_SWEEP } from "../src/sweeper.js";

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
    const errors: string[] = [];
    const worker = { expireDue: async (o?: { limit?: number }) => { if (fail) throw new Error("down"); const n = Math.min(due, o?.limit ?? 0); due -= n; return { expired: Array.from({ length: n }, () => "x") }; } };
    const s = startSweeper(worker, { everyMs: 5, limit: 20, drain: false }, { paused: () => paused, onError: (e) => { errors.push((e as Error).message); } });
    await new Promise((res) => setTimeout(res, 30));
    expect(s.stats.ticks).toBe(0);
    paused = false;
    while (s.stats.expired < 45) await new Promise((res) => setTimeout(res, 5));
    expect(s.stats.batches).toBeGreaterThanOrEqual(3);
    expect(s.stats.maxBatchesInTick).toBe(1);
    fail = true;
    while (s.stats.errors === 0) await new Promise((res) => setTimeout(res, 5));
    expect(errors[0]).toBe("down");
    const long = startSweeper(worker, { everyMs: 60_000, limit: 20, drain: true });
    const t0 = Date.now();
    await Promise.all([s.stop(), long.stop()]);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

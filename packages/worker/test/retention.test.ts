import { describe, it, expect } from "vitest";
import { startRetention, DESIGN_RETENTION } from "../src/retention.js";

type Counts = { idempotency: number; outbox: number };

/** A fake worker handle with `due` rows in each table; every call records its limit. */
function fakeWorker(due: Counts) {
  const limits: number[] = [];
  const state = { due, fail: false, calls: 0 };
  const worker = {
    purgeRetained: async (o?: { limit?: number }): Promise<Counts> => {
      state.calls += 1;
      if (state.fail) throw new Error("down");
      const limit = o?.limit ?? 0;
      limits.push(limit);
      const idempotency = Math.min(state.due.idempotency, limit);
      const outbox = Math.min(state.due.outbox, limit);
      state.due = { idempotency: state.due.idempotency - idempotency, outbox: state.due.outbox - outbox };
      return { idempotency, outbox };
    },
  };
  return { worker, limits, state };
}

const settle = (): Promise<void> => new Promise((res) => setImmediate(res));

describe("retention loop", () => {
  it("is the design's by default: every minute, five hundred per table, repeated while a batch comes back full", async () => {
    expect(DESIGN_RETENTION).toEqual({ everyMs: 60_000, limit: 500, drain: true });
    const batches: Counts[] = [];
    const both = fakeWorker({ idempotency: 1_200, outbox: 300 });
    const s = startRetention(both.worker, DESIGN_RETENTION, { onPurged: (c) => { batches.push(c); } });
    await settle();
    await s.stop();
    expect(both.limits).toEqual([500, 500, 500]);
    expect(batches).toEqual([{ idempotency: 500, outbox: 300 }, { idempotency: 500, outbox: 0 }, { idempotency: 200, outbox: 0 }]);
    expect(s.stats).toMatchObject({ ticks: 1, batches: 3, idempotency: 1_200, outbox: 300, errors: 0, maxBatchesInTick: 3, config: DESIGN_RETENTION });

    // a full outbox batch alone keeps the tick going
    const outboxOnly = fakeWorker({ idempotency: 0, outbox: 1_000 });
    const o = startRetention(outboxOnly.worker, DESIGN_RETENTION);
    await settle();
    await o.stop();
    expect(outboxOnly.limits).toEqual([500, 500, 500]);
    expect(o.stats).toMatchObject({ ticks: 1, batches: 3, idempotency: 0, outbox: 1_000, maxBatchesInTick: 3 });
  });

  it("takes one batch per tick without drain, skips ticks while paused, counts errors and carries on, and stops without waiting out its interval", async () => {
    const f = fakeWorker({ idempotency: 1_200, outbox: 0 });
    let paused = true;
    const errors: string[] = [];
    const s = startRetention(f.worker, { everyMs: 5, limit: 500, drain: false }, { paused: () => paused, onError: (e) => { errors.push((e as Error).message); } });
    await new Promise((res) => setTimeout(res, 30));
    expect(s.stats.ticks).toBe(0);
    expect(f.state.calls).toBe(0);
    paused = false;
    while (s.stats.idempotency < 1_200) await new Promise((res) => setTimeout(res, 5));
    expect(s.stats.batches).toBeGreaterThanOrEqual(3);
    expect(s.stats.maxBatchesInTick).toBe(1);
    expect(f.limits.slice(0, 3)).toEqual([500, 500, 500]);
    f.state.fail = true;
    while (s.stats.errors === 0) await new Promise((res) => setTimeout(res, 5));
    expect(errors[0]).toBe("down");
    f.state.fail = false;
    f.state.due = { idempotency: 7, outbox: 3 };
    while (s.stats.idempotency < 1_207) await new Promise((res) => setTimeout(res, 5));
    expect(s.stats).toMatchObject({ idempotency: 1_207, outbox: 3 });
    expect(s.stats.errors).toBeGreaterThanOrEqual(1);

    const idle = fakeWorker({ idempotency: 0, outbox: 0 });
    const long = startRetention(idle.worker, { everyMs: 60_000, limit: 500, drain: true });
    await settle();
    expect(long.stats.ticks).toBe(1);
    const t0 = Date.now();
    await Promise.all([s.stop(), long.stop()]);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

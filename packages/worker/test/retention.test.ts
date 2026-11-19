import { describe, it, expect } from "vitest";
import { startRetention, DESIGN_RETENTION } from "../src/retention.js";

type Counts = { idempotency: number; outbox: number; sessions: number; calls: number; turns: number };
const TABLES = ["idempotency", "outbox", "sessions", "calls", "turns"] as const;
const none: Counts = { idempotency: 0, outbox: 0, sessions: 0, calls: 0, turns: 0 };
const counts = (c: Partial<Counts>): Counts => ({ ...none, ...c });

/** A fake worker handle with `due` rows in each table; every call records its limit. */
function fakeWorker(due: Partial<Counts>) {
  const limits: number[] = [];
  const state = { due: counts(due), fail: false, calls: 0 };
  const worker = {
    purgeRetained: async (o?: { limit?: number }): Promise<Counts> => {
      state.calls += 1;
      if (state.fail) throw new Error("down");
      const limit = o?.limit ?? 0;
      limits.push(limit);
      const batch = { ...none };
      const left = { ...none };
      for (const t of TABLES) {
        batch[t] = Math.min(state.due[t], limit);
        left[t] = state.due[t] - batch[t];
      }
      state.due = left;
      return batch;
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
    expect(batches).toEqual([counts({ idempotency: 500, outbox: 300 }), counts({ idempotency: 500 }), counts({ idempotency: 200 })]);
    expect(s.stats).toMatchObject({ ticks: 1, batches: 3, idempotency: 1_200, outbox: 300, sessions: 0, calls: 0, turns: 0, errors: 0, maxBatchesInTick: 3, config: DESIGN_RETENTION });

    // a full outbox batch alone keeps the tick going
    const outboxOnly = fakeWorker({ outbox: 1_000 });
    const o = startRetention(outboxOnly.worker, DESIGN_RETENTION);
    await settle();
    await o.stop();
    expect(outboxOnly.limits).toEqual([500, 500, 500]);
    expect(o.stats).toMatchObject({ ticks: 1, batches: 3, idempotency: 0, outbox: 1_000, maxBatchesInTick: 3 });
  });

  it("keeps taking batches while only the session tables come back full", async () => {
    const f = fakeWorker({ calls: 1_200 });
    const batches: Counts[] = [];
    const s = startRetention(f.worker, DESIGN_RETENTION, { onPurged: (c) => { batches.push(c); } });
    await settle();
    await s.stop();
    expect(f.limits).toEqual([500, 500, 500]);
    expect(batches).toEqual([counts({ calls: 500 }), counts({ calls: 500 }), counts({ calls: 200 })]);
    expect(s.stats).toMatchObject({ ticks: 1, batches: 3, calls: 1_200, sessions: 0, turns: 0, idempotency: 0, outbox: 0, maxBatchesInTick: 3 });

    // a full batch of turns, or of sessions, keeps the tick going as well
    for (const table of ["turns", "sessions"] as const) {
      const g = fakeWorker(table === "turns" ? { turns: 600 } : { sessions: 600 });
      const r = startRetention(g.worker, DESIGN_RETENTION);
      await settle();
      await r.stop();
      expect(g.limits).toEqual([500, 500]);
      expect(r.stats).toMatchObject({ ticks: 1, batches: 2, [table]: 600, maxBatchesInTick: 2 });
    }
  });

  it("takes one batch per tick without drain, skips ticks while paused, counts errors and carries on, and stops without waiting out its interval", async () => {
    const f = fakeWorker({ idempotency: 1_200 });
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
    f.state.due = counts({ idempotency: 7, outbox: 3 });
    while (s.stats.idempotency < 1_207) await new Promise((res) => setTimeout(res, 5));
    expect(s.stats).toMatchObject({ idempotency: 1_207, outbox: 3 });
    expect(s.stats.errors).toBeGreaterThanOrEqual(1);

    const idle = fakeWorker({});
    const long = startRetention(idle.worker, { everyMs: 60_000, limit: 500, drain: true });
    await settle();
    expect(long.stats.ticks).toBe(1);
    const t0 = Date.now();
    await Promise.all([s.stop(), long.stop()]);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

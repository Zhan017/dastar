import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool, Client } from "pg";
import { listen } from "@dastar/api/server";
import { cloneDatabase, dropDatabase, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedBench } from "../src/seed.js";
import { runLoad, warmPool } from "../src/load.js";
import { createLoadKeys, engineTarget, httpTarget, type LoadTarget } from "../src/target.js";
import { TARGET_BLEND, MIXES } from "../src/workload.js";
import { planArrivals } from "../src/schedule.js";
import { rng } from "../src/rng.js";

const FAST_SWEEP = { everyMs: 200, limit: 20, drain: true };

describe("load run", () => {
  let conn: Conn; let owner: Client; let appPool: Pool; let workerPool: Pool;
  beforeAll(async () => {
    conn = await cloneDatabase("harness_load");
    owner = new Client({ connectionString: conn.owner });
    await owner.connect();
    appPool = new Pool({ connectionString: conn.app, max: 16 });
    appPool.on("error", () => undefined);
    workerPool = new Pool({ connectionString: conn.worker, max: 2 });
    workerPool.on("error", () => undefined);
    await warmPool(appPool);
  });
  afterAll(async () => { await appPool.end(); await workerPool.end(); await owner.end(); await dropDatabase("harness_load"); });

  it("engine target: a fixed plan, every request kept with its times and phases, invariants intact", async () => {
    const seed = await seedBench(owner, { holdTtlSeconds: 60 });
    const target = engineTarget(appPool);
    const r = await runLoad({ target, workerPool, owner, seed }, {
      steps: [{ ratePerSec: 30, seconds: 2 }, { ratePerSec: 60, seconds: 2 }], blend: TARGET_BLEND, seed: 11, label: "provisional", poolMax: 16, sweep: FAST_SWEEP,
    });
    await target.close();
    expect(r).toMatchObject({ command: "load", target: "engine", label: "provisional", deadlockDelta: 0, overlaps: 0, fitViolations: 0 });
    expect(r.targets).toBeUndefined();
    expect(r.validity).toEqual({ valid: true, reasons: [] });
    expect(r.transport).toEqual({ timeouts: 0, errors: 0, holds: { granted: 0, refused: 0, unobserved: 0 } });
    expect(r.workload).toEqual({ blend: TARGET_BLEND, followUpRatio: 0.2, units: seed.units.length, combos: seed.combos.length, holdTtlSeconds: 60, maxInFlight: 2_000, sweep: FAST_SWEEP });
    expect(r.peakOutstanding).toBeGreaterThanOrEqual(1);
    expect(r.peakOutstanding).toBeGreaterThanOrEqual(Math.max(...r.timeline.map((b) => b.outstanding)));
    expect(r.drainMs).toBeGreaterThanOrEqual(r.holdDrainMs);
    expect(r.sweep).toMatchObject({ config: FAST_SWEEP, errors: 0 });
    expect(r.sweep.ticks).toBeGreaterThan(0);
    const total = r.steps.reduce((n, s) => n + s.offered, 0);
    expect(r.records).toHaveLength(total);
    expect(r.steps.map((s) => [s.fromMs, s.toMs])).toEqual([[0, 2_000], [2_000, 4_000]]);
    for (const x of r.records) {
      expect(["ok", "hold_conflict"]).toContain(x.code);
      expect(x.doneMs!).toBeGreaterThan(x.startedMs);
      expect(x.startedMs).toBeGreaterThanOrEqual(x.atMs);
      expect(x.e2eMs!).toBeCloseTo(x.doneMs! - x.atMs, 6);
      expect(x.transactionMs!).toBeGreaterThan(0);
      expect(x.connectionHeldMs!).toBeGreaterThanOrEqual(x.transactionMs!);
      expect(x.poolWaitCensored || x.unitLockCensored || x.e2eCensored).toBe(false);
      expect(x.stored).toBeNull();
    }
    for (const s of r.steps) {
      expect(s.offered).toBeGreaterThan(20);
      expect(s.errorRate).toBe(0);
      expect(s.all.e2eMs.count).toBe(s.offered);
      expect(s.all.unitLockMs.count).toBe(s.offered);
      expect(s.followUps.offered).toBeGreaterThan(0);
    }
    // an unsaturated run answers what it is offered: nothing is left waiting and the timeline accounts for every request
    expect(r.steps[r.steps.length - 1]!.backlogAtEnd).toBeLessThan(5);
    expect(r.steps.reduce((n, s) => n + s.answeredInWindow, 0)).toBeGreaterThanOrEqual(total - 5);
    expect(r.timeline.reduce((n, b) => n + b.arrived, 0)).toBe(total);
    expect(r.timeline.reduce((n, b) => n + b.answered + b.errors, 0)).toBe(total);
    expect(r.timeline[r.timeline.length - 1]!.outstanding).toBe(0);
    expect(r.drainMs).toBeLessThan(2_000);
    for (const m of MIXES) expect(r.steps.reduce((n, s) => n + s.mixes[m].offered, 0)).toBeGreaterThan(0);
    const rows = await owner.query("select count(*)::int as n from dastar.idempotency where venue_id = $1", [seed.venue]);
    expect(rows.rows[0].n).toBe(total);
    expect(r.followUps.filter((f) => f.code === "ok").length).toBeGreaterThan(0);
  });

  it("http target: the same plan through the reference API; end-to-end is judged here and the engine-only targets are marked as not measured", async () => {
    const seed = await seedBench(owner, { holdTtlSeconds: 60 });
    const api = await listen({ DATABASE_URL: conn.app, HOST: "127.0.0.1", PORT: 0, POOL_MAX: 8, POOL_ACQUIRE_MS: 5_000, READ_TIMEOUT_MS: 2_000, REQUEST_DEADLINE_MS: 12_000 }, { log: () => undefined });
    try {
      const target = httpTarget({ url: api.url, keys: await createLoadKeys(appPool, 4) });
      const r = await runLoad({ target, workerPool, owner, seed }, { steps: [{ ratePerSec: 40, seconds: 2 }], blend: TARGET_BLEND, seed: 12, label: "target-hardware", poolMax: 8, sweep: FAST_SWEEP });
      expect(r).toMatchObject({ target: "http", deadlockDelta: 0, overlaps: 0, fitViolations: 0 });
      expect(r.records.every((x) => x.code === "ok" || x.code === "hold_conflict")).toBe(true);
      expect(r.records.every((x) => x.poolWaitMs === null && x.unitLockMs === null && x.transactionMs === null)).toBe(true);
      expect(r.steps[0]!.all.e2eMs.count).toBe(r.records.length);
      const byName = new Map(r.targets!.checks.map((c) => [c.name, c]));
      expect(byName.get("pool-acquire wait p99 ms")).toMatchObject({ status: "not_measured", scope: "engine" });
      expect(byName.get("unit-lock phase p99 ms, distinct dates")).toMatchObject({ status: "not_measured" });
      expect(byName.get("hold end-to-end p95 ms")).toMatchObject({ scope: "http" });
      expect(byName.get("hold end-to-end p95 ms")!.atLeast).not.toBeNull();
      expect(byName.get("hold end-to-end p95 ms")!.atMost).toBe(byName.get("hold end-to-end p95 ms")!.atLeast);
      // 80 requests cannot state a p99
      expect(byName.get("hold end-to-end p99 ms")).toMatchObject({ atLeast: null, atMost: null, status: "no_data" });
      expect(r.validity.valid).toBe(true);
      // the latency limits depend on the machine: a slow runner misses 150 ms at p95, a fast one is inside it; what holds anywhere is that a two-second run can never read met
      expect(["inconclusive", "missed"]).toContain(r.targets!.verdict);
      expect(r.targets!.verdict).not.toBe("met");
      // two seconds at 40 per second with a fast sweeper is not the workload the targets are defined for, and the report says how
      expect(r.targets!.workload.matchesTarget).toBe(false);
      expect(r.targets!.workload.differences).toEqual([expect.stringMatching(/^offered 40 holds per second/), expect.stringMatching(/^sustained for 2 s/), expect.stringMatching(/^sweeper /)]);
    } finally {
      await api.close();
    }
  });

  it("a run whose confirmations and cancellations fail is invalid, however good its holds look", async () => {
    const seed = await seedBench(owner, { holdTtlSeconds: 60 });
    const engine = engineTarget(appPool);
    const target: LoadTarget = { ...engine, confirm: async () => "timeout", cancel: async () => "timeout" };
    const r = await runLoad({ target, workerPool, owner, seed }, { steps: [{ ratePerSec: 40, seconds: 2 }], blend: TARGET_BLEND, seed: 13, label: "target-hardware", poolMax: 16, sweep: FAST_SWEEP });
    await engine.close();
    expect(r.steps[0]!.errorRate).toBe(0);
    expect(r.validity.valid).toBe(false);
    expect(r.validity.reasons).toEqual([expect.stringMatching(/confirmations and cancellations failed/)]);
    expect(r.targets!.verdict).toBe("invalid");
  });

  it("a hold the harness got no answer to is looked up in the database: a client timeout does not say the hold failed", async () => {
    const seed = await seedBench(owner, { holdTtlSeconds: 60 });
    const engine = engineTarget(appPool);
    let n = 0;
    // every fifth hold is carried out, and then its answer is lost on the way back
    const target: LoadTarget = { ...engine, kind: "http", hold: async (input) => { const a = await engine.hold(input); return n++ % 5 === 0 ? { code: n % 2 === 0 ? "transport_timeout" : "transport_error", reservationId: null, phases: null } : a; } };
    const r = await runLoad({ target, workerPool, owner, seed }, { steps: [{ ratePerSec: 40, seconds: 2 }], blend: TARGET_BLEND, seed: 14, label: "provisional", poolMax: 16, sweep: FAST_SWEEP });
    await engine.close();
    const lost = r.records.filter((x) => x.code === "transport_timeout" || x.code === "transport_error");
    expect(lost.length).toBeGreaterThan(5);
    // a timeout and a failed connection alike: a lower bound on latency; the engine actually carried these out, so each is granted or refused, never unobserved
    expect(lost.every((x) => x.cls === "transport" && x.e2eCensored)).toBe(true);
    expect(lost.every((x) => x.stored === "granted" || x.stored === "refused")).toBe(true);
    const errors = lost.filter((x) => x.code === "transport_error").length;
    expect(errors).toBeGreaterThan(0);
    expect(r.transport.timeouts).toBe(lost.length - errors);
    expect(r.transport.errors).toBe(errors);
    expect(r.transport.holds.unobserved).toBe(0);
    expect(r.transport.holds.granted + r.transport.holds.refused).toBe(lost.length);
    expect(r.transport.holds.granted).toBeGreaterThan(0);
    expect(r.validity.reasons).toEqual([expect.stringMatching(new RegExp(`${lost.length} request\\(s\\) got no complete answer from the API; for the holds among them the database holds \\d+ granted, \\d+ refused, 0 with no outcome observed yet`))]);
    expect(r.steps[0]!.all.e2eMs.censored).toBe(lost.length);
  });

  it("a target that throws is still recorded, so every planned request has a record, and the run is invalid", async () => {
    const seed = await seedBench(owner, { holdTtlSeconds: 60 });
    const engine = engineTarget(appPool);
    let holdCalls = 0;
    let confirmCalls = 0;
    const target: LoadTarget = {
      ...engine,
      hold: async (input) => { holdCalls += 1; if (holdCalls % 7 === 0) throw new Error("target down"); return engine.hold(input); },
      confirm: async (reservationId, venueId, traceId) => { confirmCalls += 1; if (confirmCalls === 1) throw new Error("target down"); return engine.confirm(reservationId, venueId, traceId); },
    };
    const steps = [{ ratePerSec: 40, seconds: 2 }];
    const r = await runLoad({ target, workerPool, owner, seed }, { steps, blend: TARGET_BLEND, seed: 15, label: "provisional", poolMax: 16, sweep: FAST_SWEEP });
    await engine.close();
    // the plan runLoad draws, regenerated here from the same seeds (seed + 1 for holds, seed + 2 for follow-ups at 0.2 of the rate): independent of the records
    const plannedHolds = planArrivals(steps, rng(15 + 1)).length;
    const plannedFollowUps = planArrivals(steps.map((s) => ({ ratePerSec: s.ratePerSec * 0.2, seconds: s.seconds })), rng(15 + 2)).length;
    expect(r.records.length).toBe(plannedHolds);
    expect(new Set(r.records.map((x) => x.seq)).size).toBe(plannedHolds);
    expect(r.followUps.length).toBe(plannedFollowUps);
    // nothing is shed at this rate, so every planned hold reached the target, and every seventh call threw
    expect(holdCalls).toBe(plannedHolds);
    expect(r.records.filter((x) => x.code === "target_threw").length).toBe(Math.floor(plannedHolds / 7));
    expect(confirmCalls).toBeGreaterThanOrEqual(1);
    expect(r.followUps.filter((x) => x.code === "target_threw").length).toBe(1);
    expect(r.validity.reasons).toContainEqual(expect.stringMatching(/made the target throw/));
    expect(r.validity.valid).toBe(false);
  });
});

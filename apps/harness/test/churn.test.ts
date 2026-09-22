import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool, Client } from "pg";
import { cloneDatabase, dropDatabase, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedBench } from "../src/seed.js";
import { runChurn, judgeChurn, fittedRise, agerPoolConfig, type ChurnSample } from "../src/churn.js";

const q = (ms: number) => ({ atLeast: ms, atMost: ms });
const latency = (p95: number | null, count = 100): ChurnSample["holdOkLatencyMs"] => ({ count, censored: 0, p50: q(4), p95: p95 === null ? null : q(p95), p99: null, max: q(80) });
const sample = (over: Partial<ChurnSample>): ChurnSample => ({
  atS: 0, progress: 0, ops: 0, sweeper: "on", retainedUnitRows: 1_000, activeUnitRows: 100, pendingDead: 2,
  heapBytes: 100_000, exclusionIndexBytes: 50_000, totalBytes: 200_000, heapDeadTuplePercent: 2, heapFreePercent: 5, indexFreePercent: 5,
  nLiveTup: 1_000, nDeadTup: 10, autovacuumCount: 0, autoanalyzeCount: 0, lastAutovacuum: null, walPosition: 0, sampleMs: 1,
  holdOkLatencyMs: latency(8), holdConflictLatencyMs: latency(5), partial: false, ...over,
});
/** Five samples before, two with the sweeper off and dead holds piled up, five after. */
const series = (after: (k: number) => Partial<ChurnSample>, opts: { vacuums?: number; peak?: number } = {}): ChurnSample[] => [
  sample({ progress: 0 }),
  ...[0.15, 0.2, 0.25, 0.3, 0.35].map((p, i) => sample({ progress: p, autovacuumCount: i })),
  ...[0.45, 0.55].map((p) => sample({ progress: p, sweeper: "off", pendingDead: opts.peak ?? 300, autovacuumCount: 4 })),
  ...[0.78, 0.84, 0.9, 0.95, 1.0].map((p, k) => sample({ progress: p, autovacuumCount: opts.vacuums ?? 8, ...after(k) })),
];
const good = { byCode: { "hold:ok": 900, "hold:hold_conflict": 300, "cancel:ok": 400, "confirm:ok": 90 }, sweepErrors: 0, sweepTicks: 40, ageErrors: 0, sampleError: null, elapsedS: 1_800, ops: 120_000 };

describe("churn verdict", () => {
  it("fits the change across a window", () => {
    expect(fittedRise([5, 5, 5, 5])).toBe(0);
    expect(fittedRise([10, 12, 14, 16, 18])).toBeCloseTo(8, 9);
    expect(fittedRise([7])).toBe(0);
  });

  it("passes a valid run whose windows are comparable and whose index, dead tuples, bytes per row and latency hold steady", () => {
    expect(judgeChurn({ samples: series(() => ({ retainedUnitRows: 3_000, heapBytes: 300_000 })), ...good })).toEqual({ verdict: "pass", reasons: [] });
  });

  it("a broken workload is invalid, whatever the storage numbers say", () => {
    const samples = series(() => ({}));
    expect(judgeChurn({ samples, ...good, byCode: { ...good.byCode, "hold:timeout": 40 } })).toEqual({ verdict: "invalid", reasons: ["40 operation(s) answered hold:timeout"] });
    expect(judgeChurn({ samples, ...good, sweepErrors: 2 })).toEqual({ verdict: "invalid", reasons: ["2 sweeper error(s)"] });
    expect(judgeChurn({ samples, ...good, sweepTicks: 0 })).toEqual({ verdict: "invalid", reasons: ["the sweeper never ran"] });
    expect(judgeChurn({ samples, ...good, ageErrors: 3 })).toEqual({ verdict: "invalid", reasons: ["3 aging statement(s) failed"] });
    expect(judgeChurn({ samples, ...good, sampleError: "relation does not exist" })).toEqual({ verdict: "invalid", reasons: ["the sampler failed: relation does not exist"] });
    expect(judgeChurn({ samples, ...good, byCode: { "hold:hold_conflict": 10 } })).toMatchObject({ verdict: "invalid", reasons: ["no hold succeeded"] });
    // nothing at all: no samples, no answers
    expect(judgeChurn({ samples: [], ...good, byCode: {} })).toMatchObject({ verdict: "invalid", reasons: ["no hold succeeded"] });
  });

  it("is inconclusive without enough samples or autovacuum runs, with windows that are not comparable, or when the sweeper-off phase piled nothing up", () => {
    expect(judgeChurn({ samples: [], ...good })).toMatchObject({ verdict: "inconclusive" });
    expect(judgeChurn({ samples: series(() => ({}), { vacuums: 1 }), ...good })).toEqual({ verdict: "inconclusive", reasons: [expect.stringMatching(/only 1 autovacuum runs/)] });
    expect(judgeChurn({ samples: series(() => ({ activeUnitRows: 180 })), ...good })).toEqual({ verdict: "inconclusive", reasons: [expect.stringMatching(/active unit rows went from 100 to 180/)] });
    expect(judgeChurn({ samples: series(() => ({}), { peak: 4 }), ...good })).toEqual({ verdict: "inconclusive", reasons: [expect.stringMatching(/did not pile up/)] });
    // a run that never reached the design's bounded run is inconclusive, whatever its windows look like
    expect(judgeChurn({ samples: series(() => ({})), ...good, elapsedS: 180, ops: 3_000 })).toEqual({ verdict: "inconclusive", reasons: [expect.stringMatching(/neither|bounded run|design's bounded/)] });
    // a window of almost nothing but refusals cannot state the p95 of granted holds, however many refusals it timed
    expect(judgeChurn({ samples: series(() => ({ holdOkLatencyMs: latency(null, 9), holdConflictLatencyMs: latency(3, 5_000) })), ...good }).reasons).toEqual([expect.stringMatching(/too few granted holds/)]);
  });

  it("fails on a level that rose between the windows, and says which", () => {
    const reasons = (after: Partial<ChurnSample>): string[] => judgeChurn({ samples: series(() => after), ...good }).reasons;
    expect(reasons({ exclusionIndexBytes: 90_000 })).toEqual([expect.stringMatching(/exclusion index bytes went from/)]);
    expect(reasons({ heapDeadTuplePercent: 20 })).toEqual([expect.stringMatching(/dead-tuple percent went from/)]);
    expect(reasons({ heapBytes: 400_000 })).toEqual([expect.stringMatching(/bytes per retained row went from/)]);
    expect(reasons({ holdOkLatencyMs: latency(40) })).toEqual([expect.stringMatching(/granted-hold p95 ms went from/)]);
    // refusals getting slower or faster is reported, not judged: a shift in the mix of answers must not move the verdict
    expect(reasons({ holdConflictLatencyMs: latency(400) })).toEqual([]);
    expect(reasons({ pendingDead: 60 })).toEqual([expect.stringMatching(/dead holds were not cleared/)]);
  });

  it("fails on a value still rising inside the last window even when the two window levels are close", () => {
    const v = judgeChurn({ samples: series((k) => ({ exclusionIndexBytes: 50_000 + k * 2_500 })), ...good });
    expect(v).toEqual({ verdict: "fail", reasons: [expect.stringMatching(/exclusion index bytes was still rising at the end/)] });
  });

  it("the terminal sample is partial: its storage numbers are judged, its latency is not", () => {
    // the last after sample (progress 1.0) has too few holds to state a latency percentile, but is otherwise good
    const terminalPartial = (k: number): Partial<ChurnSample> => (k === 4 ? { partial: true, holdOkLatencyMs: latency(null, 3) } : {});
    expect(judgeChurn({ samples: series(terminalPartial), ...good })).toEqual({ verdict: "pass", reasons: [] });

    // every after sample partial leaves no full-interval sample to judge latency from
    const everyAfterPartial = (): Partial<ChurnSample> => ({ partial: true });
    const noLatencyWindow = judgeChurn({ samples: series(everyAfterPartial), ...good });
    expect(noLatencyWindow).toEqual({ verdict: "inconclusive", reasons: [expect.stringMatching(/no full-interval sample in the after window/)] });

    // storage still counts a partial sample: a spike in the terminal sample alone still fails the rule
    const terminalSpike = (k: number): Partial<ChurnSample> => (k === 4 ? { partial: true, exclusionIndexBytes: 90_000 } : {});
    const reasons = judgeChurn({ samples: series(terminalSpike), ...good }).reasons;
    expect(reasons).toContainEqual(expect.stringMatching(/exclusion index bytes went from/));
  });
});

describe("churn run", () => {
  let conn: Conn; let owner: Client; let agerPool: Pool; let appPool: Pool; let workerPool: Pool;
  beforeAll(async () => {
    conn = await cloneDatabase("harness_churn");
    owner = new Client({ connectionString: conn.owner });
    agerPool = new Pool(agerPoolConfig(conn.owner, 4));
    agerPool.on("error", () => undefined);
    await owner.connect();
    appPool = new Pool({ connectionString: conn.app, max: 8 });
    appPool.on("error", () => undefined);
    workerPool = new Pool({ connectionString: conn.worker, max: 2 });
    workerPool.on("error", () => undefined);
  });
  afterAll(async () => { await appPool.end(); await workerPool.end(); await agerPool.end(); await owner.end(); await dropDatabase("harness_churn"); });

  it("samples storage and vacuum state through a run with a sweeper-off phase; cleanup happens after the last sample and is reported apart", async () => {
    const seed = await seedBench(owner, { holdTtlSeconds: 60 });
    const sweep = { everyMs: 200, limit: 20, drain: true };
    const r = await runChurn({ appPool, workerPool, owner, agerPool, seed }, { maxSeconds: 8, maxOps: 1_000_000, workers: 6, seed: 31, sampleEveryMs: 500, sweep, ageMs: 200 });
    expect(r.samples.length).toBeGreaterThanOrEqual(10);
    for (const s of r.samples) {
      for (const k of ["retainedUnitRows", "activeUnitRows", "pendingDead", "heapBytes", "exclusionIndexBytes", "totalBytes", "heapDeadTuplePercent", "heapFreePercent", "indexFreePercent", "nLiveTup", "nDeadTup", "autovacuumCount", "walPosition", "sampleMs"] as const) {
        expect(typeof s[k], k).toBe("number");
        expect(Number.isFinite(s[k]), k).toBe(true);
      }
    }
    const off = r.samples.filter((s) => s.sweeper === "off");
    expect(off.length).toBeGreaterThan(0);
    expect(Math.max(...off.map((s) => s.pendingDead))).toBeGreaterThan(0);
    // the measured run ends with its last sample: nothing but the configured sweeper expired holds before it
    expect(r.samples[r.samples.length - 1]!.atS).toBeLessThanOrEqual(r.elapsedS);
    expect(r.samples[r.samples.length - 1]!.progress).toBe(1);
    // the terminal sample's interval was cut short; every other sample closed a full interval
    expect(r.samples.slice(0, -1).every((s) => s.partial === false)).toBe(true);
    expect(r.samples[r.samples.length - 1]!.partial).toBe(true);
    expect(r.sweep.maxBatchesInTick).toBeGreaterThanOrEqual(1);
    expect(r.cleanup.batches).toBeGreaterThanOrEqual(1);
    expect(r.cleanup.pendingDeadAtEnd).toBeGreaterThanOrEqual(0);
    expect(r.cleanup.expired).toBeGreaterThanOrEqual(r.cleanup.pendingDeadAtEnd > 0 ? 1 : 0);
    expect(r.cleanup.cleared).toBe(true);
    const left = await owner.query("select count(*)::int as n from dastar.reservation where venue_id = $1 and status = 'held' and hold_expires_at <= now()", [seed.venue]);
    expect(left.rows[0].n).toBe(0);
    expect(r.samples[r.samples.length - 1]!.walPosition).toBeGreaterThan(r.samples[0]!.walPosition);
    expect(r.samples[r.samples.length - 1]!.retainedUnitRows).toBeGreaterThan(r.samples[0]!.retainedUnitRows);
    expect(Object.keys(r.byCode).sort()).toEqual(["cancel:ok", "confirm:ok", "hold:hold_conflict", "hold:ok"]);
    expect(r.sweep).toMatchObject({ config: sweep, errors: 0 });
    expect(r.sweep.expired).toBeGreaterThan(0);
    expect(r.expiry).toMatchObject({ mode: "owner-aged", ttlSeconds: 60, ageMs: 200, ageErrors: 0 });
    expect(r.expiry.aged).toBeGreaterThan(0);
    // granted and refused holds are timed apart, and every hold is in one of the two
    const timed = r.samples.reduce((n, s) => n + s.holdOkLatencyMs.count + s.holdConflictLatencyMs.count, 0);
    expect(timed).toBe((r.byCode["hold:ok"] ?? 0) + (r.byCode["hold:hold_conflict"] ?? 0));
    await expect(runChurn({ appPool, workerPool, owner, seed }, { maxSeconds: 1, maxOps: 10, workers: 1, seed: 1, sampleEveryMs: 500, ageMs: 200 })).rejects.toThrow(/agerPool/);
    // eight seconds cannot be judged, and the report says so instead of passing
    expect(r.verdict.verdict).toBe("inconclusive");
    expect(r.rules.length).toBeGreaterThan(0);
  });
});

import { describe, it, expect } from "vitest";
import { classify, evaluateTargets, peakOutstanding, runValidity, summarizeStep, timeline, type FollowUpRecord, type HoldRecord, type OfferedWorkload, type RunValidity } from "../src/load.js";
import { DESIGN_SWEEP, type SweepStats } from "../src/sweeper.js";
import { TARGET_BLEND } from "../src/workload.js";

const rec = (over: Partial<HoldRecord>): HoldRecord => ({
  seq: 0, step: 0, mix: "overlapping", cls: "ok", code: "ok", atMs: 0, startedMs: 1, doneMs: 9, e2eMs: 9, e2eCensored: false, stored: null,
  poolWaitMs: 1, poolWaitCensored: false, unitLockMs: 2, unitLockCensored: false, transactionMs: 5, connectionHeldMs: 6, retries: 0, ...over,
});
const many = (n: number, over: Partial<HoldRecord>): HoldRecord[] => Array.from({ length: n }, (_, i) => rec({ seq: i, ...over }));
const followUp = (over: Partial<FollowUpRecord>): FollowUpRecord => ({ kind: "confirm", step: 0, atMs: 0, startedMs: 0, doneMs: 4, code: "ok", e2eMs: 4, ...over });
const sweep = (over: Partial<SweepStats> = {}): SweepStats => ({ config: { everyMs: 5_000, limit: 20, drain: true }, ticks: 3, batches: 3, expired: 0, errors: 0, maxBatchesInTick: 1, ...over });
const VALID: RunValidity = { valid: true, reasons: [] };
// the workload the design defines its targets for: only a step of this shape can end in "met"
const TARGET: OfferedWorkload = { blend: TARGET_BLEND, followUpRatio: 0.2, sweep: DESIGN_SWEEP, units: 40, combos: 10 };
const step = (rs: HoldRecord[], fs: FollowUpRecord[] = []) => summarizeStep(0, { ratePerSec: 50, seconds: 600 }, 0, rs, fs);

describe("load summaries", () => {
  it("classifies answers and errors, and keeps the harness's own transport failures apart from the system's timeouts", () => {
    expect(["ok", "hold_conflict", "timeout", "pool_timeout", "overlap_set_too_large", "shed", "internal", "too_many_live_holds", "transport_timeout", "transport_error"].map(classify))
      .toEqual(["ok", "conflict", "timeout", "unavailable", "unavailable", "shed", "other", "other", "transport", "transport"]);
  });

  it("achieved throughput counts answers inside the step's clock, so a backlog cannot pass as throughput", () => {
    // 600 requests arrive within ten seconds and are answered ten per second over the next minute
    const rs = Array.from({ length: 600 }, (_, i) => rec({ seq: i, atMs: i * (10_000 / 600), startedMs: i * (10_000 / 600), doneMs: i * 100 + 50, e2eMs: i * 100 + 50 - i * (10_000 / 600) }));
    const s = summarizeStep(0, { ratePerSec: 60, seconds: 10 }, 0, rs, []);
    expect(s).toMatchObject({ offered: 600, answeredInWindow: 100, achievedPerSec: 10, backlogAtEnd: 500, errorRate: 0 });
    const t = timeline(rs);
    expect(t).toHaveLength(60);
    expect(t[0]).toMatchObject({ second: 0, arrived: 60, answered: 10, outstanding: 50 });
    expect(t[9]!.outstanding).toBe(500);
    expect(t[59]).toMatchObject({ answered: 10, outstanding: 0 });
    expect(t.reduce((n, b) => n + b.answered, 0)).toBe(600);
    expect(peakOutstanding(rs)).toBeGreaterThanOrEqual(500);
  });

  it("the outstanding peak comes from arrival and answer times, so a burst inside one second is not missed", () => {
    const burst = many(300, { atMs: 100, startedMs: 100, doneMs: 900, e2eMs: 800 });
    expect(Math.max(...timeline(burst).map((b) => b.outstanding))).toBe(0);
    expect(peakOutstanding(burst)).toBe(300);
    // an answer at the same instant as an arrival is counted first: these two never waited together
    expect(peakOutstanding([rec({ atMs: 0, doneMs: 10 }), rec({ atMs: 10, doneMs: 20 })])).toBe(1);
    expect(peakOutstanding([rec({ cls: "shed", code: "shed", doneMs: null })])).toBe(0);
  });

  it("counts conflicts as answers and everything else that failed as errors, by the step a request arrived in", () => {
    const rs = [
      rec({}), rec({ cls: "conflict", code: "hold_conflict" }), rec({ cls: "timeout", code: "timeout", doneMs: 12_000, e2eMs: 12_000, unitLockMs: 11_990, unitLockCensored: true }),
      rec({ cls: "shed", code: "shed", doneMs: null, e2eMs: null, poolWaitMs: null, unitLockMs: null, transactionMs: null, connectionHeldMs: null }),
      rec({ step: 1, atMs: 2_500, startedMs: 2_500, doneMs: 2_510 }),
    ];
    const s = summarizeStep(0, { ratePerSec: 2, seconds: 2 }, 0, rs, [followUp({}), followUp({ kind: "cancel", doneMs: null, code: "skipped", e2eMs: null })]);
    expect(s).toMatchObject({ offered: 4, answeredInWindow: 2, achievedPerSec: 1, backlogAtEnd: 1, errorRate: 0.5, byCode: { ok: 1, hold_conflict: 1, timeout: 1, shed: 1 } });
    expect(s.all.byClass).toEqual({ ok: 1, conflict: 1, timeout: 1, unavailable: 0, other: 0, shed: 1, transport: 0 });
    expect(s.all.e2eMs).toMatchObject({ count: 3, censored: 0, max: { atLeast: 12_000, atMost: 12_000 }, p50: null, p99: null });
    expect(s.all.unitLockMs).toMatchObject({ count: 3, censored: 1, max: { atLeast: 11_990, atMost: null } });
    expect(s.mixes.combos.e2eMs).toEqual({ count: 0, censored: 0, p50: null, p95: null, p99: null, max: null });
    expect(s.followUps).toMatchObject({ offered: 2, byCode: { ok: 1, skipped: 1 } });
    expect(timeline(rs).reduce((n, b) => n + b.errors, 0)).toBe(2);
  });
});

describe("run validity", () => {
  const base = {
    kind: "http" as const, records: many(300, {}), followUps: Array.from({ length: 60 }, () => followUp({})), sweep: sweep(), overlaps: 0, fitViolations: 0, lastStep: step(many(300, {})),
    planned: { holds: 300, followUps: 60 }, targetThrows: 0,
  };

  it("a run is valid when its follow-ups succeeded, its sweeper ran clean, and every request was answered", () => {
    expect(runValidity(base)).toEqual({ valid: true, reasons: [] });
  });

  it("failed confirmations and cancellations, sweeper errors, a sweeper that never ran, broken invariants, and unanswered requests each invalidate it", () => {
    expect(runValidity({ ...base, followUps: Array.from({ length: 60 }, () => followUp({ code: "timeout" })) }).reasons).toEqual([expect.stringMatching(/60 of 60 confirmations and cancellations failed: \{"confirm:timeout":60\}/)]);
    expect(runValidity({ ...base, sweep: sweep({ errors: 2 }) }).reasons).toEqual(["2 sweeper error(s)"]);
    expect(runValidity({ ...base, sweep: sweep({ ticks: 0 }) }).reasons).toEqual(["the sweeper never ran"]);
    expect(runValidity({ ...base, overlaps: 1, fitViolations: 2 }).reasons).toHaveLength(2);
    expect(runValidity({ ...base, followUps: Array.from({ length: 60 }, (_, i) => followUp(i < 40 ? { code: "skipped", doneMs: null, e2eMs: null } : {})) }).reasons).toEqual([expect.stringMatching(/only 20 of 60 planned/)]);
    const unanswered = [...many(298, {}), rec({ cls: "transport", code: "transport_timeout", e2eCensored: true, stored: "granted" }), rec({ cls: "transport", code: "transport_error", stored: "unobserved" })];
    expect(runValidity({ ...base, records: unanswered }).reasons).toEqual([expect.stringMatching(/2 request\(s\) got no complete answer from the API; for the holds among them the database holds 1 granted, 0 refused, 1 with no outcome observed yet/)]);
    expect(runValidity({ ...base, planned: { holds: 301, followUps: 60 } }).reasons).toEqual(["300 of 301 planned holds have a record"]);
    expect(runValidity({ ...base, targetThrows: 1 }).reasons).toEqual(["1 request(s) made the target throw"]);
  });

  it("at the engine handle refused holds invalidate the run, because no judged target there would notice them; over HTTP they are the error-rate target's business", () => {
    const refused = [...many(290, {}), ...many(10, { cls: "timeout", code: "timeout" })];
    expect(runValidity({ ...base, kind: "engine", records: refused, lastStep: step(refused) }).reasons).toEqual([expect.stringMatching(/3\.33 percent of the last step's holds failed/)]);
    expect(runValidity({ ...base, kind: "http", records: refused, lastStep: step(refused) }).valid).toBe(true);
  });

  it("an answer no healthy run produces invalidates a run of either kind: every hold refused as unauthorized is a broken workload, not a slow system", () => {
    const broken = many(300, { cls: "other", code: "unauthorized", e2eMs: 2 });
    for (const kind of ["http", "engine"] as const) {
      expect(runValidity({ ...base, kind, records: broken, lastStep: step(broken) }).reasons).toContainEqual(expect.stringMatching(/300 of 300 holds got an answer no healthy run produces: \{"unauthorized":300\}/));
    }
    // and the fast refusals cannot be read as a met latency target
    expect(evaluateTargets("http", step(broken), 0, runValidity({ ...base, records: broken, lastStep: step(broken) }), TARGET).verdict).toBe("invalid");
    // one stray answer in two thousand is inside the tolerance the error-rate target itself allows
    const stray = [...many(1_999, {}), rec({ cls: "other", code: "internal" })];
    expect(runValidity({ ...base, records: stray, lastStep: step(stray), planned: { holds: 2_000, followUps: 60 } }).valid).toBe(true);
  });
});

describe("design targets", () => {
  it("300 successful holds with 60 failed confirmations is an invalid run, not a met target", () => {
    const rs = many(300, { mix: "distinct_dates" });
    const fs = Array.from({ length: 60 }, () => followUp({ code: "timeout" }));
    const validity = runValidity({ kind: "http", records: rs, followUps: fs, sweep: sweep(), overlaps: 0, fitViolations: 0, lastStep: step(rs, fs), planned: { holds: 300, followUps: 60 }, targetThrows: 0 });
    const v = evaluateTargets("http", step(rs, fs), 0, validity, TARGET);
    expect(v.verdict).toBe("invalid");
    // the hold metrics are still reported; they are just not accepted
    expect(v.checks.find((c) => c.name === "hold end-to-end p99 ms")).toMatchObject({ status: "met", atLeast: 9, atMost: 9 });
  });

  it("300 lock samples that are all lower bounds cannot meet a latency limit", () => {
    const rs = many(300, { mix: "distinct_dates", cls: "timeout", code: "timeout", unitLockMs: 8, unitLockCensored: true });
    const c = evaluateTargets("engine", step(rs), 0, VALID, TARGET).checks.find((x) => x.name.startsWith("unit-lock"))!;
    expect(c).toMatchObject({ atLeast: 8, atMost: null, status: "inconclusive", note: expect.stringContaining("300 of 300 sample(s) are lower bounds") });
    expect(evaluateTargets("engine", step(rs), 0, VALID, TARGET).verdict).toBe("inconclusive");
  });

  it("a lower bound past the limit is a miss; a few censored samples below the percentile position leave a met target met", () => {
    const over = [...many(396, { mix: "distinct_dates" }), ...many(4, { mix: "distinct_dates", cls: "timeout", code: "timeout", unitLockMs: 10_000, unitLockCensored: true })];
    expect(evaluateTargets("engine", step(over), 1, VALID, TARGET).checks.filter((c) => c.status === "missed").map((c) => c.name)).toEqual(["unit-lock phase p99 ms, distinct dates", "deadlocks"]);
    expect(evaluateTargets("engine", step(over), 1, VALID, TARGET).verdict).toBe("missed");
    const two = [...many(398, { mix: "distinct_dates" }), ...many(2, { mix: "distinct_dates", unitLockMs: 1, unitLockCensored: true })];
    expect(evaluateTargets("engine", step(two), 0, VALID, TARGET).checks.find((c) => c.name.startsWith("unit-lock"))).toMatchObject({ status: "met", atLeast: 2, atMost: 2 });
  });

  it("a missing measurement is no data and the verdict is inconclusive, never a pass", () => {
    // 400 requests, none of them in the distinct-dates mix
    const v = evaluateTargets("engine", step(many(400, {})), 0, VALID, TARGET);
    expect(v.checks.find((c) => c.name.startsWith("unit-lock"))).toMatchObject({ atLeast: null, status: "no_data" });
    expect(v.checks.find((c) => c.name.startsWith("pool-acquire"))).toMatchObject({ atLeast: 1, atMost: 1, status: "met" });
    expect(v.verdict).toBe("inconclusive");
    expect(evaluateTargets("engine", summarizeStep(0, { ratePerSec: 1, seconds: 1 }, 0, [], []), 0, VALID, TARGET).verdict).toBe("inconclusive");
  });

  it("each target is judged only by the run that can see it", () => {
    const s = step(many(400, { mix: "distinct_dates", e2eMs: 40 }));
    const engine = evaluateTargets("engine", s, 0, VALID, TARGET);
    expect(engine.checks.filter((c) => c.status === "not_measured").map((c) => c.name)).toEqual(["hold end-to-end p95 ms", "hold end-to-end p99 ms", "error rate excluding conflicts"]);
    expect(engine.verdict).toBe("met");
    const http = evaluateTargets("http", s, 0, VALID, TARGET);
    expect(http.checks.filter((c) => c.status === "not_measured").map((c) => c.name)).toEqual(["pool-acquire wait p99 ms", "unit-lock phase p99 ms, distinct dates"]);
    expect(http.checks.find((c) => c.name === "hold end-to-end p99 ms")).toMatchObject({ scope: "http", atLeast: 40, atMost: 40, status: "met" });
    expect(http.verdict).toBe("met");
  });

  it("a lighter or different workload can miss the targets, never meet them", () => {
    const rs = many(400, { mix: "distinct_dates", e2eMs: 40 });
    const light = evaluateTargets("http", summarizeStep(0, { ratePerSec: 5, seconds: 10 }, 0, rs, []), 0, VALID, TARGET);
    expect(light.checks.every((c) => c.status === "met" || c.status === "not_measured")).toBe(true);
    expect(light.verdict).toBe("inconclusive");
    expect(light.workload).toEqual({ matchesTarget: false, differences: ["offered 5 holds per second; the target is 50", "sustained for 10 s; the target is 600"] });
    const easy = evaluateTargets("engine", step(rs), 0, VALID, { blend: { overlapping: 0, distinct_dates: 1, disjoint_units: 0, combos: 0 }, followUpRatio: 0, sweep: { everyMs: 1_000, limit: 100, drain: true }, units: 6, combos: 2 });
    expect(easy.verdict).toBe("inconclusive");
    expect(easy.workload.differences).toEqual([expect.stringMatching(/^blend /), expect.stringMatching(/^confirmations and cancellations at 0 /), expect.stringMatching(/^sweeper /), expect.stringMatching(/^6 units and 2 combos/)]);
    // a miss under a lighter workload is still a miss
    const slow = evaluateTargets("http", summarizeStep(0, { ratePerSec: 5, seconds: 10 }, 0, many(400, { e2eMs: 900 }), []), 0, VALID, TARGET);
    expect(slow.verdict).toBe("missed");
    // more than the target load, for longer, is still the target workload
    expect(evaluateTargets("http", summarizeStep(0, { ratePerSec: 80, seconds: 900 }, 0, rs, []), 0, VALID, TARGET)).toMatchObject({ verdict: "met", workload: { matchesTarget: true, differences: [] } });
  });

  it("an empty step, a step of nothing but refusals, and a step of nothing but lower bounds: none of them is met", () => {
    expect(evaluateTargets("http", step([]), 0, VALID, TARGET).verdict).toBe("inconclusive");
    expect(evaluateTargets("http", step(many(400, { cls: "shed", code: "shed", doneMs: null, e2eMs: null })), 0, VALID, TARGET).verdict).toBe("missed");
    const lost = many(400, { cls: "transport", code: "transport_error", e2eMs: 1, e2eCensored: true, stored: "unobserved" });
    const v = evaluateTargets("http", step(lost), 0, VALID, TARGET);
    // a connection that failed after 1 ms says an answer would have taken at least 1 ms, not that it took 1 ms
    expect(v.checks.find((c) => c.name === "hold end-to-end p95 ms")).toMatchObject({ atLeast: 1, atMost: null, status: "inconclusive" });
    expect(v.checks.find((c) => c.name === "error rate excluding conflicts")).toMatchObject({ status: "missed" });
  });

  it("a follow-up whose connection failed is a lower bound too", () => {
    const fs = Array.from({ length: 10 }, () => followUp({ code: "transport_error", e2eMs: 1 }));
    expect(step(many(10, {}), fs).followUps.e2eMs).toMatchObject({ censored: 10, max: { atLeast: 1, atMost: null } });
  });

  it("over HTTP a request the harness gave up on is a lower bound on end-to-end latency", () => {
    const rs = [...many(395, { mix: "distinct_dates", e2eMs: 40 }), ...many(5, { mix: "distinct_dates", cls: "transport", code: "transport_timeout", e2eMs: 30_000, e2eCensored: true, stored: "unobserved" })];
    expect(evaluateTargets("http", step(rs), 0, VALID, TARGET).checks.find((c) => c.name === "hold end-to-end p99 ms")).toMatchObject({ atLeast: 30_000, atMost: null, status: "missed" });
  });
});

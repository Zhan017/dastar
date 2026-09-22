import { cpus } from "node:os";
import type { ClientBase, Pool } from "pg";
import { createDastar } from "@dastar/db";
import type { BenchSeed } from "./seed.js";
import { rng } from "./rng.js";
import { planArrivals, runOpenLoop, type Arrival, type Step } from "./schedule.js";
import { holdFactory, pickMix, MIXES, TARGET_BLEND, type Blend, type Mix } from "./workload.js";
import { dist, exact, type Dist, type Quantile, type Sample } from "./stats.js";
import { deadlocksStable, fitViolations } from "./observe.js";
import { overlapPairs } from "./race.js";
import { startSweeper, DESIGN_SWEEP, type SweepConfig, type SweepStats } from "./sweeper.js";
import type { LoadTarget, Phases } from "./target.js";

/**
 * conflict is a legitimate answer; timeout, unavailable, other, shed, and transport count as errors.
 * timeout is the system's own answer; transport means the harness got no complete answer at all.
 */
export type OutcomeClass = "ok" | "conflict" | "timeout" | "unavailable" | "other" | "shed" | "transport";
const CLASSES: readonly OutcomeClass[] = ["ok", "conflict", "timeout", "unavailable", "other", "shed", "transport"];
const isError = (c: OutcomeClass): boolean => c !== "ok" && c !== "conflict";

export function classify(code: string): OutcomeClass {
  if (code === "ok") return "ok";
  if (code === "hold_conflict") return "conflict";
  if (code === "timeout") return "timeout";
  if (code === "pool_timeout" || code === "overlap_set_too_large") return "unavailable";
  if (code === "shed") return "shed";
  if (code === "transport_timeout" || code === "transport_error") return "transport";
  return "other";
}

/** One request. Times are milliseconds from the start of the arrival plan. A shed request has no `doneMs`. */
export type HoldRecord = {
  seq: number; step: number; mix: Mix; cls: OutcomeClass; code: string;
  /** Planned arrival, actual start, and answer. `startedMs - atMs` is the dispatcher's lag. */
  atMs: number; startedMs: number; doneMs: number | null;
  /** From the planned arrival to the answer, so dispatcher lag and queueing count. Censored when the harness got no complete answer (it gave up waiting, or the connection failed): an answer would have taken at least this long. */
  e2eMs: number | null; e2eCensored: boolean;
  /** Only for a request the harness got no complete answer to: whether the database holds its committed outcome. */
  committed: boolean | null;
} & Phases;
export type FollowUpRecord = { kind: "confirm" | "cancel"; step: number; atMs: number; startedMs: number; doneMs: number | null; code: string; e2eMs: number | null };

const NO_PHASES: Phases = { poolWaitMs: null, poolWaitCensored: false, unitLockMs: null, unitLockCensored: false, transactionMs: null, connectionHeldMs: null, retries: 0 };

export type SessionOptions = {
  runId: string; seed: number; blend: Blend;
  /** Arrivals beyond this many unanswered requests are recorded as shed instead of started. Default 2000. */
  maxInFlight?: number;
  /** Default: the design's sweeper. */
  sweep?: SweepConfig;
};
export type LoadDeps = { target: LoadTarget; workerPool: Pool; seed: BenchSeed };

export type LoadSession = {
  hold: (a: Arrival, lateMs: number) => void;
  followUp: (a: Arrival, lateMs: number) => void;
  readonly records: HoldRecord[];
  readonly followUps: FollowUpRecord[];
  readonly sweep: SweepStats;
  /** Resolves when every started request has an answer. */
  drain: () => Promise<void>;
  /** Stops the sweeper. The target belongs to the caller. */
  close: () => Promise<void>;
};

/** Per-request bookkeeping around a target, and the sweeper on the worker pool. */
export function openSession(deps: LoadDeps, opts: SessionOptions): LoadSession {
  const worker = createDastar({ pool: deps.workerPool });
  const sweeper = startSweeper(worker, opts.sweep ?? DESIGN_SWEEP);
  const r = rng(opts.seed);
  const nextHold = holdFactory(deps.seed, r, opts.runId);
  const maxInFlight = opts.maxInFlight ?? 2_000;
  const records: HoldRecord[] = [];
  const followUps: FollowUpRecord[] = [];
  const recent: string[] = [];
  const inFlight = new Set<Promise<void>>();
  const track = (p: Promise<void>): void => {
    inFlight.add(p);
    void p.finally(() => { inFlight.delete(p); });
  };

  const hold = (a: Arrival, lateMs: number): void => {
    const mix = pickMix(opts.blend, r);
    const input = nextHold(mix, a.seq);
    const startedMs = a.atMs + lateMs;
    if (inFlight.size >= maxInFlight) {
      records.push({ seq: a.seq, step: a.step, mix, cls: "shed", code: "shed", atMs: a.atMs, startedMs, doneMs: null, e2eMs: null, e2eCensored: false, committed: null, ...NO_PHASES });
      return;
    }
    const fired = performance.now();
    track((async (): Promise<void> => {
      const answer = await deps.target.hold(input);
      const took = performance.now() - fired;
      if (answer.reservationId !== null) {
        recent.push(answer.reservationId);
        if (recent.length > 1_000) recent.shift();
      }
      records.push({
        seq: a.seq, step: a.step, mix, cls: classify(answer.code), code: answer.code,
        atMs: a.atMs, startedMs, doneMs: startedMs + took, e2eMs: lateMs + took, e2eCensored: classify(answer.code) === "transport", committed: null,
        ...(answer.phases ?? NO_PHASES),
      });
    })());
  };

  const followUp = (a: Arrival, lateMs: number): void => {
    const kind = a.seq % 2 === 0 ? "confirm" : "cancel";
    const startedMs = a.atMs + lateMs;
    const reservationId = recent.pop();
    if (reservationId === undefined) {
      followUps.push({ kind, step: a.step, atMs: a.atMs, startedMs, doneMs: null, code: "skipped", e2eMs: null });
      return;
    }
    const fired = performance.now();
    const traceId = `${opts.runId}-f${a.seq}`;
    track((async (): Promise<void> => {
      const code = await (kind === "confirm" ? deps.target.confirm(reservationId, deps.seed.venue, traceId) : deps.target.cancel(reservationId, deps.seed.venue, traceId));
      const took = performance.now() - fired;
      followUps.push({ kind, step: a.step, atMs: a.atMs, startedMs, doneMs: startedMs + took, code, e2eMs: lateMs + took });
    })());
  };

  return {
    hold, followUp, records, followUps, sweep: sweeper.stats,
    drain: async () => { while (inFlight.size > 0) await Promise.allSettled([...inFlight]); },
    close: async () => { await sweeper.stop(); await worker.close(); },
  };
}

/** Opens every connection the pool allows before anything is measured, so connection setup is not counted as pool wait. */
export async function warmPool(pool: Pool): Promise<void> {
  const clients = await Promise.all(Array.from({ length: pool.options.max ?? 10 }, () => pool.connect()));
  for (const c of clients) c.release();
}

export type MixSummary = {
  offered: number; byClass: Record<OutcomeClass, number>;
  e2eMs: Dist; poolWaitMs: Dist; unitLockMs: Dist; transactionMs: Dist; connectionHeldMs: Dist;
};

const samples = <T>(rs: readonly T[], ms: (x: T) => number | null, censored: (x: T) => boolean = () => false): Sample[] =>
  rs.flatMap((x) => { const v = ms(x); return v === null ? [] : [{ ms: v, censored: censored(x) }]; });

export function summarizeMix(rs: readonly HoldRecord[]): MixSummary {
  const byClass = Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<OutcomeClass, number>;
  for (const x of rs) byClass[x.cls] += 1;
  return {
    offered: rs.length, byClass,
    e2eMs: dist(samples(rs, (x) => x.e2eMs, (x) => x.e2eCensored)),
    poolWaitMs: dist(samples(rs, (x) => x.poolWaitMs, (x) => x.poolWaitCensored)),
    unitLockMs: dist(samples(rs, (x) => x.unitLockMs, (x) => x.unitLockCensored)),
    transactionMs: dist(samples(rs, (x) => x.transactionMs)),
    connectionHeldMs: dist(samples(rs, (x) => x.connectionHeldMs)),
  };
}

export type StepSummary = {
  step: number; ratePerSec: number; seconds: number; fromMs: number; toMs: number;
  /** Planned arrivals in this step; fixed before the run. */
  offered: number;
  /** Requests answered with ok or a domain answer while this step's clock was running, whichever step they arrived in. */
  answeredInWindow: number;
  /** `answeredInWindow` over the step's seconds: what the system actually got through, as opposed to what was offered. */
  achievedPerSec: number;
  /** Requests that had arrived by the end of this step and had no answer yet. A number that grows from step to step is saturation. */
  backlogAtEnd: number;
  /** Of the requests that arrived in this step: timeout, unavailable, other, and shed over offered. Conflicts are answers. */
  errorRate: number;
  byCode: Record<string, number>;
  dispatchLagMs: Dist;
  all: MixSummary;
  mixes: Record<Mix, MixSummary>;
  followUps: { offered: number; byCode: Record<string, number>; e2eMs: Dist };
};

export function summarizeStep(step: number, s: Step, fromMs: number, holds: readonly HoldRecord[], follow: readonly FollowUpRecord[]): StepSummary {
  const toMs = fromMs + s.seconds * 1_000;
  const rs = holds.filter((x) => x.step === step);
  const fs = follow.filter((x) => x.step === step);
  const all = summarizeMix(rs);
  const byCode: Record<string, number> = {};
  for (const x of rs) byCode[x.code] = (byCode[x.code] ?? 0) + 1;
  const followByCode: Record<string, number> = {};
  for (const x of fs) followByCode[x.code] = (followByCode[x.code] ?? 0) + 1;
  const answeredInWindow = holds.filter((x) => x.doneMs !== null && x.doneMs >= fromMs && x.doneMs < toMs && !isError(x.cls)).length;
  const backlogAtEnd = holds.filter((x) => x.cls !== "shed" && x.atMs < toMs && (x.doneMs === null || x.doneMs >= toMs)).length;
  return {
    step, ratePerSec: s.ratePerSec, seconds: s.seconds, fromMs, toMs, offered: rs.length,
    answeredInWindow, achievedPerSec: answeredInWindow / s.seconds, backlogAtEnd,
    errorRate: rs.length === 0 ? 0 : rs.filter((x) => isError(x.cls)).length / rs.length,
    byCode,
    dispatchLagMs: dist(exact(rs.map((x) => x.startedMs - x.atMs))),
    all,
    mixes: Object.fromEntries(MIXES.map((m) => [m, summarizeMix(rs.filter((x) => x.mix === m))])) as Record<Mix, MixSummary>,
    followUps: { offered: fs.length, byCode: followByCode, e2eMs: dist(samples(fs, (x) => x.e2eMs, (x) => classify(x.code) === "transport")) },
  };
}

export type TimelineBucket = { second: number; arrived: number; answered: number; errors: number; outstanding: number };

/** One row per second from the first arrival to the last answer: what arrived, what was answered, what failed, and what was still waiting. */
export function timeline(holds: readonly HoldRecord[]): TimelineBucket[] {
  const end = Math.max(0, ...holds.map((x) => x.doneMs ?? x.atMs));
  const n = Math.floor(end / 1_000) + 1;
  const out: TimelineBucket[] = Array.from({ length: n }, (_, second) => ({ second, arrived: 0, answered: 0, errors: 0, outstanding: 0 }));
  // a request is outstanding at the end of every second from the one it arrived in up to, not including, the one it was answered in
  const change = new Array<number>(n + 1).fill(0);
  for (const x of holds) {
    const arrivedIn = Math.floor(x.atMs / 1_000);
    out[arrivedIn]!.arrived += 1;
    if (x.doneMs === null) { out[arrivedIn]!.errors += 1; continue; }
    const answeredIn = Math.floor(x.doneMs / 1_000);
    if (isError(x.cls)) out[answeredIn]!.errors += 1; else out[answeredIn]!.answered += 1;
    change[arrivedIn]! += 1;
    change[answeredIn]! -= 1;
  }
  let waiting = 0;
  for (let k = 0; k < n; k++) {
    waiting += change[k]!;
    out[k]!.outstanding = waiting;
  }
  return out;
}

/**
 * The most requests that were waiting for an answer at one instant, from every request's planned arrival
 * and answer time. A per-second sample would miss a burst that arrives and clears inside one second.
 */
export function peakOutstanding(holds: readonly HoldRecord[]): number {
  const events: [number, number][] = [];
  for (const x of holds) if (x.doneMs !== null) events.push([x.atMs, 1], [x.doneMs, -1]);
  // at the same instant an answer is counted before an arrival
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0;
  let peak = 0;
  for (const [, change] of events) { now += change; peak = Math.max(peak, now); }
  return peak;
}

export type RunValidity = { valid: boolean; reasons: string[] };

/**
 * Whether the run did what it was asked to, judged apart from how fast the holds were. Hold metrics from a
 * run whose follow-ups failed, whose sweeper failed, or whose requests went unanswered describe a broken
 * workload, and no verdict is taken from them.
 */
export function runValidity(run: {
  kind: LoadTarget["kind"]; records: readonly HoldRecord[]; followUps: readonly FollowUpRecord[]; sweep: SweepStats;
  overlaps: number; fitViolations: number; lastStep: StepSummary | undefined;
}): RunValidity {
  const reasons: string[] = [];
  if (run.sweep.errors > 0) reasons.push(`${run.sweep.errors} sweeper error(s)`);
  if (run.sweep.ticks === 0) reasons.push("the sweeper never ran");
  if (run.overlaps > 0) reasons.push(`${run.overlaps} overlapping pair(s) of active unit rows`);
  if (run.fitViolations > 0) reasons.push(`${run.fitViolations} live reservation(s) outside their capacity`);
  const executed = run.followUps.filter((x) => x.code !== "skipped");
  const failedFollowUps = executed.filter((x) => x.code !== "ok");
  if (executed.length > 0 && failedFollowUps.length / executed.length > 0.001) {
    const byCode: Record<string, number> = {};
    for (const x of failedFollowUps) byCode[`${x.kind}:${x.code}`] = (byCode[`${x.kind}:${x.code}`] ?? 0) + 1;
    reasons.push(`${failedFollowUps.length} of ${executed.length} confirmations and cancellations failed: ${JSON.stringify(byCode)}`);
  }
  if (run.followUps.length > 0 && executed.length < run.followUps.length * 0.5) {
    reasons.push(`only ${executed.length} of ${run.followUps.length} planned confirmations and cancellations had a hold to act on`);
  }
  const unanswered = run.records.filter((x) => x.cls === "transport").length + run.followUps.filter((x) => classify(x.code) === "transport").length;
  if (unanswered > 0) {
    const committed = run.records.filter((x) => x.cls === "transport" && x.committed === true).length;
    reasons.push(`${unanswered} request(s) got no complete answer from the API; the database shows ${committed} of the holds among them committed anyway`);
  }
  // refusals for load (timeout, unavailable, shed) are results; an answer of any other kind means the workload itself is broken
  const strange = run.records.filter((x) => x.cls === "other");
  if (run.records.length > 0 && strange.length / run.records.length > 0.001) {
    const byCode: Record<string, number> = {};
    for (const x of strange) byCode[x.code] = (byCode[x.code] ?? 0) + 1;
    reasons.push(`${strange.length} of ${run.records.length} holds got an answer no healthy run produces: ${JSON.stringify(byCode)}`);
  }
  // over HTTP the hold error rate is a judged target; at the engine handle nothing else would notice failed holds
  if (run.kind === "engine" && run.lastStep !== undefined && run.lastStep.errorRate > 0.001) {
    reasons.push(`${(run.lastStep.errorRate * 100).toFixed(2)} percent of the last step's holds failed: ${JSON.stringify(run.lastStep.byCode)}`);
  }
  return { valid: reasons.length === 0, reasons };
}

export type TargetCheck = {
  name: string;
  /** Where the number comes from. The design's end-to-end targets are defined at the API; pool wait and the unit-lock phase can only be seen at the engine handle. */
  scope: "http" | "engine" | "database";
  limit: number;
  /** The value, as bounds: equal for an exact value, apart when censored samples leave room, `atMost` null when they leave it unbounded. */
  atLeast: number | null; atMost: number | null;
  /**
   * met: even if every censored sample had never finished, the limit holds. missed: the lower bound already
   * breaks it. inconclusive: the bounds straddle the limit. no_data: too few samples to state the
   * percentile. not_measured: this run's target cannot observe it.
   */
  status: "met" | "missed" | "inconclusive" | "no_data" | "not_measured";
  note?: string;
};
/** What a run offered, next to the shape the design defines its targets for (section 6.5). */
export type OfferedWorkload = { blend: Blend; followUpRatio: number; sweep: SweepConfig; units: number; combos: number };
export const TARGET_WORKLOAD = { ratePerSec: 50, seconds: 600, blend: TARGET_BLEND, followUpRatio: 0.2, sweep: DESIGN_SWEEP, units: 40, combos: 10 } as const;

/** Every way the judged step differs from the target workload. A lighter or different workload can miss the targets; it cannot meet them. */
export function workloadDifferences(s: StepSummary, w: OfferedWorkload): string[] {
  const t = TARGET_WORKLOAD;
  const out: string[] = [];
  if (s.ratePerSec < t.ratePerSec) out.push(`offered ${s.ratePerSec} holds per second; the target is ${t.ratePerSec}`);
  if (s.seconds < t.seconds) out.push(`sustained for ${s.seconds} s; the target is ${t.seconds}`);
  if (MIXES.some((m) => Math.abs(w.blend[m] - t.blend[m]) > 1e-9)) out.push(`blend ${JSON.stringify(w.blend)}; the target is ${JSON.stringify(t.blend)}`);
  if (Math.abs(w.followUpRatio - t.followUpRatio) > 1e-9) out.push(`confirmations and cancellations at ${w.followUpRatio} of hold volume; the target is ${t.followUpRatio}`);
  if (w.sweep.everyMs !== t.sweep.everyMs || w.sweep.limit !== t.sweep.limit || w.sweep.drain !== t.sweep.drain) out.push(`sweeper ${JSON.stringify(w.sweep)}; the design's is ${JSON.stringify(t.sweep)}`);
  if (w.units !== t.units || w.combos !== t.combos) out.push(`${w.units} units and ${w.combos} combos; the target is ${t.units} and ${t.combos}`);
  return out;
}

export type TargetVerdict = {
  verdict: "met" | "missed" | "inconclusive" | "invalid"; checks: TargetCheck[];
  /** Whether the judged step offered the workload the targets are defined for. If not, the verdict is never "met". */
  workload: { matchesTarget: boolean; differences: string[] };
};

/**
 * The provisional targets of the system design, section 6.5, applied to one step. Only meaningful on the
 * target hardware class, only for a valid run (an invalid run's verdict is "invalid" whatever its holds did),
 * and only for the workload the targets are defined for: any other workload can end in "missed", never in "met".
 */
export function evaluateTargets(kind: LoadTarget["kind"], s: StepSummary, deadlockDelta: number, validity: RunValidity, offered: OfferedWorkload): TargetVerdict {
  const bounded = (name: string, scope: TargetCheck["scope"], q: Quantile | null, limit: number, note?: string): TargetCheck => {
    const status = q === null ? "no_data" : q.atLeast > limit ? "missed" : q.atMost !== null && q.atMost <= limit ? "met" : "inconclusive";
    return { name, scope, limit, atLeast: q?.atLeast ?? null, atMost: q?.atMost ?? null, status, ...(note !== undefined ? { note } : {}) };
  };
  const exactly = (name: string, scope: TargetCheck["scope"], value: number | null, limit: number): TargetCheck =>
    bounded(name, scope, value === null ? null : { atLeast: value, atMost: value }, limit);
  const elsewhere = (name: string, scope: TargetCheck["scope"], limit: number, note: string): TargetCheck => ({ name, scope, limit, atLeast: null, atMost: null, status: "not_measured", note });
  const censoredNote = (d: Dist, what: string): string => `${what}; ${d.censored} of ${d.count} sample(s) are lower bounds, because the request ended inside the phase`;
  const lock = s.mixes.distinct_dates.unitLockMs;
  const checks: TargetCheck[] = kind === "http"
    ? [
      bounded("hold end-to-end p95 ms", "http", s.all.e2eMs.p95, 150, censoredNote(s.all.e2eMs, "planned arrival to the API's answer")),
      bounded("hold end-to-end p99 ms", "http", s.all.e2eMs.p99, 500, censoredNote(s.all.e2eMs, "planned arrival to the API's answer")),
      exactly("error rate excluding conflicts", "http", s.offered === 0 ? null : s.errorRate, 0.001),
      elsewhere("pool-acquire wait p99 ms", "engine", 50, "not observable over HTTP; run the same plan with the engine target"),
      elsewhere("unit-lock phase p99 ms, distinct dates", "engine", 100, "not observable over HTTP; run the same plan with the engine target"),
    ]
    : [
      elsewhere("hold end-to-end p95 ms", "http", 150, "defined at the API: authentication, validation, and the key lookup's pool checkout are outside the engine target"),
      elsewhere("hold end-to-end p99 ms", "http", 500, "defined at the API; see above"),
      elsewhere("error rate excluding conflicts", "http", 0.001, "defined at the API; see above"),
      bounded("pool-acquire wait p99 ms", "engine", s.all.poolWaitMs.p99, 50, censoredNote(s.all.poolWaitMs, "the command's checkout only")),
      bounded("unit-lock phase p99 ms, distinct dates", "engine", lock.p99, 100, censoredNote(lock, "lock statements: round trips plus advisory-lock wait")),
    ];
  checks.push(exactly("deadlocks", "database", deadlockDelta, 0));
  const evaluated = checks.filter((c) => c.status !== "not_measured");
  const differences = workloadDifferences(s, offered);
  const verdict = !validity.valid ? "invalid"
    : evaluated.some((c) => c.status === "missed") ? "missed"
    : differences.length > 0 || evaluated.some((c) => c.status === "no_data" || c.status === "inconclusive") ? "inconclusive" : "met";
  return { verdict, checks, workload: { matchesTarget: differences.length === 0, differences } };
}

export type Environment = { node: string; cpus: number; cpuModel: string; postgres: string; poolMax: number };

export async function environment(owner: ClientBase, poolMax: number): Promise<Environment> {
  const v = await owner.query("select version() as v");
  return { node: process.version, cpus: cpus().length, cpuModel: cpus()[0]?.model ?? "unknown", postgres: v.rows[0].v as string, poolMax };
}

export type LoadOptions = Omit<SessionOptions, "runId"> & {
  steps: Step[];
  /** Confirm and cancel arrivals as a fraction of hold arrivals. Default 0.2. */
  followUpRatio?: number;
  /** "provisional" for any machine outside the target hardware class. */
  label: "provisional" | "target-hardware";
  /** Pool size of the system under test, for the report. */
  poolMax: number;
};
export type LoadReport = {
  command: "load"; label: LoadOptions["label"]; target: LoadTarget["kind"]; runId: string; seed: number; blend: Blend; environment: Environment;
  steps: StepSummary[]; timeline: TimelineBucket[];
  /** From the end of the arrival plan to the last answer of any request, and to the last answer of a hold. */
  drainMs: number; holdDrainMs: number;
  /** The most holds waiting for an answer at one instant. */
  peakOutstanding: number;
  /** Judged before any target: did the workload itself run as asked? */
  validity: RunValidity;
  /** Requests the harness got no complete answer to, and what the database says became of the holds among them. */
  transport: { timeouts: number; errors: number; holdsCommitted: number; holdsNotCommitted: number };
  retries: number; sweep: SweepStats;
  deadlockDelta: number; overlaps: number; fitViolations: number; elapsedMs: number;
  /** Present only for label "target-hardware": the last step against the design targets. */
  targets?: TargetVerdict;
  /** Every request, so any other question can be answered from the report. */
  records: HoldRecord[]; followUps: FollowUpRecord[];
};

export async function runLoad(deps: LoadDeps & { owner: ClientBase }, opts: LoadOptions): Promise<LoadReport> {
  const runId = `load${Date.now().toString(36)}`;
  const before = await deadlocksStable(deps.owner);
  const session = openSession(deps, { ...opts, runId });
  const holds = planArrivals(opts.steps, rng(opts.seed + 1));
  const ratio = opts.followUpRatio ?? 0.2;
  const follow = planArrivals(opts.steps.map((s) => ({ ratePerSec: s.ratePerSec * ratio, seconds: s.seconds })), rng(opts.seed + 2));
  const epoch = performance.now();
  await Promise.all([runOpenLoop(holds, session.hold, { epoch }), runOpenLoop(follow, session.followUp, { epoch })]);
  await session.drain();
  const elapsedMs = performance.now() - epoch;
  await session.close();
  const deadlockDelta = (await deadlocksStable(deps.owner)) - before;
  let fromMs = 0;
  const steps = opts.steps.map((s, i) => {
    const summary = summarizeStep(i, s, fromMs, session.records, session.followUps);
    fromMs = summary.toMs;
    return summary;
  });
  const buckets = timeline(session.records);
  // a client that got no answer does not know what the database did; the idempotency row does
  const unanswered = session.records.filter((x) => x.cls === "transport");
  if (unanswered.length > 0) {
    const rows = await deps.owner.query("select key from dastar.idempotency where venue_id = $1 and key = any($2::text[]) and response is not null", [deps.seed.venue, unanswered.map((x) => `${runId}-h${x.seq}`)]);
    const stored = new Set(rows.rows.map((x) => x.key as string));
    for (const x of unanswered) x.committed = stored.has(`${runId}-h${x.seq}`);
  }
  const lastHold = Math.max(0, ...session.records.map((x) => x.doneMs ?? 0));
  const lastAnswer = Math.max(lastHold, ...session.followUps.map((x) => x.doneMs ?? 0));
  const overlaps = await overlapPairs(deps.owner);
  const fit = await fitViolations(deps.owner);
  const validity = runValidity({ kind: deps.target.kind, records: session.records, followUps: session.followUps, sweep: session.sweep, overlaps, fitViolations: fit, lastStep: steps[steps.length - 1] });
  const all = [...session.records.map((x) => x.code), ...session.followUps.map((x) => x.code)];
  const report: LoadReport = {
    command: "load", label: opts.label, target: deps.target.kind, runId, seed: opts.seed, blend: opts.blend,
    environment: await environment(deps.owner, opts.poolMax),
    steps, timeline: buckets, drainMs: Math.max(0, lastAnswer - fromMs), holdDrainMs: Math.max(0, lastHold - fromMs), peakOutstanding: peakOutstanding(session.records),
    validity,
    transport: {
      timeouts: all.filter((c) => c === "transport_timeout").length, errors: all.filter((c) => c === "transport_error").length,
      holdsCommitted: unanswered.filter((x) => x.committed === true).length, holdsNotCommitted: unanswered.filter((x) => x.committed === false).length,
    },
    retries: session.records.reduce((n, x) => n + x.retries, 0), sweep: session.sweep,
    deadlockDelta, overlaps, fitViolations: fit, elapsedMs,
    records: session.records, followUps: session.followUps,
  };
  if (opts.label === "target-hardware") {
    report.targets = evaluateTargets(deps.target.kind, steps[steps.length - 1]!, deadlockDelta, validity,
      { blend: opts.blend, followUpRatio: ratio, sweep: opts.sweep ?? DESIGN_SWEEP, units: deps.seed.units.length, combos: deps.seed.combos.length });
  }
  return report;
}

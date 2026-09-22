import type { ClientBase, Pool, PoolConfig } from "pg";
import { createDastar, type Dastar } from "@dastar/db";
import type { BenchSeed } from "./seed.js";
import { rng } from "./rng.js";
import { dist, exact, type Dist } from "./stats.js";
import { startSweeper, DESIGN_SWEEP, type SweepConfig, type SweepStats } from "./sweeper.js";
import { environment, type Environment } from "./load.js";
import { waitFor } from "./observe.js";

export type ChurnOptions = {
  /** The run ends at whichever comes first. The design's bounded run is 1800 s or 100 000 operations. */
  maxSeconds: number; maxOps: number;
  workers: number; seed: number;
  /** 60 000 for a real run. */
  sampleEveryMs: number;
  /** Default: the design's sweeper. It is paused between 40 and 60 percent of the run. */
  sweep?: SweepConfig;
  /**
   * When set, a hold that is left to expire is moved to now + ageMs by the owner role, one row per
   * statement, instead of waiting out the schema's 60-second minimum TTL. Off for a real run. Needs `agerPool`.
   */
  ageMs?: number;
};
/** `agerPool` is an owner-role pool built with `agerPoolConfig`; only a run with `ageMs` uses it. */
export type ChurnDeps = { appPool: Pool; workerPool: Pool; owner: ClientBase; agerPool?: Pool; seed: BenchSeed };

/**
 * A pool for the ager. Every worker ages its own holds, so one shared connection would queue the workers
 * behind each other. The actor and trace id the audit trigger reads arrive as startup options, so each
 * statement stays a single autocommit update: one row lock held, nothing else waited for, no lock cycle.
 */
export const agerPoolConfig = (ownerUrl: string, max: number): PoolConfig =>
  ({ connectionString: ownerUrl, max, options: "-c dastar.actor=bench:ager -c dastar.trace_id=ager" });

export type ChurnSample = {
  atS: number; progress: number; ops: number; sweeper: "on" | "off";
  /** Unit rows are kept as history, so this only grows. */
  retainedUnitRows: number; activeUnitRows: number;
  /** Held rows past their expiry that nobody has expired yet. */
  pendingDead: number;
  heapBytes: number; exclusionIndexBytes: number; totalBytes: number;
  heapDeadTuplePercent: number; heapFreePercent: number; indexFreePercent: number;
  nLiveTup: number; nDeadTup: number; autovacuumCount: number; autoanalyzeCount: number; lastAutovacuum: string | null;
  /** Cluster-wide WAL position in bytes; only the difference between two samples is this run's WAL. */
  walPosition: number;
  /** How long the sample's own statistics query took. */
  sampleMs: number;
  /** Holds that were granted, and holds refused as conflicts, kept apart: a refusal is cheaper, so a shift in their mix would move a shared percentile on its own. Each distribution covers only the holds answered since the previous sample. */
  holdOkLatencyMs: Dist; holdConflictLatencyMs: Dist;
  /** The interval this sample closes was cut short (the terminal sample after the workers stopped); its storage numbers count, its latency does not, because a short interval has too few holds to compare with a full one. */
  partial: boolean;
};
/** invalid: the workload itself failed, so the storage numbers describe a broken run and are not judged. */
export type ChurnVerdict = { verdict: "pass" | "fail" | "inconclusive" | "invalid"; reasons: string[] };
export type ChurnReport = {
  command: "churn"; runId: string; seed: number; environment: Environment; options: ChurnOptions;
  ops: number; byCode: Record<string, number>; elapsedS: number;
  /** The configured sweeper's work during the measured run. Nothing else expired holds while samples were taken. */
  sweep: SweepStats;
  /**
   * After the last sample and outside the verdict: dead holds left over are expired in the same batch size,
   * so the database is left tidy. `pendingDeadAtEnd` is what the measured run left behind; it is a result.
   * A cleanup that does not finish inside its budget is reported as `cleared: false`, not thrown: the report
   * is returned either way.
   */
  cleanup: { pendingDeadAtEnd: number; batches: number; expired: number; ms: number; cleared: boolean };
  /** Set when the sampling loop itself failed; the verdict reads invalid rather than trusting a broken sample. */
  sampleError: string | null;
  /** owner-aged: holds left to expire were moved to the edge of expiry by the owner role; natural-ttl: they waited out the venue's TTL. */
  expiry: { mode: "natural-ttl" | "owner-aged"; ttlSeconds: number; ageMs: number | null; aged: number; ageErrors: number };
  samples: ChurnSample[]; verdict: ChurnVerdict; rules: string[];
};

const SAMPLE_SQL = `
  select
    (select count(*) from dastar.reservation_unit)::int as retained,
    (select count(*) from dastar.reservation_unit where active)::int as active,
    (select count(*) from dastar.reservation where status = 'held' and hold_expires_at <= now())::int as pending_dead,
    pg_relation_size('dastar.reservation_unit')::float8 as heap_bytes,
    pg_relation_size('dastar.reservation_unit_no_overlap')::float8 as excl_bytes,
    pg_total_relation_size('dastar.reservation_unit')::float8 as total_bytes,
    h.dead_tuple_percent as heap_dead_pct, h.free_percent as heap_free_pct, i.free_percent as index_free_pct,
    s.n_live_tup::float8 as n_live, s.n_dead_tup::float8 as n_dead, s.autovacuum_count::int as autovacuum_count,
    s.autoanalyze_count::int as autoanalyze_count, s.last_autovacuum,
    pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')::float8 as wal_position
  from pg_stat_user_tables s,
       public.pgstattuple('dastar.reservation_unit') h,
       public.pgstattuple('dastar.reservation_unit_no_overlap') i
  where s.schemaname = 'dastar' and s.relname = 'reservation_unit'`;

/** This harness's reading of the design's provisional pass condition (section 15.1); the thresholds are its own and provisional. */
export const CHURN_RULES: readonly string[] = [
  "windows: 'before' is progress 0.15 to 0.40, ahead of the sweeper-off phase (0.40 to 0.60); 'after' is progress 0.75 to 1.00",
  "invalid: any operation answered outside hold ok or hold_conflict, cancel ok, confirm ok; any sweeper error; a sweeper that never ran; any failed aging statement; a sampler failure; or no hold succeeded",
  "inconclusive: fewer than five samples in either window; fewer than three autovacuum runs on reservation_unit; a sample with too few granted holds to state p95",
  "inconclusive: neither of the design's bounds was reached (1800 s or 100 000 operations)",
  "inconclusive: mean active unit rows after is outside 0.75 to 1.25 times the mean before, so the windows are not comparable",
  "inconclusive: dead holds did not pile up while the sweeper was off (peak under 10, or under three times the mean before)",
  "fail: dead holds were not cleared afterwards (mean after above 10 and above twice the mean before)",
  "fail: exclusion index: largest size after above 1.25 times the largest before, or a fitted rise across the after window above 10 percent of its mean",
  "fail: heap dead-tuple percent: mean after above the mean before plus 5 points, or a fitted rise across the after window above 5 points",
  "fail: heap bytes per retained unit row: mean after above 1.25 times the mean before, or a fitted rise across the after window above 10 percent",
  "fail: p95 of granted holds: mean after above 1.5 times the mean before plus 1 ms, or a fitted rise across the after window above 25 percent plus 1 ms",
  "latency is judged on full-interval samples only; the terminal sample after the workers stop is partial and reported, not judged",
];

const EXPECTED_CODES: ReadonlySet<string> = new Set(["hold:ok", "hold:hold_conflict", "cancel:ok", "confirm:ok"]);
const mean = (xs: number[]): number => xs.reduce((a, x) => a + x, 0) / xs.length;

/** Least-squares change across a window of evenly spaced samples: slope times the window's length. A ratio of two windows cannot show a trend inside one; this can. */
export function fittedRise(ys: readonly number[]): number {
  const n = ys.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2;
  const ym = mean([...ys]);
  let num = 0;
  let den = 0;
  ys.forEach((y, x) => { num += (x - xm) * (y - ym); den += (x - xm) ** 2; });
  return (num / den) * (n - 1);
}

/** The design's bounded churn run: 1800 s or 100 000 operations, whichever comes first (design 15.1). */
export const DESIGN_CHURN = { seconds: 1_800, ops: 100_000 } as const;

export function judgeChurn(run: { samples: readonly ChurnSample[]; byCode: Readonly<Record<string, number>>; sweepErrors: number; sweepTicks: number; ageErrors: number; sampleError: string | null; elapsedS: number; ops: number }): ChurnVerdict {
  const { samples, byCode } = run;
  const broken: string[] = [];
  for (const [code, n] of Object.entries(byCode)) if (!code.startsWith("sweep:") && !EXPECTED_CODES.has(code)) broken.push(`${n} operation(s) answered ${code}`);
  if (run.sweepErrors > 0) broken.push(`${run.sweepErrors} sweeper error(s)`);
  if (run.sweepTicks === 0) broken.push("the sweeper never ran");
  if (run.ageErrors > 0) broken.push(`${run.ageErrors} aging statement(s) failed`);
  if (run.sampleError !== null) broken.push(`the sampler failed: ${run.sampleError}`);
  if ((byCode["hold:ok"] ?? 0) === 0) broken.push("no hold succeeded");
  if (broken.length > 0) return { verdict: "invalid", reasons: broken };

  const before = samples.filter((x) => x.progress >= 0.15 && x.progress < 0.4);
  const off = samples.filter((x) => x.sweeper === "off");
  const after = samples.filter((x) => x.progress >= 0.75);
  // the terminal sample's interval was cut short: its storage numbers count below, but it has too few holds to compare a latency percentile against a full interval
  const full = (xs: readonly ChurnSample[]): ChurnSample[] => xs.filter((x) => !x.partial);
  const beforeLatency = full(before);
  const afterLatency = full(after);
  const open: string[] = [];
  if (before.length < 5 || after.length < 5) open.push(`too few samples: ${before.length} before, ${after.length} after`);
  const vacuums = samples.length === 0 ? 0 : samples[samples.length - 1]!.autovacuumCount - samples[0]!.autovacuumCount;
  if (vacuums < 3) open.push(`only ${vacuums} autovacuum runs on reservation_unit during the run`);
  if (run.elapsedS < DESIGN_CHURN.seconds && run.ops < DESIGN_CHURN.ops) open.push(`ran for ${run.elapsedS.toFixed(0)} s and ${run.ops} operations; the design's bounded run is ${DESIGN_CHURN.seconds} s or ${DESIGN_CHURN.ops} operations, whichever comes first`);
  if (beforeLatency.length === 0) open.push("no full-interval sample in the before window to judge latency from");
  if (afterLatency.length === 0) open.push("no full-interval sample in the after window to judge latency from");
  if ([...beforeLatency, ...afterLatency].some((x) => x.holdOkLatencyMs.p95 === null)) open.push("a sample has too few granted holds to state p95");
  if (open.length > 0) return { verdict: "inconclusive", reasons: open };

  const activeBefore = mean(before.map((x) => x.activeUnitRows));
  const activeAfter = mean(after.map((x) => x.activeUnitRows));
  if (activeAfter < activeBefore * 0.75 || activeAfter > activeBefore * 1.25) open.push(`active unit rows went from ${activeBefore.toFixed(0)} to ${activeAfter.toFixed(0)}; the windows are not comparable`);
  const deadBefore = mean(before.map((x) => x.pendingDead));
  const deadPeak = Math.max(0, ...off.map((x) => x.pendingDead));
  if (deadPeak < 10 || deadPeak < deadBefore * 3) open.push(`dead holds did not pile up with the sweeper off: peak ${deadPeak}, mean before ${deadBefore.toFixed(1)}`);
  if (open.length > 0) return { verdict: "inconclusive", reasons: open };

  const reasons: string[] = [];
  const deadAfter = mean(after.map((x) => x.pendingDead));
  if (deadAfter > 10 && deadAfter > deadBefore * 2) reasons.push(`dead holds were not cleared: mean ${deadAfter.toFixed(1)} after against ${deadBefore.toFixed(1)} before`);
  const judge = (what: string, b: number[], a: number[], ratio: { times: number; plus: number; by: "max" | "mean" }, rise: { share: number; plus: number }): void => {
    const level = (xs: number[]): number => (ratio.by === "max" ? Math.max(...xs) : mean(xs));
    if (level(a) > level(b) * ratio.times + ratio.plus) reasons.push(`${what} went from ${level(b).toFixed(1)} to ${level(a).toFixed(1)}`);
    const r = fittedRise(a);
    if (r > mean(a) * rise.share + rise.plus) reasons.push(`${what} was still rising at the end: ${r.toFixed(1)} across the last window, mean ${mean(a).toFixed(1)}`);
  };
  judge("exclusion index bytes", before.map((x) => x.exclusionIndexBytes), after.map((x) => x.exclusionIndexBytes), { times: 1.25, plus: 0, by: "max" }, { share: 0.1, plus: 0 });
  judge("heap dead-tuple percent", before.map((x) => x.heapDeadTuplePercent), after.map((x) => x.heapDeadTuplePercent), { times: 1, plus: 5, by: "mean" }, { share: 0, plus: 5 });
  judge("heap bytes per retained row", before.map((x) => x.heapBytes / Math.max(1, x.retainedUnitRows)), after.map((x) => x.heapBytes / Math.max(1, x.retainedUnitRows)), { times: 1.25, plus: 0, by: "mean" }, { share: 0.1, plus: 0 });
  judge("granted-hold p95 ms", beforeLatency.map((x) => x.holdOkLatencyMs.p95!.atLeast), afterLatency.map((x) => x.holdOkLatencyMs.p95!.atLeast), { times: 1.5, plus: 1, by: "mean" }, { share: 0.25, plus: 1 });
  return { verdict: reasons.length === 0 ? "pass" : "fail", reasons };
}

/**
 * Bounded churn (system design, section 15.1): holds on a bounded slot space, of which some are cancelled
 * at once, some are confirmed and cancelled later, and the rest are left to expire; attempts against live
 * reservations fail as conflicts; the sweeper is off between 40 and 60 percent of the run so dead holds pile
 * up and are then cleared. Storage, dead tuples, WAL, autovacuum activity, and hold latency are sampled on
 * an interval through pgstattuple and the statistics views.
 */
export async function runChurn(deps: ChurnDeps, opts: ChurnOptions): Promise<ChurnReport> {
  if (deps.seed.units.length < 40) throw new Error("churn: seed 40 units");
  if (opts.ageMs !== undefined && deps.agerPool === undefined) throw new Error("churn: ageMs needs an agerPool");
  await deps.owner.query("create extension if not exists pgstattuple with schema public");
  const runId = `churn${Date.now().toString(36)}`;
  const ttlSeconds = (await deps.owner.query("select hold_ttl_seconds as ttl from dastar.venue where id = $1", [deps.seed.venue])).rows[0].ttl as number;
  const app: Dastar = createDastar({ pool: deps.appPool });
  const sweeper: Dastar = createDastar({ pool: deps.workerPool });
  const venueId = deps.seed.venue;
  const byCode: Record<string, number> = {};
  const confirmed: string[] = [];
  const samples: ChurnSample[] = [];
  const firstDay = Date.UTC(2051, 0, 1, 17);
  const started = performance.now();
  let ops = 0;
  let granted: number[] = [];
  let refused: number[] = [];
  let aged = 0;
  let ageErrors = 0;
  let done = false;
  const progress = (): number => Math.max((performance.now() - started) / (opts.maxSeconds * 1_000), ops / opts.maxOps);
  const sweeperOff = (): boolean => { const p = progress(); return p >= 0.4 && p < 0.6; };
  const sweeping = startSweeper(sweeper, opts.sweep ?? DESIGN_SWEEP, sweeperOff);
  const bump = (code: string): void => { byCode[code] = (byCode[code] ?? 0) + 1; ops += 1; };
  const attempt = async (name: string, fn: () => Promise<unknown>): Promise<boolean> => {
    try { await fn(); bump(`${name}:ok`); return true; } catch (e) { bump(`${name}:${(e as { code?: string }).code ?? "thrown"}`); return false; }
  };

  async function workerLoop(worker: number): Promise<void> {
    const r = rng(opts.seed * 1_000 + worker);
    let n = 0;
    while (!done && progress() < 1) {
      const traceId = `${runId}-${worker}-${n++}`;
      const actor = `${runId}:w${worker}:${n % 50}`;
      const t0 = performance.now();
      let reservationId: string | null = null;
      let answer = "error";
      try {
        const out = await app.hold({
          venueId, actor, traceId, idempotencyKey: traceId, partySize: 2, durationMinutes: 90,
          startsAt: new Date(firstDay + r.int(14) * 86_400_000 + r.int(16) * 900_000).toISOString(),
          assignment: { kind: "unit", id: r.pick(deps.seed.units) },
        });
        answer = out.ok ? "ok" : out.error.code;
        bump(`hold:${answer}`);
        if (out.ok) reservationId = out.receipt.reservationId;
      } catch (e) {
        bump(`hold:${(e as { code?: string }).code ?? "thrown"}`);
      }
      // any other answer makes the run invalid, so its latency is not kept
      if (answer === "ok") granted.push(performance.now() - t0);
      else if (answer === "hold_conflict") refused.push(performance.now() - t0);
      if (reservationId === null) continue;
      const id = reservationId;
      const x = r.next();
      if (x < 0.4) {
        await attempt("cancel", () => app.cancel({ reservationId: id, actor, traceId: `${traceId}x`, venueId, reason: "churn" }));
      } else if (x < 0.5) {
        if (await attempt("confirm", () => app.confirm({ reservationId: id, actor, traceId: `${traceId}c`, venueId }))) confirmed.push(id);
        // confirmed reservations are cancelled later, oldest first, so occupancy stays bounded
        const old = confirmed.length > 500 ? confirmed.shift() : undefined;
        if (old !== undefined) await attempt("cancel", () => app.cancel({ reservationId: old, actor, traceId: `${traceId}o`, venueId, reason: "churn" }));
      } else if (opts.ageMs !== undefined) {
        try {
          const u = await deps.agerPool!.query("update dastar.reservation set hold_expires_at = now() + make_interval(secs => $2::float8 / 1000) where id = $1 and status = 'held'", [id, opts.ageMs]);
          aged += u.rowCount ?? 0;
        } catch {
          ageErrors += 1;
        }
      }
    }
  }

  async function sample(partial = false): Promise<void> {
    const sampleStarted = performance.now();
    const x = (await deps.owner.query(SAMPLE_SQL)).rows[0];
    const sampleMs = performance.now() - sampleStarted;
    const ok = granted;
    const conflict = refused;
    granted = [];
    refused = [];
    samples.push({
      atS: (performance.now() - started) / 1_000, progress: Math.min(1, progress()), ops, sweeper: sweeperOff() ? "off" : "on",
      retainedUnitRows: x.retained, activeUnitRows: x.active, pendingDead: x.pending_dead,
      heapBytes: x.heap_bytes, exclusionIndexBytes: x.excl_bytes, totalBytes: x.total_bytes,
      heapDeadTuplePercent: x.heap_dead_pct, heapFreePercent: x.heap_free_pct, indexFreePercent: x.index_free_pct,
      nLiveTup: x.n_live, nDeadTup: x.n_dead, autovacuumCount: x.autovacuum_count, autoanalyzeCount: x.autoanalyze_count,
      lastAutovacuum: x.last_autovacuum === null ? null : new Date(x.last_autovacuum as string).toISOString(),
      walPosition: x.wal_position, sampleMs, holdOkLatencyMs: dist(exact(ok)), holdConflictLatencyMs: dist(exact(conflict)), partial,
    });
  }
  const sampler: { wake: (() => void) | null } = { wake: null };
  let sampleError: string | null = null;
  const sampleLoop = (async (): Promise<void> => {
    await sample();
    while (!done) {
      await new Promise<void>((res) => {
        const t = setTimeout(res, opts.sampleEveryMs);
        sampler.wake = () => { clearTimeout(t); res(); };
      });
      if (!done) await sample();
    }
  })().catch((e) => { sampleError = (e as Error).message; });

  try {
    await Promise.all(Array.from({ length: opts.workers }, (_, w) => workerLoop(w)));
    // the measured run ends here: one last sample under the configured sweeper, then the sampler and the sweeper stop
    done = true;
    sampler.wake?.();
    await sampleLoop;
    try {
      await sample(true);
    } catch (e) {
      // the terminal sample is outside the loop's handler; a failure here makes the run invalid the same way
      sampleError = sampleError ?? (e as Error).message;
    }
  } finally {
    // on any way out, so a failure cannot leave the sampler or the sweeper running
    done = true;
    sampler.wake?.();
    await sampleLoop.catch(() => undefined);
    await sweeping.stop();
  }
  const elapsedS = (performance.now() - started) / 1_000;

  // cleanup, after the last sample and outside the verdict
  const cleanupStarted = performance.now();
  const horizon = [venueId, opts.ageMs ?? 0];
  const dueSql = "select count(*)::int as n from dastar.reservation where venue_id = $1 and status = 'held' and hold_expires_at <= now() + make_interval(secs => $2::float8 / 1000)";
  const pendingDeadAtEnd = (await deps.owner.query(dueSql, horizon)).rows[0].n as number;
  const limit = (opts.sweep ?? DESIGN_SWEEP).limit;
  let cleanupBatches = 0;
  let cleanupExpired = 0;
  let cleared = true;
  try {
    await waitFor(async () => {
      cleanupExpired += (await sweeper.expireDue({ limit })).expired.length;
      cleanupBatches += 1;
      return ((await deps.owner.query(dueSql, horizon)).rows[0].n as number) === 0;
    }, (opts.ageMs ?? ttlSeconds * 1_000) + 60_000, "dead holds cleared after the run");
  } catch {
    // a cleanup that overruns its budget is reported, not thrown: the run's samples and verdict are still evidence
    cleared = false;
  }
  const cleanup = { pendingDeadAtEnd, batches: cleanupBatches, expired: cleanupExpired, ms: performance.now() - cleanupStarted, cleared };
  await app.close();
  await sweeper.close();
  return {
    command: "churn", runId, seed: opts.seed, environment: await environment(deps.owner, deps.appPool.options.max ?? 10), options: opts,
    ops, byCode, elapsedS, sweep: sweeping.stats, cleanup, sampleError,
    expiry: { mode: opts.ageMs === undefined ? "natural-ttl" : "owner-aged", ttlSeconds, ageMs: opts.ageMs ?? null, aged, ageErrors },
    samples, verdict: judgeChurn({ samples, byCode, sweepErrors: sweeping.stats.errors, sweepTicks: sweeping.stats.ticks, ageErrors, sampleError, elapsedS, ops }), rules: [...CHURN_RULES],
  };
}

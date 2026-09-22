import type { ClientBase, Pool } from "pg";
import { createDastar, DastarError, type Dastar } from "@dastar/db";
import type { BenchSeed } from "./seed.js";
import { rng, type Rng } from "./rng.js";
import { dist, exact, type Dist } from "./stats.js";
import { startSweeper, DESIGN_SWEEP, type SweepConfig, type SweepStats } from "./sweeper.js";
import { deadlocksStable, fitViolations } from "./observe.js";
import { overlapPairs } from "./race.js";
import { environment, type Environment } from "./load.js";

export type MixedOp = "hold_unit" | "hold_combo" | "confirm" | "cancel" | "mint_confirm" | "capacity_edit";

/**
 * Draw weights. Cancellation is as frequent as it is because it is what frees the floor: a confirmed
 * reservation stays cancellable, so occupancy turns over for the whole run instead of filling up once.
 */
const WEIGHTS: Record<MixedOp, number> = { hold_unit: 30, hold_combo: 15, confirm: 10, cancel: 25, mint_confirm: 10, capacity_edit: 10 };

/**
 * Days the floor spans. Every hold on a unit takes that unit's lock whatever its day, so lock contention does
 * not depend on this. What does is how soon a competing hold finds a dead one: on three days that took about
 * 50 ms, the sweeper almost never got there first, and a run said little about the sweeper as a concurrent writer.
 */
const FLOOR_DAYS = 14;

/** Answers each operation may legitimately receive while the others run. Anything else is reported as unexpected. */
export const EXPECTED: Record<MixedOp, readonly string[]> = {
  hold_unit: ["ok", "hold_conflict", "party_does_not_fit"],
  hold_combo: ["ok", "hold_conflict"],
  confirm: ["ok", "hold_expired", "invalid_transition", "party_does_not_fit"],
  cancel: ["ok", "invalid_transition"],
  mint_confirm: ["ok", "token_requires_held", "hold_expired", "invalid_transition", "party_does_not_fit", "forbidden"],
  capacity_edit: ["ok", "capacity_conflict"],
};

export type MixedOptions = {
  seconds: number; workers: number; seed: number;
  /** Every `ageEveryMs` the owner moves up to `agePerTick` live holds to the edge of expiry, one row per statement. */
  ageEveryMs?: number; agePerTick?: number;
  /** Default: the design's sweeper. */
  sweep?: SweepConfig;
};
export type MixedDeps = { appPool: Pool; workerPool: Pool; owner: ClientBase; ager: ClientBase; seed: BenchSeed };

export type MixedReport = {
  command: "mixed"; runId: string; seed: number; seconds: number; workers: number; environment: Environment;
  ops: Record<MixedOp, { count: number; byCode: Record<string, number>; latencyMs: Dist }>;
  retries: { count: number; bySqlstate: Record<string, number>; samples: { op: string; sqlstate: string; message: string; detail: string | null }[] };
  unexpected: { op: MixedOp; code: string; message: string }[];
  /**
   * Expiry in this run is synthetic: the owner role moved `aged` live holds to within 1.5 s of expiry, which
   * no application can do. It exercises the expiry paths; it says nothing about behavior under the natural
   * 60-second TTL. The dead holds were cleared by the sweeper or by a competing hold. `bySweeper` counts this
   * venue only; `sweep.expired` is the sweeper's work across the whole database.
   */
  expiry: { mode: "owner-aged"; aged: number; ageErrors: number; expired: number; bySweeper: number; byCompetingHold: number };
  sweep: SweepStats;
  deadlockDelta: number; overlaps: number; fitViolations: number;
  verdict: MixedVerdict; rules: string[];
  /** `verdict.verdict === "pass"`. */
  pass: boolean;
};

/** inconclusive: nothing went wrong, but some path the run exists to exercise was hardly taken, so its silence proves little. */
export type MixedVerdict = { verdict: "pass" | "fail" | "inconclusive" | "invalid"; reasons: string[] };

/** Fewer successes than this for an operation, or fewer holds aged or swept, and the run has not exercised that path. Provisional, like every threshold here. */
export const MIN_EXERCISED = 10;

export const MIXED_RULES: readonly string[] = [
  "invalid: a sweeper error, a sweeper that never ran, or a failed aging statement: the run's own machinery broke",
  "fail: any deadlock, overlapping pair, party outside its capacity, or answer outside the expected set",
  `inconclusive: an operation with fewer than ${MIN_EXERCISED} ok answers, fewer than ${MIN_EXERCISED} holds aged, or fewer than ${MIN_EXERCISED} of this venue's holds expired by the sweeper`,
];

export function judgeMixed(run: {
  okByOp: Readonly<Record<MixedOp, number>>; unexpected: number; deadlockDelta: number; overlaps: number; fitViolations: number;
  sweep: Pick<SweepStats, "errors" | "ticks">; aged: number; ageErrors: number;
  /** Holds of this run's own venue that the sweeper expired, apart from `sweep.expired`, which is database-wide. */
  sweptHere: number;
}): MixedVerdict {
  const broken: string[] = [];
  if (run.sweep.errors > 0) broken.push(`${run.sweep.errors} sweeper error(s)`);
  if (run.sweep.ticks === 0) broken.push("the sweeper never ran");
  if (run.ageErrors > 0) broken.push(`${run.ageErrors} aging statement(s) failed`);
  if (broken.length > 0) return { verdict: "invalid", reasons: broken };
  const failures: string[] = [];
  if (run.deadlockDelta > 0) failures.push(`${run.deadlockDelta} deadlock(s)`);
  if (run.overlaps > 0) failures.push(`${run.overlaps} overlapping pair(s) of active unit rows`);
  if (run.fitViolations > 0) failures.push(`${run.fitViolations} live reservation(s) outside their capacity`);
  if (run.unexpected > 0) failures.push(`${run.unexpected} answer(s) outside the expected set`);
  if (failures.length > 0) return { verdict: "fail", reasons: failures };
  const thin: string[] = [];
  for (const [op, n] of Object.entries(run.okByOp)) if (n < MIN_EXERCISED) thin.push(`${op} succeeded ${n} time(s)`);
  if (run.aged < MIN_EXERCISED) thin.push(`${run.aged} hold(s) aged`);
  if (run.sweptHere < MIN_EXERCISED) thin.push(`the sweeper expired ${run.sweptHere} hold(s) of this venue`);
  return thin.length > 0 ? { verdict: "inconclusive", reasons: thin } : { verdict: "pass", reasons: [] };
}

function drawOp(r: Rng): MixedOp {
  const ops = Object.keys(WEIGHTS) as MixedOp[];
  let x = r.next() * ops.reduce((s, o) => s + WEIGHTS[o], 0);
  for (const o of ops) {
    x -= WEIGHTS[o];
    if (x < 0) return o;
  }
  return "hold_unit";
}

/**
 * Every writer at once on a small contended floor: unit and combo holds over twelve overlapping slots on
 * eight units and fourteen days, where the combos share members; confirmations, cancellations, token mints with a token
 * confirmation, and capacity edits as the application role; a sweeper; and an owner connection that moves
 * live holds to the edge of expiry, because the schema's shortest hold is 60 seconds. The run passes when
 * the database reports no deadlock, no overlap, no party outside its capacity, and no answer outside the
 * expected set, and every one of those paths was actually taken (`judgeMixed`).
 */
export async function runMixed(deps: MixedDeps, opts: MixedOptions): Promise<MixedReport> {
  if (deps.seed.units.length < 8 || deps.seed.combos.length < 6) throw new Error("mixed: seed with { units: 8, mesh: true }");
  const runId = `mixed${Date.now().toString(36)}`;
  const before = await deadlocksStable(deps.owner);
  const retries: MixedReport["retries"] = { count: 0, bySqlstate: {}, samples: [] };
  const app: Dastar = createDastar({ pool: deps.appPool });
  const sweeper: Dastar = createDastar({ pool: deps.workerPool });
  const units = deps.seed.units.slice(0, 8);
  const venueId = deps.seed.venue;
  // reservations this run created and has not cancelled; confirmation leaves an id here, cancellation removes it
  const known: string[] = [];
  const take = (r: Rng): string | undefined => (known.length === 0 ? undefined : known.splice(r.int(known.length), 1)[0]);
  const peek = (r: Rng): string | undefined => (known.length === 0 ? undefined : known[r.int(known.length)]);
  const ops = Object.fromEntries((Object.keys(WEIGHTS) as MixedOp[]).map((o) => [o, { count: 0, byCode: {} as Record<string, number>, latencies: [] as number[] }])) as
    Record<MixedOp, { count: number; byCode: Record<string, number>; latencies: number[] }>;
  const unexpected: MixedReport["unexpected"] = [];
  const evening = Date.UTC(2048, 5, 1, 17);
  let n = 0;
  let stopped = false;
  let aged = 0;
  let ageErrors = 0;
  let unexpectedCount = 0;

  const onRetry = (op: string) => (info: { sqlstate: string; error: DastarError }): void => {
    retries.count += 1;
    retries.bySqlstate[info.sqlstate] = (retries.bySqlstate[info.sqlstate] ?? 0) + 1;
    if (retries.samples.length < 20) retries.samples.push({ op, sqlstate: info.sqlstate, message: info.error.message, detail: info.error.detail ?? null });
  };

  async function once(op: MixedOp, r: Rng, worker: number): Promise<string> {
    const seq = n++;
    const traceId = `${runId}-${seq}`;
    const actor = `${runId}:w${worker}`;
    if (op === "hold_unit" || op === "hold_combo") {
      const combo = op === "hold_combo";
      const out = await app.hold({
        venueId, actor, traceId, idempotencyKey: traceId, partySize: combo ? 5 + r.int(4) : 2 + r.int(3),
        startsAt: new Date(evening + r.int(FLOOR_DAYS) * 86_400_000 + r.int(12) * 1_800_000).toISOString(), durationMinutes: 60,
        assignment: combo ? { kind: "combo", id: r.pick(deps.seed.combos) } : { kind: "unit", id: r.pick(units) },
      }, { onRetry: onRetry(op) });
      if (out.ok) known.push(out.receipt.reservationId);
      return out.ok ? "ok" : out.error.code;
    }
    if (op === "capacity_edit") {
      const c = await deps.appPool.connect();
      // pg-pool detaches its own listener while a client is checked out
      let fatal: Error | null = null;
      const onError = (e: Error): void => { fatal = e; };
      c.on("error", onError);
      try {
        await c.query("begin");
        await c.query("select set_config('dastar.actor', $1, true), set_config('dastar.trace_id', $2, true)", [actor, traceId]);
        await c.query("update dastar.unit set capacity_max = $2 where id = $1", [r.pick(units), r.pick([2, 4, 6, 8])]);
        await c.query("commit");
        return "ok";
      } catch (e) {
        await c.query("rollback").catch(() => undefined);
        throw e;
      } finally {
        c.removeListener("error", onError);
        c.release(fatal ?? undefined);
      }
    }
    const reservationId = op === "cancel" ? take(r) : peek(r);
    if (reservationId === undefined) return "skipped";
    if (op === "confirm") { await app.confirm({ reservationId, actor, traceId, venueId }); return "ok"; }
    if (op === "cancel") { await app.cancel({ reservationId, actor, traceId, venueId, reason: "mixed run" }); return "ok"; }
    const { token } = await app.mintConfirmToken({ reservationId, actor, traceId, venueId });
    await app.confirm({ reservationId, actor, traceId: `${traceId}c`, venueId, confirmToken: token });
    return "ok";
  }

  async function workerLoop(worker: number): Promise<void> {
    const r = rng(opts.seed * 1_000 + worker);
    while (!stopped) {
      const op = drawOp(r);
      const t0 = performance.now();
      let code: string;
      let message = "";
      try {
        code = await once(op, r, worker);
      } catch (e) {
        const mapped = e instanceof DastarError ? e : null;
        const pg = e as { code?: string; message?: string };
        code = mapped ? mapped.code : pg.code === "DA012" ? "capacity_conflict" : `thrown:${pg.code ?? "unknown"}`;
        message = (e as Error).message ?? "";
      }
      if (code === "skipped") continue;
      const o = ops[op];
      o.count += 1;
      o.byCode[code] = (o.byCode[code] ?? 0) + 1;
      o.latencies.push(performance.now() - t0);
      if (!EXPECTED[op].includes(code)) {
        unexpectedCount += 1;
        if (unexpected.length < 50) unexpected.push({ op, code, message });
      }
    }
  }

  // ids this run's own sweeper expired, database-wide; filtered to this venue below, apart from sweep.expired
  const swept: string[] = [];
  const sweeping = startSweeper(sweeper, opts.sweep ?? DESIGN_SWEEP, undefined, (ids) => { swept.push(...ids); });

  // One row per statement: a connection that holds a single row lock and waits for nothing else cannot be
  // part of a lock cycle, so the run measures the engine's paths and not this helper.
  // This loop is the only user of the ager connection, one statement at a time. A failure is counted and
  // makes the run invalid; it never escapes as a rejection nobody is waiting for.
  const ageLoop = (async (): Promise<void> => {
    try {
      await deps.ager.query("select set_config('dastar.actor', 'bench:ager', false), set_config('dastar.trace_id', 'ager', false)");
    } catch {
      ageErrors += 1;
      return;
    }
    while (!stopped) {
      try {
        const ids = await deps.ager.query(
          "select id from dastar.reservation where venue_id = $1 and status = 'held' and hold_expires_at > now() + interval '5 seconds' order by random() limit $2",
          [venueId, opts.agePerTick ?? 10],
        );
        for (const row of ids.rows) {
          const u = await deps.ager.query(
            "update dastar.reservation set hold_expires_at = now() + (random() * interval '1500 milliseconds') where id = $1 and status = 'held'",
            [row.id],
          );
          aged += u.rowCount ?? 0;
        }
      } catch {
        ageErrors += 1;
      }
      await new Promise((res) => setTimeout(res, opts.ageEveryMs ?? 100));
    }
  })();

  const workers = Array.from({ length: opts.workers }, (_, w) => workerLoop(w));
  await new Promise((res) => setTimeout(res, opts.seconds * 1_000));
  stopped = true;
  await Promise.all([...workers, ageLoop]);
  await sweeping.stop();
  await app.close();
  await sweeper.close();

  const deadlockDelta = (await deadlocksStable(deps.owner)) - before;
  const overlaps = await overlapPairs(deps.owner);
  const fit = await fitViolations(deps.owner);
  const expiredTotal = (await deps.owner.query("select count(*)::int as n from dastar.reservation where venue_id = $1 and status = 'expired'", [venueId])).rows[0].n as number;
  const bySweeper = (await deps.owner.query("select count(*)::int as n from dastar.reservation where venue_id = $1 and id = any($2::uuid[])", [venueId, swept])).rows[0].n as number;
  const byCompetingHold = expiredTotal - bySweeper;
  const okByOp = Object.fromEntries((Object.keys(ops) as MixedOp[]).map((o) => [o, ops[o].byCode.ok ?? 0])) as Record<MixedOp, number>;
  const verdict = judgeMixed({ okByOp, unexpected: unexpectedCount, deadlockDelta, overlaps, fitViolations: fit, sweep: sweeping.stats, aged, ageErrors, sweptHere: bySweeper });
  return {
    command: "mixed", runId, seed: opts.seed, seconds: opts.seconds, workers: opts.workers,
    environment: await environment(deps.owner, deps.appPool.options.max ?? 10),
    ops: Object.fromEntries((Object.keys(ops) as MixedOp[]).map((o) => [o, { count: ops[o].count, byCode: ops[o].byCode, latencyMs: dist(exact(ops[o].latencies)) }])) as MixedReport["ops"],
    retries, unexpected,
    expiry: { mode: "owner-aged", aged, ageErrors, expired: expiredTotal, bySweeper, byCompetingHold },
    sweep: sweeping.stats, deadlockDelta, overlaps, fitViolations: fit,
    verdict, rules: [...MIXED_RULES], pass: verdict.verdict === "pass",
  };
}

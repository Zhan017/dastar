import { mkdtemp, copyFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, Pool } from "pg";
import { migrate } from "@dastar/db";
import { benchDatabaseName, createThrowawayDatabase, dropNaiveDatabase, withDatabase } from "./naive.js";
import { seedBench } from "./seed.js";
import { rng } from "./rng.js";
import { planArrivals, runOpenLoop } from "./schedule.js";
import { openSession, warmPool, type HoldRecord } from "./load.js";
import { engineTarget } from "./target.js";
import { TARGET_BLEND } from "./workload.js";
import { dist, type Dist, type Sample } from "./stats.js";
import type { SweepConfig, SweepStats } from "./sweeper.js";

export type MigrateUnderLoadOptions = {
  /** Owner connection to a maintenance database; the run creates its own database next to it and drops it afterwards. */
  adminUrl: string;
  /** Application-role and worker-role connection strings; only the credentials and host are used. */
  appUrl: string; workerUrl: string;
  migrationsDir: string;
  ratePerSec: number; baselineSeconds: number; gapSeconds: number;
  /** Confirmed reservations inserted before the run, so index builds and the rewrite have something to work on. */
  preloadRows: number;
  seed: number; keep?: boolean; lockTimeout?: string;
  /** Default: the design's sweeper. */
  sweep?: SweepConfig;
};

type Fixture = { file: string; kind: "live-safe" | "blocking"; header: string; sql: string | ((owner: Client) => Promise<string>) };
const TX = "-- transaction: yes\n";
const FIXTURES: readonly Fixture[] = [
  { file: "9001_bench_nullable_column.sql", kind: "live-safe", header: `${TX}-- impact: instant-exclusive\n`, sql: "alter table dastar.reservation add column bench_note text;" },
  { file: "9002_bench_concurrent_index.sql", kind: "live-safe", header: "-- transaction: no\n-- impact: long-nonblocking\n",
    sql: "create index concurrently if not exists reservation_bench_created_idx on dastar.reservation using btree (created_at);" },
  // the function's current definition, read from the database, so the fixture never drifts from the shipped one
  { file: "9003_bench_replace_trigger_function.sql", kind: "live-safe", header: `${TX}-- impact: instant-exclusive\n`,
    sql: async (owner) => `${(await owner.query("select pg_get_functiondef('dastar.trg_fit()'::regprocedure) as def")).rows[0].def as string};` },
  { file: "9004_bench_not_valid_constraint.sql", kind: "live-safe", header: `${TX}-- impact: instant-exclusive\n`,
    sql: "alter table dastar.reservation add constraint bench_party_positive check (party_size >= 1) not valid;" },
  { file: "9005_bench_validate_constraint.sql", kind: "live-safe", header: `${TX}-- impact: long-nonblocking\n`,
    sql: "alter table dastar.reservation validate constraint bench_party_positive;" },
  { file: "9006_bench_plain_index.sql", kind: "blocking", header: `${TX}-- impact: long-blocks-writes\n`,
    sql: "create index reservation_bench_plain_idx on dastar.reservation using btree (party_size);" },
  // a volatile default forces a rewrite of the whole table under an exclusive lock
  { file: "9007_bench_table_rewrite.sql", kind: "blocking", header: `${TX}-- impact: long-blocks-all\n`,
    sql: "alter table dastar.reservation add column bench_rand double precision default random();" },
];

/** Requests in one window. Percentiles are null when the window holds too few requests to state them. */
export type WindowStats = { requests: number; errors: number; errorsByCode: Record<string, number>; e2eMs: Dist; unitLockMs: Dist; transactionMs: Dist };

export type MigrationWindow = {
  file: string; kind: Fixture["kind"]; attempts: number; startedAtMs: number; durationMs: number; error: string | null;
  /** Every request whose execution overlapped the migration, including those that arrived before it began. */
  affected: WindowStats;
  /** Requests that started after the migration ended and before the next one began: what it left behind. */
  recovery: WindowStats;
};
/**
 * pass: every live-safe migration met enough traffic and no request failed during it or while traffic
 * recovered from it. fail: a request did fail there, or a live-safe migration did not apply.
 * inconclusive: nothing failed, but too few requests were in flight during a migration to say how it treats
 * traffic. invalid: the run cannot be attributed to the migrations at all.
 */
export type UnderLoadVerdict = { verdict: "pass" | "fail" | "inconclusive" | "invalid"; reasons: string[] };

export type MigrateUnderLoadReport = {
  command: "migrate-under-load"; database: string; ratePerSec: number; preloadRows: number; sweep: SweepStats;
  baseline: WindowStats;
  /** Every request of the run, and the errors that fell outside every migration's affected and recovery windows. */
  wholeRun: WindowStats; errorsOutsideWindows: number;
  migrations: MigrationWindow[];
  /** Live-safe migrations during which fewer than `MIN_AFFECTED` requests were in flight. */
  thinEvidence: string[];
  /** All seven fixtures ran and none reported an error. This says the runner works; it says nothing about traffic. */
  fixturesApplied: boolean;
  /** What the run shows about migrating under load. The blocking two are recorded, not judged. */
  underLoad: UnderLoadVerdict;
};

/** Fewer requests than this in flight during a migration is no evidence about the migration itself. */
export const MIN_AFFECTED = 5;
/** A baseline needs enough requests to state a p95. */
export const MIN_BASELINE = 60;

export function judgeUnderLoad(run: { baseline: WindowStats; migrations: readonly MigrationWindow[]; fixtures: number; sweepErrors: number; sweepTicks: number; errorsOutsideWindows: number }): UnderLoadVerdict {
  const invalid: string[] = [];
  if (run.baseline.requests < MIN_BASELINE) invalid.push(`the baseline holds ${run.baseline.requests} requests; ${MIN_BASELINE} are needed to compare anything with it`);
  if (run.baseline.errors > 0) invalid.push(`${run.baseline.errors} request(s) failed before any migration began: ${JSON.stringify(run.baseline.errorsByCode)}`);
  if (run.sweepErrors > 0) invalid.push(`${run.sweepErrors} sweeper error(s)`);
  if (run.sweepTicks === 0) invalid.push("the sweeper never ran");
  if (run.errorsOutsideWindows > 0) invalid.push(`${run.errorsOutsideWindows} request(s) failed outside every migration's windows, so failures cannot be attributed to a migration`);
  if (invalid.length > 0) return { verdict: "invalid", reasons: invalid };

  const liveSafe = run.migrations.filter((m) => m.kind === "live-safe");
  const failures: string[] = [];
  if (liveSafe.length < run.fixtures) failures.push(`only ${liveSafe.length} of ${run.fixtures} live-safe fixtures ran`);
  for (const m of liveSafe) {
    if (m.error !== null) failures.push(`${m.file} did not apply: ${m.error}`);
    if (m.affected.errors > 0) failures.push(`${m.file}: ${m.affected.errors} of ${m.affected.requests} request(s) in flight failed ${JSON.stringify(m.affected.errorsByCode)}`);
    if (m.recovery.errors > 0) failures.push(`${m.file}: ${m.recovery.errors} of ${m.recovery.requests} request(s) after it failed ${JSON.stringify(m.recovery.errorsByCode)}`);
  }
  if (failures.length > 0) return { verdict: "fail", reasons: failures };

  const thin = liveSafe.filter((m) => m.affected.requests < MIN_AFFECTED);
  if (thin.length > 0) {
    return { verdict: "inconclusive", reasons: thin.map((m) => `${m.file}: ${m.affected.requests} request(s) in flight during its ${m.durationMs.toFixed(0)} ms; at least ${MIN_AFFECTED} are needed`) };
  }
  return { verdict: "pass", reasons: [] };
}

const failed = (x: HoldRecord): boolean => x.cls !== "ok" && x.cls !== "conflict";

export function windowStats(rs: readonly HoldRecord[]): WindowStats {
  const errorsByCode: Record<string, number> = {};
  for (const x of rs) if (failed(x)) errorsByCode[x.code] = (errorsByCode[x.code] ?? 0) + 1;
  const samples = (ms: (x: HoldRecord) => number | null, censored: (x: HoldRecord) => boolean): Sample[] =>
    rs.flatMap((x) => { const v = ms(x); return v === null ? [] : [{ ms: v, censored: censored(x) }]; });
  return {
    requests: rs.length, errors: rs.filter(failed).length, errorsByCode,
    e2eMs: dist(samples((x) => x.e2eMs, (x) => x.e2eCensored)),
    unitLockMs: dist(samples((x) => x.unitLockMs, (x) => x.unitLockCensored)),
    transactionMs: dist(samples((x) => x.transactionMs, () => false)),
  };
}

/**
 * Requests in flight at any moment of [fromMs, toMs): started before it ended and answered after it began.
 * When a request was planned to arrive does not matter. A shed request was never in flight; it belongs to
 * the window its arrival fell in, because the backlog that shed it is that window's doing.
 */
export function overlapping(rs: readonly HoldRecord[], fromMs: number, toMs: number): HoldRecord[] {
  return rs.filter((x) => x.startedMs < toMs && (x.doneMs === null ? x.startedMs >= fromMs : x.doneMs > fromMs));
}

/** Requests that started inside [fromMs, toMs). */
export function startedWithin(rs: readonly HoldRecord[], fromMs: number, toMs: number): HoldRecord[] {
  return rs.filter((x) => x.startedMs >= fromMs && x.startedMs < toMs);
}

async function preload(owner: Client, venue: string, units: string[], rows: number): Promise<void> {
  await owner.query("select set_config('dastar.actor', 'bench:preload', false), set_config('dastar.trace_id', 'preload', false)");
  const perUnit = Math.ceil(rows / units.length);
  for (let from = 0; from < perUnit; from += 125) {
    const to = Math.min(perUnit, from + 125) - 1;
    await owner.query(
      `with ins as (
         insert into dastar.reservation (venue_id, party_size, during, status, assignment_kind, assignment_id, hold_expires_at, created_by)
         select $1, 1, tstzrange(t.d, t.d + interval '90 minutes', '[)'), 'held', 'unit', u.id, now() + interval '10 minutes', 'bench:preload'
           from unnest($2::uuid[]) as u(id), generate_series($3::int, $4::int) as g(j),
                lateral (select timestamptz '2060-01-01 19:00+00' + make_interval(days => g.j)) as t(d)
         returning id, venue_id, assignment_id, during)
       insert into dastar.reservation_unit (venue_id, reservation_id, unit_id, during) select venue_id, id, assignment_id, during from ins`,
      [venue, units, from, to],
    );
  }
  await owner.query("update dastar.reservation set status = 'confirmed' where venue_id = $1 and created_by = 'bench:preload' and status = 'held'", [venue]);
  // a bulk load leaves the planner without statistics until autoanalyze gets to it
  await owner.query("analyze dastar.reservation, dastar.reservation_unit, dastar.audit_log, dastar.outbox");
}

/**
 * Migrations under load (system design, section 15.1). On a database of its own, with the target blend
 * arriving at a steady rate, the runner applies a live-safe set one file at a time: a nullable column, a
 * concurrent index through the restricted mode, a trigger function replaced with its own definition, a
 * NOT VALID constraint, and its validation. Then a plain index build and a table rewrite are applied once
 * each, to record what blocking writes and blocking everything does to traffic.
 */
export async function runMigrateUnderLoad(opts: MigrateUnderLoadOptions): Promise<MigrateUnderLoadReport> {
  const database = benchDatabaseName();
  const ownerUrl = await createThrowawayDatabase(opts.adminUrl, database, opts.migrationsDir);
  const dir = await mkdtemp(join(tmpdir(), "dastar-mul-"));
  const owner = new Client({ connectionString: ownerUrl });
  owner.on("error", () => undefined);
  const appPool = new Pool({ connectionString: withDatabase(opts.appUrl, database), max: 16, idleTimeoutMillis: 0 });
  const workerPool = new Pool({ connectionString: withDatabase(opts.workerUrl, database), max: 2 });
  appPool.on("error", () => undefined);
  workerPool.on("error", () => undefined);
  try {
    await owner.connect();
    for (const f of (await readdir(opts.migrationsDir)).filter((x) => /^\d{4}_.+\.sql$/.test(x))) await copyFile(join(opts.migrationsDir, f), join(dir, f));
    const seed = await seedBench(owner, { holdTtlSeconds: 60 });
    await preload(owner, seed.venue, seed.units, opts.preloadRows);

    await warmPool(appPool);
    const target = engineTarget(appPool);
    const session = openSession({ target, workerPool, seed }, { runId: `mul${Date.now().toString(36)}`, seed: opts.seed, blend: TARGET_BLEND, ...(opts.sweep !== undefined ? { sweep: opts.sweep } : {}) });
    let stop = false;
    let loopError: unknown = null;
    const arrivals = planArrivals([{ ratePerSec: opts.ratePerSec, seconds: 3_600 }], rng(opts.seed + 1));
    const epoch = performance.now();
    const loop = runOpenLoop(arrivals, session.hold, { stopped: () => stop, epoch }).catch((e) => { loopError = e; });
    const sleep = (s: number): Promise<void> => new Promise((res) => setTimeout(res, s * 1_000));
    const timeline: Omit<MigrationWindow, "affected" | "recovery">[] = [];
    try {
      await sleep(opts.baselineSeconds);
      for (const f of FIXTURES) {
        await writeFile(join(dir, f.file), `${f.header}${typeof f.sql === "string" ? f.sql : await f.sql(owner)}\n`);
        let attempts = 0;
        let error: string | null = null;
        const startedAtMs = performance.now() - epoch;
        try {
          await migrate(ownerUrl, dir, { allowBlocking: f.kind === "blocking", onAttempt: () => { attempts += 1; }, ...(opts.lockTimeout !== undefined ? { lockTimeout: opts.lockTimeout } : {}) });
        } catch (e) {
          error = (e as Error).message;
        }
        timeline.push({ file: f.file, kind: f.kind, attempts, startedAtMs, durationMs: performance.now() - epoch - startedAtMs, error });
        await sleep(opts.gapSeconds);
        if (error !== null) break;
      }
    } finally {
      stop = true;
      await loop;
      await session.drain();
      await session.close();
      await target.close();
    }
    if (loopError !== null) throw loopError;
    const rs = session.records;
    const counted = new Set<HoldRecord>();
    const migrations = timeline.map((m, k): MigrationWindow => {
      const endMs = m.startedAtMs + m.durationMs;
      const nextStart = timeline[k + 1]?.startedAtMs ?? endMs + opts.gapSeconds * 1_000;
      const affected = overlapping(rs, m.startedAtMs, endMs);
      const recovery = startedWithin(rs, endMs, nextStart).filter((x) => !affected.includes(x));
      for (const x of [...affected, ...recovery]) counted.add(x);
      return { ...m, affected: windowStats(affected), recovery: windowStats(recovery) };
    });
    const firstStart = timeline[0]?.startedAtMs ?? opts.baselineSeconds * 1_000;
    // the baseline is every request that was answered before the first migration began, after one second of settling
    const baseline = windowStats(rs.filter((x) => x.startedMs >= 1_000 && x.doneMs !== null && x.doneMs < firstStart));
    const errorsOutsideWindows = rs.filter((x) => failed(x) && !counted.has(x)).length;
    return {
      command: "migrate-under-load", database, ratePerSec: opts.ratePerSec, preloadRows: opts.preloadRows, sweep: session.sweep,
      baseline, wholeRun: windowStats(rs), errorsOutsideWindows, migrations,
      thinEvidence: migrations.filter((m) => m.kind === "live-safe" && m.affected.requests < MIN_AFFECTED).map((m) => m.file),
      fixturesApplied: migrations.length === FIXTURES.length && migrations.every((m) => m.error === null),
      underLoad: judgeUnderLoad({ baseline, migrations, fixtures: FIXTURES.filter((f) => f.kind === "live-safe").length, sweepErrors: session.sweep.errors, sweepTicks: session.sweep.ticks, errorsOutsideWindows }),
    };
  } finally {
    await appPool.end().catch(() => undefined);
    await workerPool.end().catch(() => undefined);
    await owner.end().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
    if (!opts.keep) await dropNaiveDatabase(opts.adminUrl, database);
  }
}

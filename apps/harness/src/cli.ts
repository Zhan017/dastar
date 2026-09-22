import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { createDastar, migrate } from "@dastar/db";
import { seedBench } from "./seed.js";
import { runRace } from "./race.js";
import { prepareNaiveDatabase, dropNaiveDatabase, disableProtections, runNaive } from "./naive.js";
import { fmt, writeReport } from "./stats.js";
import { listen } from "@dastar/api/server";
import { runLoad, warmPool, type LoadReport } from "./load.js";
import { createLoadKeys, engineTarget, httpTarget } from "./target.js";
import { DESIGN_SWEEP, type SweepConfig } from "./sweeper.js";
import { parseBlend } from "./workload.js";
import type { Step } from "./schedule.js";

const MIGRATIONS = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "owner-url": { type: "string" },
    "app-url": { type: "string" },
    "admin-url": { type: "string" },
    n: { type: "string", default: "500" },
    keep: { type: "boolean", default: false },
    units: { type: "string", default: "6" },
    combos: { type: "string", default: "2" },
    "worker-url": { type: "string" },
    seed: { type: "string", default: "1" },
    steps: { type: "string", default: "10,25,50,100" },
    "step-seconds": { type: "string", default: "60" },
    sustain: { type: "string" },
    blend: { type: "string", default: "target" },
    "target-hardware": { type: "boolean", default: false },
    target: { type: "string", default: "engine" },
    keys: { type: "string", default: "64" },
    "sweep-every-ms": { type: "string" },
    "sweep-limit": { type: "string" },
    "api-url": { type: "string" },
    "pool-max": { type: "string", default: "16" },
  },
});

/** 0: the verdict is positive. 1: negative, or the run is invalid. 3: inconclusive, which is not a pass. (2 is a usage error.) */
const exitFor = (verdict: "pass" | "met" | "fail" | "missed" | "invalid" | "inconclusive"): number =>
  verdict === "pass" || verdict === "met" ? 0 : verdict === "inconclusive" ? 3 : 1;

function need(name: "owner-url" | "app-url" | "admin-url" | "worker-url"): string {
  const v = values[name];
  if (!v) { console.error(`--${name} is required`); process.exit(2); }
  return v;
}

const n = Number(values.n);
const command = positionals[0];

if (command === "race") {
  const owner = new Client({ connectionString: need("owner-url") });
  await owner.connect();
  const seed = await seedBench(owner, { units: 4, combos: 1 });
  const pool = new Pool({ connectionString: need("app-url"), max: 16 });
  const d = createDastar({ pool, acquireTimeoutMs: 60_000, deadlineMs: 60_000 });
  const r = await runRace(d, owner, seed, n);
  await d.close(); await pool.end(); await owner.end();
  const path = await writeReport("race", r);
  console.log(`race n=${r.n}: winners=${r.winners} conflicts=${r.conflicts} overlaps=${r.overlaps} retries=${r.retries} other=${JSON.stringify(r.other)}`);
  console.log(`latency ms: p50=${r.latencyMs.p50.toFixed(1)} p95=${r.latencyMs.p95.toFixed(1)} p99=${r.latencyMs.p99.toFixed(1)} max=${r.latencyMs.max.toFixed(1)}; elapsed=${r.elapsedMs.toFixed(0)}ms`);
  console.log(`report: ${path}`);
  process.exit(r.winners === 1 && r.conflicts === r.n - 1 && r.overlaps === 0 ? 0 : 1);
} else if (command === "naive") {
  const admin = need("admin-url");
  const { name, url } = await prepareNaiveDatabase(admin, MIGRATIONS);
  let r: Awaited<ReturnType<typeof runNaive>>;
  try {
    await disableProtections(url);
    r = await runNaive(url, n);
  } finally {
    if (values.keep) console.log(`kept database ${name}`);
    else await dropNaiveDatabase(admin, name);
  }
  const path = await writeReport("naive", r);
  console.log(`naive n=${r.n}: committed=${r.committed} overlapping pairs=${r.overlaps} (what a plain check-then-insert does)`);
  console.log(`report: ${path}`);
  process.exit(r.overlaps > 0 ? 0 : 1);
} else if (command === "migrate") {
  const r = await migrate(need("owner-url"), MIGRATIONS);
  console.log(`migrate: applied ${r.applied.length} file(s)${r.applied.length ? ": " + r.applied.join(", ") : ""}`);
} else if (command === "seed") {
  const owner = new Client({ connectionString: need("owner-url") });
  await owner.connect();
  const seeded = await seedBench(owner, { units: Number(values.units), combos: Number(values.combos) });
  await owner.end();
  console.log(JSON.stringify(seeded, null, 2));
} else if (command === "load") {
  if (values.target !== "engine" && values.target !== "http") { console.error("--target is engine or http"); process.exit(2); }
  if (values.sustain && !/^\d+x\d+$/.test(values.sustain)) { console.error("--sustain takes <rate>x<seconds>, for example 50x600"); process.exit(2); }
  const label = values["target-hardware"] ? "target-hardware" : "provisional";
  if (values.target === "http" && label === "target-hardware" && !values["api-url"]) {
    console.error("a target-hardware run over HTTP needs --api-url: the API must run in its own process, not inside the load generator");
    process.exit(2);
  }
  const poolMax = Number(values["pool-max"]);
  const { owner, appPool, workerPool, end } = await connections(poolMax);
  const steps: Step[] = values.steps.split(",").map((x) => ({ ratePerSec: Number(x), seconds: Number(values["step-seconds"]) }));
  if (values.sustain) {
    const [rate, seconds] = values.sustain.split("x").map(Number);
    steps.push({ ratePerSec: rate!, seconds: seconds! });
  }
  const seed = await seedBench(owner, { holdTtlSeconds: 60 });
  let api: Awaited<ReturnType<typeof listen>> | null = null;
  let target;
  if (values.target === "http") {
    // an API started here shares this process with the load generator: fine for a look, not for a claim
    if (!values["api-url"]) api = await listen({ DATABASE_URL: need("app-url"), HOST: "127.0.0.1", PORT: 0, POOL_MAX: poolMax, POOL_ACQUIRE_MS: 5_000, READ_TIMEOUT_MS: 2_000, REQUEST_DEADLINE_MS: 12_000 }, { log: () => undefined });
    target = httpTarget({ url: values["api-url"] ?? api!.url, keys: await createLoadKeys(appPool, Number(values.keys)) });
  } else {
    await warmPool(appPool);
    target = engineTarget(appPool);
  }
  const r = await runLoad({ target, workerPool, owner, seed }, { steps, blend: parseBlend(values.blend), seed: Number(values.seed), label, poolMax, sweep: sweepFromFlags() });
  await target.close();
  if (api) await api.close();
  await end();
  printLoad(r, api !== null);
  console.log(`report: ${await writeReport("load", r)}`);
  // an invalid run is not evidence of anything, whatever its latencies look like; a provisional run has no verdict to report
  const sound = r.overlaps === 0 && r.deadlockDelta === 0 && r.fitViolations === 0 && r.validity.valid;
  process.exit(!sound ? 1 : r.targets ? exitFor(r.targets.verdict) : 0);
} else {
  console.error([
    "usage:",
    "  migrate --owner-url <url>",
    "  seed --owner-url <url> [--units 6] [--combos 2]",
    "  race --owner-url <url> --app-url <url> [--n 500]",
    "  naive --admin-url <url> [--n 50] [--keep]",
    "  load --owner-url <url> --app-url <url> --worker-url <url> [--target engine|http] [--api-url <url>] [--keys 64] [--steps 10,25,50,100] [--step-seconds 60] [--sustain 50x600] [--blend target|overlapping|distinct_dates|disjoint_units|combos] [--seed 1] [--target-hardware]",
    "  exit codes: 0 a positive verdict, or a valid run that has none; 1 a negative verdict or an invalid run; 2 usage; 3 inconclusive",
    "  load, mixed, churn and migrate-under-load run the design's sweeper (every 5000 ms, 20 rows, repeated while rows remain); [--sweep-every-ms N] [--sweep-limit N] change it, and the report records what was used",
  ].join("\n"));
  process.exit(2);
}

async function connections(poolMax: number): Promise<{ owner: Client; appPool: Pool; workerPool: Pool; end: () => Promise<void> }> {
  const owner = new Client({ connectionString: need("owner-url") });
  await owner.connect();
  // idle connections are kept for the whole run, so reconnects are not measured as engine latency
  const appPool = new Pool({ connectionString: need("app-url"), max: poolMax, idleTimeoutMillis: 0 });
  const workerPool = new Pool({ connectionString: need("worker-url"), max: 2 });
  appPool.on("error", (e) => { console.error(`pool error: ${e.message}`); });
  workerPool.on("error", (e) => { console.error(`pool error: ${e.message}`); });
  return { owner, appPool, workerPool, end: async () => { await appPool.end(); await workerPool.end(); await owner.end(); } };
}

function sweepFromFlags(): SweepConfig {
  return { everyMs: Number(values["sweep-every-ms"] ?? DESIGN_SWEEP.everyMs), limit: Number(values["sweep-limit"] ?? DESIGN_SWEEP.limit), drain: true };
}

function sweepLine(s: { config: SweepConfig; ticks: number; batches: number; expired: number; errors: number }): string {
  return `sweeper every ${s.config.everyMs}ms x${s.config.limit}: ${s.ticks} ticks, ${s.batches} batches, ${s.expired} expired, ${s.errors} errors`;
}

function printLoad(r: LoadReport, apiInProcess: boolean): void {
  console.log(`load [${r.label}] target=${r.target}${apiInProcess ? " (API inside this process)" : ""} seed=${r.seed} pool=${r.environment.poolMax} ${r.environment.cpus} cpus`);
  console.log("step  rate  offered  achieved/s  backlog  err%    e2e p50/p95/p99 ms       pool-wait p99  unit-lock p99 distinct-dates  transaction p99");
  for (const s of r.steps) {
    console.log([
      String(s.step).padEnd(5), String(s.ratePerSec).padEnd(5), String(s.offered).padEnd(8), s.achievedPerSec.toFixed(1).padEnd(11), String(s.backlogAtEnd).padEnd(8),
      (s.errorRate * 100).toFixed(2).padEnd(7), `${fmt(s.all.e2eMs.p50)}/${fmt(s.all.e2eMs.p95)}/${fmt(s.all.e2eMs.p99)}`.padEnd(24),
      fmt(s.all.poolWaitMs.p99).padEnd(14), fmt(s.mixes.distinct_dates.unitLockMs.p99).padEnd(29), fmt(s.all.transactionMs.p99),
    ].join(" "));
    console.log(`      answers ${JSON.stringify(s.byCode)} dispatch lag p99 ${fmt(s.dispatchLagMs.p99)} ms censored: pool ${s.all.poolWaitMs.censored}, lock ${s.all.unitLockMs.censored}; follow-ups ${JSON.stringify(s.followUps.byCode)}`);
  }
  console.log(`drained ${r.drainMs.toFixed(0)} ms after the last arrival (holds alone ${r.holdDrainMs.toFixed(0)} ms); most holds waiting at one instant: ${r.peakOutstanding}`);
  console.log("n/a: too few samples to state that percentile; a..b or >=a: bounds, because some requests ended inside the phase");
  if (r.transport.timeouts + r.transport.errors > 0) console.log(`no complete answer: ${r.transport.timeouts} timed out at the harness, ${r.transport.errors} failed to connect; the database shows ${r.transport.holdsCommitted} of those holds committed and ${r.transport.holdsNotCommitted} not`);
  console.log(r.validity.valid ? "run valid: follow-ups, sweeper, invariants, and transport all clean" : `RUN INVALID, nothing below is evidence: ${r.validity.reasons.join("; ")}`);
  console.log(`deadlocks=${r.deadlockDelta} overlaps=${r.overlaps} fit violations=${r.fitViolations} retries=${r.retries}; ${sweepLine(r.sweep)}`);
  if (r.targets) {
    for (const t of r.targets.checks) console.log(`  ${t.status.padEnd(12)} ${t.name} [${t.scope}]: ${t.atLeast === null ? "n/a" : fmt({ atLeast: t.atLeast, atMost: t.atMost }, 3)} (limit ${t.limit})${t.note ? ` - ${t.note}` : ""}`);
    for (const d of r.targets.workload.differences) console.log(`  not the target workload: ${d}`);
    console.log(`  targets: ${r.targets.verdict}${r.targets.workload.matchesTarget ? "" : " (a workload other than the target's can miss the targets, never meet them)"}`);
  } else {
    console.log("provisional: this machine is not the target hardware class, so the design targets are not applied");
  }
}

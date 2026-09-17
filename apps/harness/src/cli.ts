import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { createDastar, migrate } from "@dastar/db";
import { seedBench } from "./seed.js";
import { runRace } from "./race.js";
import { prepareNaiveDatabase, dropNaiveDatabase, disableProtections, runNaive } from "./naive.js";
import { writeReport } from "./stats.js";

const MIGRATIONS = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "owner-url": { type: "string" },
    "app-url": { type: "string" },
    "admin-url": { type: "string" },
    n: { type: "string", default: "500" },
    keep: { type: "boolean", default: false },
  },
});

function need(name: "owner-url" | "app-url" | "admin-url"): string {
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
} else {
  console.error("usage: migrate --owner-url <url> | race --owner-url <url> --app-url <url> [--n 500] | naive --admin-url <url> [--n 50] [--keep]");
  process.exit(2);
}

import { Pool } from "pg";
import { createDastar } from "@dastar/db";
import { DESIGN_SWEEP, startSweeper, type SweepConfig, type SweepStats } from "./sweeper.js";

export type WorkerConfig = {
  /** Connection string for the dastar_worker role. */
  databaseUrl: string;
  sweep: SweepConfig;
  poolMax: number;
};

export type WorkerLogEntry =
  | { ts: string; level: "info"; msg: "expired"; count: number }
  | { ts: string; level: "error"; msg: "sweep failed" | "pool error"; error: string; code?: string };

/** Reads the worker's settings from the environment; the sweeper defaults to the design's. Throws on a value it cannot use. */
export function parseWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const int = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const v = Number(raw);
    if (!Number.isInteger(v) || v < 1) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
    return v;
  };
  return {
    databaseUrl,
    sweep: { everyMs: int("SWEEP_EVERY_MS", DESIGN_SWEEP.everyMs), limit: int("SWEEP_LIMIT", DESIGN_SWEEP.limit), drain: DESIGN_SWEEP.drain },
    poolMax: int("POOL_MAX", 2),
  };
}

export type RunningWorker = { stats: SweepStats; stop: () => Promise<void> };

const defaultLog = (entry: WorkerLogEntry): void => {
  (entry.level === "error" ? console.error : console.log)(JSON.stringify(entry));
};

/**
 * Starts the sweeper on a pool of its own, connected as dastar_worker. The same function runs in the
 * worker process and can be called inside a host process instead (D14). A failed batch is logged and
 * retried at the next tick; `stop` waits for the batch in flight, then closes the handle and the pool.
 */
export function startWorker(config: WorkerConfig, opts: { log?: (entry: WorkerLogEntry) => void } = {}): RunningWorker {
  const log = opts.log ?? defaultLog;
  const now = (): string => new Date().toISOString();
  const pool = new Pool({ connectionString: config.databaseUrl, max: config.poolMax, application_name: "dastar-worker" });
  pool.on("error", (e) => { log({ ts: now(), level: "error", msg: "pool error", error: e.message }); });
  const dastar = createDastar({ pool, cancellerConnectionString: config.databaseUrl });
  const sweeper = startSweeper(dastar, config.sweep, {
    onExpired: (ids) => { if (ids.length > 0) log({ ts: now(), level: "info", msg: "expired", count: ids.length }); },
    onError: (e) => {
      const code = (e as { code?: unknown }).code;
      log({ ts: now(), level: "error", msg: "sweep failed", error: e instanceof Error ? e.message : String(e), ...(typeof code === "string" ? { code } : {}) });
    },
  });
  return {
    stats: sweeper.stats,
    stop: async () => { await sweeper.stop(); await dastar.close(); await pool.end(); },
  };
}

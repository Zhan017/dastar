import type { Pool } from "pg";
import type { Dastar } from "@dastar/db";

export type ApiKey = { id: string; capabilities: string[]; venueIds: string[] | null };
export type Env = { Variables: { traceId: string; key: ApiKey | null } };
export type LogEntry = { ts: string; method: string; path: string; status: number; duration_ms: number; trace_id: string; key_id: string | null };
export type Deps = {
  dastar: Dastar;
  /** Same pool the handle uses; the API reads keys and readiness through it. */
  pool: Pool;
  /** Directory of the engine's migration files; readiness compares it with the applied set. */
  migrationsDir: string;
  log?: (entry: LogEntry) => void;
  /** How long a key lookup or readiness check waits for a pooled connection. Default 5000. */
  acquireTimeoutMs?: number;
  /** Deadline for a key lookup once it has a connection; past it the connection is discarded. Default 2000. */
  readTimeoutMs?: number;
};

import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { createDastar } from "@dastar/db";
import { createApp } from "../src/app.js";
import type { LogEntry } from "../src/env.js";
import type { Conn } from "../../../packages/db/test/helpers/db.js";

export const MIGRATIONS = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

export function makeApi(conn: Conn, opts: { poolMax?: number; appName?: string } = {}) {
  const pool = new Pool({ connectionString: conn.app, max: opts.poolMax ?? 8, application_name: opts.appName ?? "api-test" });
  pool.on("error", () => undefined);
  const dastar = createDastar({ pool, cancellerConnectionString: conn.app });
  const lines: LogEntry[] = [];
  const app = createApp({ dastar, pool, migrationsDir: MIGRATIONS, log: (e) => { lines.push(e); } });
  return { app, pool, dastar, lines, close: async () => { await dastar.close(); await pool.end(); } };
}

export const bearer = (key: string): Record<string, string> => ({ authorization: `Bearer ${key}` });

export function jsonInit(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) };
}

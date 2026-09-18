import { fileURLToPath, pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { z } from "@hono/zod-openapi";
import { Pool } from "pg";
import { createDastar } from "@dastar/db";
import { createApp } from "./app.js";

const ConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  POOL_MAX: z.coerce.number().int().min(1).default(16),
  POOL_ACQUIRE_MS: z.coerce.number().int().min(1).default(5_000),
  REQUEST_DEADLINE_MS: z.coerce.number().int().min(1).default(12_000),
});
export type Config = z.infer<typeof ConfigSchema>;

export function parseConfig(env: Record<string, string | undefined>): Config {
  return ConfigSchema.parse(env);
}

const MIGRATIONS = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

/** One pool, one engine handle, one app. The pool gets the error listener pg-pool requires. */
export function buildServer(config: Config) {
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: config.POOL_MAX, application_name: "dastar-api" });
  pool.on("error", (e) => { console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "pool error", error: e.message })); });
  const dastar = createDastar({
    pool, acquireTimeoutMs: config.POOL_ACQUIRE_MS, deadlineMs: config.REQUEST_DEADLINE_MS, cancellerConnectionString: config.DATABASE_URL,
  });
  const app = createApp({ dastar, pool, migrationsDir: MIGRATIONS, acquireTimeoutMs: config.POOL_ACQUIRE_MS });
  return { app, close: async (): Promise<void> => { await dastar.close(); await pool.end(); } };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = parseConfig(process.env);
  const built = buildServer(config);
  const server = serve({ fetch: built.app.fetch, port: config.PORT }, (info) => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), msg: "listening", port: info.port }));
  });
  const stop = (): void => { server.close(() => { void built.close().then(() => process.exit(0), () => process.exit(1)); }); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

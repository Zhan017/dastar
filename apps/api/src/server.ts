import { fileURLToPath, pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { z } from "@hono/zod-openapi";
import { Pool } from "pg";
import { createDastar } from "@dastar/db";
import { createApp } from "./app.js";
import type { Deps } from "./env.js";

const ConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  // loopback unless told otherwise: a process that should be reachable from elsewhere says so
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  POOL_MAX: z.coerce.number().int().min(1).default(16),
  POOL_ACQUIRE_MS: z.coerce.number().int().min(1).default(5_000),
  READ_TIMEOUT_MS: z.coerce.number().int().min(1).default(2_000),
  REQUEST_DEADLINE_MS: z.coerce.number().int().min(1).default(12_000),
});
export type Config = z.infer<typeof ConfigSchema>;

export function parseConfig(env: Record<string, string | undefined>): Config {
  return ConfigSchema.parse(env);
}

const MIGRATIONS = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

/** One pool, one engine handle, one app. The pool gets the error listener pg-pool requires. */
export function buildServer(config: Config, opts: { log?: Deps["log"] } = {}) {
  const pool = new Pool({ connectionString: config.DATABASE_URL, max: config.POOL_MAX, application_name: "dastar-api" });
  pool.on("error", (e) => { console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "pool error", error: e.message })); });
  const dastar = createDastar({
    pool, acquireTimeoutMs: config.POOL_ACQUIRE_MS, deadlineMs: config.REQUEST_DEADLINE_MS, cancellerConnectionString: config.DATABASE_URL,
  });
  const app = createApp({
    dastar, pool, migrationsDir: MIGRATIONS, acquireTimeoutMs: config.POOL_ACQUIRE_MS, readTimeoutMs: config.READ_TIMEOUT_MS,
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
  return { app, close: async (): Promise<void> => { await dastar.close(); await pool.end(); } };
}

/** Builds the server and listens on config.HOST; resolves once the port is bound, rejects if it cannot be. Port 0 picks a free one. */
export async function listen(config: Config, opts: { log?: Deps["log"] } = {}): Promise<{ url: string; host: string; port: number; close: () => Promise<void> }> {
  const built = buildServer(config, opts);
  type Bound = { server: ReturnType<typeof serve>; host: string; port: number };
  let bound: Bound;
  try {
    bound = await new Promise<Bound>((resolve, reject) => {
      const s = serve({ fetch: built.app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
        s.off("error", reject);
        // once bound, a later server-level error (EMFILE, a socket error) is logged rather than left with no listener
        s.on("error", (e) => { console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "server error", error: e.message })); });
        resolve({ server: s, host: info.address, port: info.port });
      });
      s.once("error", reject);
    });
  } catch (e) {
    await built.close();
    throw e;
  }
  const { server, host, port } = bound;
  // a wildcard address is one to listen on, not one to dial
  const dial = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${dial}:${port}`,
    host,
    port,
    close: () => new Promise<void>((resolve, reject) => { server.close(() => { built.close().then(resolve, reject); }); }),
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const running = await listen(parseConfig(process.env));
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg: "listening", host: running.host, port: running.port }));
  const stop = (): void => { void running.close().then(() => process.exit(0), () => process.exit(1)); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

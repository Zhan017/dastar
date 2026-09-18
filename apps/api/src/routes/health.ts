import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { DastarError, readMigrationFiles, type MigrationFile } from "@dastar/db";
import type { Deps, Env } from "../env.js";
import { withClient } from "../db.js";
import { ApiProblem } from "../problem.js";
import { ProblemSchema } from "../schemas.js";

const live = createRoute({
  method: "get",
  path: "/health/live",
  summary: "The process is up.",
  responses: { 200: { description: "Live", content: { "application/json": { schema: z.object({ status: z.literal("live") }) } } } },
});

const ready = createRoute({
  method: "get",
  path: "/health/ready",
  summary: "The database is reachable and every shipped migration is applied with a matching checksum.",
  responses: {
    200: { description: "Ready", content: { "application/json": { schema: z.object({ status: z.literal("ready"), migrations: z.number().int() }) } } },
    503: { description: "Not ready", content: { "application/problem+json": { schema: ProblemSchema } } },
  },
});

export function register(app: OpenAPIHono<Env>, deps: Deps): void {
  const shipped = readMigrationFiles(deps.migrationsDir);
  shipped.catch(() => undefined);

  app.openapi(live, (c) => c.json({ status: "live" as const }, 200));

  app.openapi(ready, async (c) => {
    const notReady = (detail: string): ApiProblem => new ApiProblem(503, "not_ready", detail, { "Retry-After": "1" });
    let required: MigrationFile[];
    try {
      required = await shipped;
    } catch {
      throw notReady("migration files unreadable");
    }
    let applied: Map<number, Buffer>;
    try {
      applied = await withClient(deps.pool, { acquireMs: 1_000, readMs: 1_000 }, async (cl) => {
        const r = await cl.query("select version, checksum from dastar.schema_migration");
        return new Map(r.rows.map((row) => [row.version as number, row.checksum as Buffer]));
      });
    } catch (e) {
      throw notReady(e instanceof DastarError ? e.code : "database unreachable");
    }
    // every shipped migration must be there, unchanged; extra applied ones do not make up for a missing one
    for (const m of required) {
      const got = applied.get(m.version);
      if (!got) throw notReady(`migration ${m.file} is not applied`);
      if (!got.equals(m.checksum)) throw notReady(`migration ${m.file} differs from the applied one`);
    }
    return c.json({ status: "ready" as const, migrations: required.length }, 200);
  });
}

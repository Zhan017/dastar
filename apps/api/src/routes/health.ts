import { readdir } from "node:fs/promises";
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { DastarError } from "@dastar/db";
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
  summary: "The database is reachable and every shipped migration is applied.",
  responses: {
    200: { description: "Ready", content: { "application/json": { schema: z.object({ status: z.literal("ready"), migrations: z.number().int() }) } } },
    503: { description: "Not ready", content: { "application/problem+json": { schema: ProblemSchema } } },
  },
});

export function register(app: OpenAPIHono<Env>, deps: Deps): void {
  const shipped = readdir(deps.migrationsDir).then((files) => files.filter((f) => /^\d{4}_.+\.sql$/.test(f)).length);
  shipped.catch(() => undefined);

  app.openapi(live, (c) => c.json({ status: "live" as const }, 200));

  app.openapi(ready, async (c) => {
    const notReady = (detail: string): ApiProblem => new ApiProblem(503, "not_ready", detail, { "Retry-After": "1" });
    let expected: number;
    let applied: number;
    try {
      expected = await shipped;
      applied = await withClient(deps.pool, 1_000, async (cl) => (await cl.query("select count(*)::int as n from dastar.schema_migration")).rows[0].n as number);
    } catch (e) {
      throw notReady(e instanceof DastarError ? e.code : "database unreachable");
    }
    if (applied < expected) throw notReady(`migrations applied ${applied} of ${expected}`);
    return c.json({ status: "ready" as const, migrations: applied }, 200);
  });
}

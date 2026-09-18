import { randomUUID } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Deps, Env, LogEntry } from "./env.js";
import { ApiProblem, fromUnknown, problemBody } from "./problem.js";
import { register as registerHealth } from "./routes/health.js";

const TRACE_RE = /^[A-Za-z0-9._:-]{1,100}$/;

export function createApp(deps: Deps): OpenAPIHono<Env> {
  const log = deps.log ?? ((e: LogEntry): void => { console.log(JSON.stringify(e)); });
  const app = new OpenAPIHono<Env>({
    defaultHook: (result) => {
      if (!result.success) {
        throw new ApiProblem(400, "validation", result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      }
    },
  });

  // trace id first, so every response and every log entry carries one; never log a body
  app.use("*", async (c, next) => {
    const started = Date.now();
    const given = c.req.header("x-trace-id");
    c.set("traceId", given !== undefined && TRACE_RE.test(given) ? given : randomUUID());
    c.set("key", null);
    await next();
    c.res.headers.set("x-trace-id", c.get("traceId"));
    log({
      ts: new Date().toISOString(), method: c.req.method, path: c.req.path, status: c.res.status,
      duration_ms: Date.now() - started, trace_id: c.get("traceId"), key_id: c.get("key")?.id ?? null,
    });
  });

  app.onError((err, c) => {
    const p = fromUnknown(err);
    return c.newResponse(JSON.stringify(problemBody(p, c.get("traceId") ?? "none")), p.status, { "content-type": "application/problem+json", ...p.headers });
  });
  app.notFound((c) => {
    const p = new ApiProblem(404, "not_found", "no such route");
    return c.newResponse(JSON.stringify(problemBody(p, c.get("traceId") ?? "none")), 404, { "content-type": "application/problem+json" });
  });

  app.openAPIRegistry.registerComponent("securitySchemes", "Bearer", { type: "http", scheme: "bearer" });
  registerHealth(app, deps);
  app.doc("/openapi.json", { openapi: "3.0.0", info: { title: "Dastar reference API", version: "0.1.0" } });
  return app;
}

import { randomUUID } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import type { Deps, Env, LogEntry } from "./env.js";
import { ApiProblem, bodyTooLarge, fromUnknown, problemBody } from "./problem.js";
import { register as registerAdminCalendar } from "./routes/admin-calendar.js";
import { register as registerAdminKeys } from "./routes/admin-keys.js";
import { register as registerAdminUnits } from "./routes/admin-units.js";
import { register as registerAudit } from "./routes/audit.js";
import { register as registerAvailability } from "./routes/availability.js";
import { register as registerDocs } from "./routes/docs.js";
import { register as registerHealth } from "./routes/health.js";
import { register as registerHolds } from "./routes/holds.js";
import { register as registerReservations } from "./routes/reservations.js";
import { register as registerSessions } from "./routes/sessions.js";

const TRACE_RE = /^[A-Za-z0-9._:-]{1,100}$/;
/** The transcript post, which takes a larger body than every other route. */
const AUDIT_POST_PATH = /^\/v1\/sessions\/[^/]+\/audit$/;

/** The document's header: `/openapi.json` and the committed apps/api/openapi.json are both built with it. */
export const OPENAPI_CONFIG = { openapi: "3.0.0", info: { title: "Dastar reference API", version: "0.2.0" } };

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

  // the confirm route parses a body without any credential, so the bound applies to every route. The one exemption is
  // the audit post: that route checks the key before it reads a body, and applies its own 1 MiB bound.
  const smallBody = bodyLimit({ maxSize: 64 * 1024, onError: bodyTooLarge });
  app.use("*", (c, next) => (c.req.method === "POST" && AUDIT_POST_PATH.test(c.req.path) ? next() : smallBody(c, next)));

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
  registerHolds(app, deps);
  registerAvailability(app, deps);
  registerReservations(app, deps);
  registerSessions(app, deps);
  registerAudit(app, deps);
  registerAdminUnits(app, deps);
  registerAdminCalendar(app, deps);
  registerAdminKeys(app, deps);
  app.doc("/openapi.json", OPENAPI_CONFIG);
  registerDocs(app);
  return app;
}

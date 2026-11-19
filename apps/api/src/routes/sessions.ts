import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { Deps, Env } from "../env.js";
import { requireCapability, requireKey, assertVenueInScope, ownSessionVenue } from "../auth.js";
import { ApiProblem } from "../problem.js";
import { IdParam, SessionCreatedSchema, SessionRequestSchema, SessionSchema, problemResponses } from "../schemas.js";

export function register(app: OpenAPIHono<Env>, deps: Deps): void {
  const json = <S>(schema: S) => ({ "application/json": { schema } });

  const open = createRoute({
    method: "post", path: "/v1/sessions",
    summary: "Open an audit session for the calling key in a venue. Refused with 403 for a key that can confirm or administer.",
    security: [{ Bearer: [] }], middleware: [requireCapability(deps, "read")] as const,
    request: { body: { required: true, content: json(SessionRequestSchema) } },
    responses: { 201: { description: "The session, to send as the Dastar-Session header of the agent's tool calls", content: json(SessionCreatedSchema) }, ...problemResponses },
  });
  app.openapi(open, async (c) => {
    const key = requireKey(c);
    const venueId = c.req.valid("json").venue_id.toLowerCase();
    assertVenueInScope(key, venueId);
    if (key.capabilities.includes("confirm") || key.capabilities.includes("admin")) {
      throw new ApiProblem(403, "forbidden", "a key that can confirm or administer cannot open an audit session");
    }
    const s = await deps.dastar.sessions.openSession({ venueId, apiKeyId: key.id });
    return c.json({ id: s.id, venue_id: s.venueId, kind: s.kind, started_at: s.startedAt }, 201);
  });

  const read = createRoute({
    method: "get", path: "/v1/sessions/{id}", summary: "Read an audit session of the calling key. A session not seen for 30 days reads as absent.",
    security: [{ Bearer: [] }], middleware: [requireCapability(deps, "read")] as const,
    request: { params: IdParam },
    responses: { 200: { description: "The session", content: json(SessionSchema) }, ...problemResponses },
  });
  app.openapi(read, async (c) => {
    const key = requireKey(c);
    const id = c.req.valid("param").id.toLowerCase();
    const venueId = await ownSessionVenue(deps, key, id);
    const s = await deps.dastar.sessions.getSession({ sessionId: id, venueId });
    if (s === null) throw new ApiProblem(404, "not_found", "no such session");
    return c.json({
      id: s.id, venue_id: s.venueId, kind: s.kind, started_at: s.startedAt, last_seen_at: s.lastSeenAt, calls: s.calls, audited_at: s.auditedAt,
    }, 200);
  });
}

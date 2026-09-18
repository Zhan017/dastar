import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Deps, Env } from "../env.js";
import { requireCapability, requireKey, assertVenueInScope } from "../auth.js";
import { problemFor } from "../problem.js";
import { HoldBodySchema, HoldResponseSchema, IdParam, problemResponses, toReceipt } from "../schemas.js";

export function register(app: OpenAPIHono<Env>, deps: Deps): void {
  const route = createRoute({
    method: "post",
    path: "/v1/venues/{id}/holds",
    summary: "Hold an explicit assignment for a time range. Returns a receipt, never a token.",
    security: [{ Bearer: [] }],
    middleware: [requireCapability(deps, "hold")] as const,
    request: {
      params: IdParam,
      headers: z.object({ "idempotency-key": z.string().min(1).max(200) }),
      body: { required: true, content: { "application/json": { schema: HoldBodySchema } } },
    },
    responses: { 201: { description: "Held, or the stored success replayed", content: { "application/json": { schema: HoldResponseSchema } } }, ...problemResponses },
  });

  app.openapi(route, async (c) => {
    const key = requireKey(c);
    const venueId = c.req.valid("param").id.toLowerCase();
    assertVenueInScope(key, venueId);
    const body = c.req.valid("json");
    const out = await deps.dastar.hold({
      venueId,
      actor: `key:${key.id}`,
      traceId: c.get("traceId"),
      idempotencyKey: c.req.valid("header")["idempotency-key"],
      partySize: body.party_size,
      startsAt: body.starts_at,
      durationMinutes: body.duration_minutes,
      assignment: { kind: body.assignment.kind, id: body.assignment.id.toLowerCase() },
      ...(body.external_ref !== undefined ? { externalRef: body.external_ref } : {}),
    });
    // a stored domain outcome is part of the idempotency contract: same status on replay, with the flag
    if (!out.ok) throw problemFor(out.error.code, out.error.message, { replayed: out.replayed });
    return c.json({ receipt: toReceipt(out.receipt), hold_expires_at: out.holdExpiresAt, replayed: out.replayed }, 201);
  });
}

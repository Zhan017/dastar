import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { Deps, Env } from "../env.js";
import { requireCapability, requireKey, assertVenueInScope } from "../auth.js";
import { AvailabilityBodySchema, AvailabilityResponseSchema, IdParam, problemResponses } from "../schemas.js";

export function register(app: OpenAPIHono<Env>, deps: Deps): void {
  const route = createRoute({
    method: "post",
    path: "/v1/venues/{id}/availability",
    summary: "Bookable start times for a party in a window, each with the exact starts_at, duration_minutes, and assignment a hold accepts. Read from live occupancy; a hold is still the judge. The window may not exceed the venue's availability window (422 window_too_large); a venue outside the key's venues answers 404.",
    security: [{ Bearer: [] }],
    middleware: [requireCapability(deps, "read")] as const,
    request: {
      params: IdParam,
      body: { required: true, content: { "application/json": { schema: AvailabilityBodySchema } } },
    },
    responses: { 200: { description: "The bookable slots in start order, and whether the list was cut short", content: { "application/json": { schema: AvailabilityResponseSchema } } }, ...problemResponses },
  });

  app.openapi(route, async (c) => {
    const key = requireKey(c);
    const venueId = c.req.valid("param").id.toLowerCase();
    assertVenueInScope(key, venueId);
    const body = c.req.valid("json");
    const out = await deps.dastar.availability({
      venueId,
      partySize: body.party_size,
      from: body.from,
      to: body.to,
      ...(body.limit !== undefined ? { limit: body.limit } : {}),
    });
    return c.json({
      slots: out.slots.map((s) => ({ starts_at: s.startsAt, duration_minutes: s.durationMinutes, assignment: { kind: s.assignment.kind, id: s.assignment.id } })),
      truncated: out.truncated,
    }, 200);
  });
}

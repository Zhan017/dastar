import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { Deps, Env } from "../env.js";
import { requireCapability, requireKey, assertVenueInScope } from "../auth.js";
import { createVenueKey, listVenueKeys, revokeVenueKey } from "../keys.js";
import { CreateKeySchema, IdParam, KeyCreatedSchema, KeyListSchema, KeyParams, KeyResponseSchema, problemResponses, toKey } from "../schemas.js";

export function register(app: OpenAPIHono<Env>, deps: Deps): void {
  const json = <S>(schema: S) => ({ "application/json": { schema } });

  const listKeys = createRoute({
    method: "get", path: "/admin/venues/{id}/keys",
    summary: "List the keys scoped to this venue alone, revoked ones included, oldest first. Keys of several venues or of all venues are not listed. A key's hash is never returned. Requires the admin capability; a venue outside the key's venues answers 404.",
    security: [{ Bearer: [] }], middleware: [requireCapability(deps, "admin")] as const,
    request: { params: IdParam },
    responses: { 200: { description: "The venue's keys", content: json(KeyListSchema) }, ...problemResponses },
  });
  app.openapi(listKeys, async (c) => {
    const key = requireKey(c);
    const venueId = c.req.valid("param").id.toLowerCase();
    assertVenueInScope(key, venueId);
    const keys = await listVenueKeys(deps, venueId);
    return c.json({ keys: keys.map(toKey) }, 200);
  });

  const createKeyRoute = createRoute({
    method: "post", path: "/admin/venues/{id}/keys",
    summary: "Create a key scoped to this venue alone, with 1 to 6 distinct capabilities (hold, confirm, cancel, seat, read, admin). The response carries the secret, which is shown once and cannot be retrieved later. A venue that does not exist answers 404.",
    security: [{ Bearer: [] }], middleware: [requireCapability(deps, "admin")] as const,
    request: { params: IdParam, body: { required: true, content: json(CreateKeySchema) } },
    responses: { 201: { description: "The key and its secret, shown once", content: json(KeyCreatedSchema) }, ...problemResponses },
  });
  app.openapi(createKeyRoute, async (c) => {
    const key = requireKey(c);
    const venueId = c.req.valid("param").id.toLowerCase();
    assertVenueInScope(key, venueId);
    const body = c.req.valid("json");
    const created = await createVenueKey(deps, venueId, { label: body.label, capabilities: body.capabilities });
    return c.json({ key: toKey(created.key), secret: created.secret }, 201);
  });

  const revokeKey = createRoute({
    method: "post", path: "/admin/venues/{id}/keys/{keyId}/revoke",
    summary: "Revoke a key scoped to this venue alone; the key answers 401 from then on. Revoking again keeps the first revoked_at. A key may revoke itself. A key of another venue, of several venues, or of all venues answers 404.",
    security: [{ Bearer: [] }], middleware: [requireCapability(deps, "admin")] as const,
    request: { params: KeyParams },
    responses: { 200: { description: "The revoked key", content: json(KeyResponseSchema) }, ...problemResponses },
  });
  app.openapi(revokeKey, async (c) => {
    const key = requireKey(c);
    const params = c.req.valid("param");
    const venueId = params.id.toLowerCase();
    assertVenueInScope(key, venueId);
    const revoked = await revokeVenueKey(deps, venueId, params.keyId.toLowerCase());
    return c.json({ key: toKey(revoked) }, 200);
  });
}

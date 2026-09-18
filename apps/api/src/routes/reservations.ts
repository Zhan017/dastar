import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { ReservationView } from "@dastar/db";
import type { ApiKey, Deps, Env } from "../env.js";
import { requireCapability, requireKey } from "../auth.js";
import { ApiProblem } from "../problem.js";
import {
  CancelBodySchema, ConfirmBodySchema, IdParam, MintBodySchema, MintResponseSchema,
  ReceiptResponseSchema, ReservationSchema, problemResponses, toReceipt,
} from "../schemas.js";

const TOKEN_REFUSED = "confirm token does not match";

export function register(app: OpenAPIHono<Env>, deps: Deps): void {
  /** A reservation outside the key's venues reads as absent. */
  async function loadInScope(key: ApiKey, id: string): Promise<ReservationView> {
    const view = await deps.dastar.getReservation(id);
    if (!view || (key.venueIds !== null && !key.venueIds.includes(view.venueId))) throw new ApiProblem(404, "not_found", "no such reservation");
    return view;
  }
  const json = <S>(schema: S) => ({ "application/json": { schema } });

  const read = createRoute({
    method: "get", path: "/v1/reservations/{id}", summary: "Read a reservation with its effective status and history.",
    security: [{ Bearer: [] }], middleware: [requireCapability(deps, "read")] as const,
    request: { params: IdParam },
    responses: { 200: { description: "The reservation", content: json(ReservationSchema) }, ...problemResponses },
  });
  app.openapi(read, async (c) => {
    const v = await loadInScope(requireKey(c), c.req.valid("param").id.toLowerCase());
    return c.json({
      id: v.id, venue_id: v.venueId, status: v.status, stored_status: v.storedStatus, party_size: v.partySize, during: v.during,
      assignment: v.assignment, hold_expires_at: v.holdExpiresAt, version: v.version, external_ref: v.externalRef, history: v.history,
    }, 200);
  });

  const cancel = createRoute({
    method: "post", path: "/v1/reservations/{id}/cancel", summary: "Cancel a held, confirmed, or seated reservation.",
    security: [{ Bearer: [] }], middleware: [requireCapability(deps, "cancel")] as const,
    request: { params: IdParam, body: { required: true, content: json(CancelBodySchema) } },
    responses: { 200: { description: "Cancelled", content: json(ReceiptResponseSchema) }, ...problemResponses },
  });
  app.openapi(cancel, async (c) => {
    const key = requireKey(c);
    const id = c.req.valid("param").id.toLowerCase();
    const body = c.req.valid("json");
    const view = await loadInScope(key, id);
    const receipt = await deps.dastar.cancel({
      reservationId: id, actor: `key:${key.id}`, traceId: c.get("traceId"), venueId: view.venueId, reason: body.reason,
      ...(body.expected_version !== undefined ? { expectedVersion: body.expected_version } : {}),
    });
    return c.json({ receipt: toReceipt(receipt) }, 200);
  });

  const mint = createRoute({
    method: "post", path: "/v1/reservations/{id}/confirm-token",
    summary: "Mint a single-use confirm token for a human channel. Replaces any previous token. The only response that carries a token.",
    security: [{ Bearer: [] }], middleware: [requireCapability(deps, "confirm")] as const,
    request: { params: IdParam, body: { required: true, content: json(MintBodySchema) } },
    responses: { 201: { description: "Minted", content: json(MintResponseSchema) }, ...problemResponses },
  });
  app.openapi(mint, async (c) => {
    const key = requireKey(c);
    const id = c.req.valid("param").id.toLowerCase();
    const body = c.req.valid("json");
    const view = await loadInScope(key, id);
    const out = await deps.dastar.mintConfirmToken({
      reservationId: id, actor: `key:${key.id}`, traceId: c.get("traceId"), venueId: view.venueId,
      ...(body.expected_version !== undefined ? { expectedVersion: body.expected_version } : {}),
    });
    return c.json({ confirm_token: out.token, version: out.version }, 201);
  });

  const confirm = createRoute({
    method: "post", path: "/v1/reservations/{id}/confirm",
    summary: "Confirm a held reservation with a key that has the confirm capability, or with a confirm token and no key. expected_version applies to the key path only.",
    security: [{ Bearer: [] }, {}], middleware: [requireCapability(deps, "confirm", { orToken: true })] as const,
    request: { params: IdParam, body: { required: true, content: json(ConfirmBodySchema) } },
    responses: { 200: { description: "Confirmed", content: json(ReceiptResponseSchema) }, ...problemResponses },
  });
  app.openapi(confirm, async (c) => {
    const id = c.req.valid("param").id.toLowerCase();
    const body = c.req.valid("json");
    const version = body.expected_version !== undefined ? { expectedVersion: body.expected_version } : {};
    if (body.confirm_token !== undefined) {
      // the token is the credential: no key, no scope, no version to assert; absent and mismatched read the same
      const view = await deps.dastar.getReservation(id);
      if (!view) throw new ApiProblem(403, "forbidden", TOKEN_REFUSED);
      const receipt = await deps.dastar.confirm({ reservationId: id, actor: "token", traceId: c.get("traceId"), venueId: view.venueId, confirmToken: body.confirm_token });
      return c.json({ receipt: toReceipt(receipt) }, 200);
    }
    const key = requireKey(c);
    if (!key.capabilities.includes("confirm")) throw new ApiProblem(403, "forbidden", "the key lacks the confirm capability");
    const view = await loadInScope(key, id);
    const receipt = await deps.dastar.confirm({ reservationId: id, actor: `key:${key.id}`, traceId: c.get("traceId"), venueId: view.venueId, ...version });
    return c.json({ receipt: toReceipt(receipt) }, 200);
  });
}

import { z } from "@hono/zod-openapi";
import type { Receipt } from "@dastar/db";

export const ProblemSchema = z.object({
  type: z.string(), title: z.string(), status: z.number().int(), code: z.string(),
  detail: z.string().optional(), trace_id: z.string(),
}).openapi("Problem");

const problemContent = { "application/problem+json": { schema: ProblemSchema } };
/** Every route can fail with any of these; declaring them once keeps the document honest. */
export const problemResponses = {
  400: { description: "Validation failed", content: problemContent },
  401: { description: "Missing or unknown key", content: problemContent },
  403: { description: "Not permitted", content: problemContent },
  404: { description: "Not found or outside the key's venues", content: problemContent },
  409: { description: "Conflict", content: problemContent },
  422: { description: "Unprocessable", content: problemContent },
  429: { description: "Too many live holds", content: problemContent },
  500: { description: "Internal error", content: problemContent },
  503: { description: "Temporarily unavailable", content: problemContent },
} as const;

export const ReceiptSchema = z.object({
  reservation_id: z.string(), status: z.string(), version: z.number().int(), audit_id: z.number().int(), trace_id: z.string(),
}).openapi("Receipt");

export function toReceipt(r: Receipt): z.infer<typeof ReceiptSchema> {
  return { reservation_id: r.reservationId, status: r.status, version: r.version, audit_id: r.auditId, trace_id: r.traceId };
}

export const IdParam = z.object({ id: z.guid().openapi({ param: { name: "id", in: "path" } }) });

export const HoldBodySchema = z.object({
  party_size: z.number().int().min(1),
  starts_at: z.iso.datetime({ offset: true }),
  duration_minutes: z.number().int().min(1),
  assignment: z.object({ kind: z.enum(["unit", "combo"]), id: z.guid() }),
  external_ref: z.string().min(1).max(200).optional(),
}).openapi("HoldRequest");

export const HoldResponseSchema = z.object({ receipt: ReceiptSchema, hold_expires_at: z.string(), replayed: z.boolean() }).openapi("HoldResponse");

export const ReservationSchema = z.object({
  id: z.string(), venue_id: z.string(), status: z.string(), stored_status: z.string(), party_size: z.number().int(),
  during: z.string(), assignment: z.object({ kind: z.string(), id: z.string() }), hold_expires_at: z.string(),
  version: z.number().int(), external_ref: z.string().nullable(),
  history: z.array(z.object({ action: z.string(), actor: z.string(), at: z.string() })),
}).openapi("Reservation");

export const ReceiptResponseSchema = z.object({ receipt: ReceiptSchema }).openapi("ReceiptResponse");
export const CancelBodySchema = z.object({ reason: z.string().min(1).max(500), expected_version: z.number().int().min(1).optional() }).openapi("CancelRequest");
export const ConfirmBodySchema = z.object({ confirm_token: z.string().min(1).max(200).optional(), expected_version: z.number().int().min(1).optional() }).openapi("ConfirmRequest");
export const MintBodySchema = z.object({ expected_version: z.number().int().min(1).optional() }).openapi("ConfirmTokenRequest");
export const MintResponseSchema = z.object({ confirm_token: z.string(), version: z.number().int() }).openapi("ConfirmTokenResponse");

import { z } from "@hono/zod-openapi";
import { CAPABILITIES } from "./auth.js";
import type { KeyView } from "./keys.js";
import { BOUNDS, type BlackoutView, type ComboView, type ForceOption, type Receipt, type ScheduleView, type UnitView } from "@dastar/db";

export const ProblemSchema = z.object({
  type: z.string(), title: z.string(), status: z.number().int(), code: z.string(),
  detail: z.string().optional(), trace_id: z.string(),
  replayed: z.boolean().optional().openapi({ description: "On a hold's refusal: true when it is the stored outcome of an earlier request with the same idempotency key." }),
  stranded: z.array(z.string()).optional().openapi({ description: "On a refused admin change: the ids of the live reservations it would strand, or, with force, of those that block it." }),
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
  party_size: z.number().int().min(1).max(10_000),
  starts_at: z.iso.datetime({ offset: true }),
  duration_minutes: z.number().int().min(1).max(100_000),
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
export const CancelBodySchema = z.object({ reason: z.string().min(1).max(500), expected_version: z.number().int().min(1).max(2_147_483_647).optional() }).openapi("CancelRequest");
export const ConfirmBodySchema = z.object({ confirm_token: z.string().min(1).max(200).optional(), expected_version: z.number().int().min(1).max(2_147_483_647).optional() }).openapi("ConfirmRequest");
export const MintBodySchema = z.object({ expected_version: z.number().int().min(1).max(2_147_483_647).optional() }).openapi("ConfirmTokenRequest");
export const StatusChangeBodySchema = z.object({ expected_version: z.number().int().min(1).max(2_147_483_647).optional() }).openapi("StatusChangeRequest");
export const MintResponseSchema = z.object({ confirm_token: z.string(), version: z.number().int() }).openapi("ConfirmTokenResponse");

export const HoldListSchema = z.object({
  holds: z.array(z.object({
    id: z.string(), party_size: z.number().int(), during: z.string(), assignment: z.object({ kind: z.string(), id: z.string() }),
    hold_expires_at: z.string(), version: z.number().int(), external_ref: z.string().nullable(),
  })),
}).openapi("HoldList");

export const AvailabilityBodySchema = z.object({
  party_size: z.number().int().min(1).max(10_000),
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  limit: z.number().int().min(1).max(BOUNDS.availabilityResults.max).optional(),
}).refine((b) => Date.parse(b.from) < Date.parse(b.to), { message: "from must be before to", path: ["to"] }).openapi("AvailabilityRequest");

export const AvailabilityResponseSchema = z.object({
  slots: z.array(z.object({
    starts_at: z.string(), duration_minutes: z.number().int(),
    assignment: z.object({ kind: z.enum(["unit", "combo"]), id: z.string() }),
  })),
  truncated: z.boolean(),
}).openapi("Availability");

const pathGuid = (name: string) => z.guid().openapi({ param: { name, in: "path" } });
export const UnitParams = z.object({ id: pathGuid("id"), unitId: pathGuid("unitId") });
export const ComboParams = z.object({ id: pathGuid("id"), comboId: pathGuid("comboId") });
export const ScheduleParams = z.object({ id: pathGuid("id"), scheduleId: pathGuid("scheduleId") });
export const BlackoutParams = z.object({ id: pathGuid("id"), blackoutId: pathGuid("blackoutId") });
export const KeyParams = z.object({ id: pathGuid("id"), keyId: pathGuid("keyId") });

/** The fields of a write that can strand live reservations: cancel them, with this reason, instead of refusing. */
const forceFields = { force: z.boolean().optional(), cancel_reason: z.string().min(1).max(200).optional() };
export function toForce(b: { force?: boolean | undefined; cancel_reason?: string | undefined }): ForceOption {
  return { ...(b.force !== undefined ? { force: b.force } : {}), ...(b.cancel_reason !== undefined ? { cancelReason: b.cancel_reason } : {}) };
}

const label = z.string().min(1).max(100);
const capacity = z.number().int().min(1).max(10_000);
const layout = z.record(z.string(), z.unknown());
const capacityOrder = { message: "capacity_max must be at least capacity_min", path: ["capacity_max"] };
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;
const opens = z.string().regex(TIME_OF_DAY);
const closes = z.string().regex(TIME_OF_DAY);
const dayOfWeek = z.number().int().min(1).max(7);
const durationBySize = z.record(z.string().regex(/^[1-9]\d{0,2}$/), z.number().int().min(5).max(720))
  .refine((d) => Object.keys(d).length > 0, { message: "at least one party size is required" });
const gapMinutes = z.number().int().min(0).max(720);

export const CreateUnitSchema = z.object({ label, capacity_min: capacity, capacity_max: capacity, layout: layout.optional() })
  .refine((b) => b.capacity_max >= b.capacity_min, capacityOrder).openapi("CreateUnitRequest");
export const UpdateUnitSchema = z.object({
  label: label.optional(), capacity_min: capacity.optional(), capacity_max: capacity.optional(), layout: layout.optional(),
  active: z.boolean().optional(), ...forceFields,
}).refine((b) => b.capacity_min === undefined || b.capacity_max === undefined || b.capacity_max >= b.capacity_min, capacityOrder).openapi("UpdateUnitRequest");

export const CreateComboSchema = z.object({ label, unit_ids: z.array(z.guid()).min(2).max(6), capacity_min: capacity, capacity_max: capacity })
  .refine((b) => b.capacity_max >= b.capacity_min, capacityOrder).openapi("CreateComboRequest");
export const UpdateComboSchema = z.object({ label: label.optional(), active: z.boolean().optional(), ...forceFields }).openapi("UpdateComboRequest");

export const CreateScheduleSchema = z.object({
  day_of_week: dayOfWeek, opens, closes, duration_by_size: durationBySize, gap_minutes: gapMinutes.default(0), active: z.boolean().default(true),
}).openapi("CreateScheduleRequest");
export const UpdateScheduleSchema = z.object({
  day_of_week: dayOfWeek.optional(), opens: opens.optional(), closes: closes.optional(), duration_by_size: durationBySize.optional(),
  gap_minutes: gapMinutes.optional(), active: z.boolean().optional(),
}).openapi("UpdateScheduleRequest");

export const CreateBlackoutSchema = z.object({
  starts_at: z.iso.datetime({ offset: true }), ends_at: z.iso.datetime({ offset: true }), reason: z.string().min(1).max(500),
  active: z.boolean().optional(), ...forceFields,
}).refine((b) => Date.parse(b.starts_at) < Date.parse(b.ends_at), { message: "starts_at must be before ends_at", path: ["ends_at"] }).openapi("CreateBlackoutRequest");
export const UpdateBlackoutSchema = z.object({ reason: z.string().min(1).max(500).optional(), active: z.boolean().optional(), ...forceFields }).openapi("UpdateBlackoutRequest");
export const BlackoutListQuery = z.object({
  from: z.iso.datetime({ offset: true }).openapi({ param: { name: "from", in: "query" } }),
  to: z.iso.datetime({ offset: true }).openapi({ param: { name: "to", in: "query" } }),
}).refine((q) => Date.parse(q.from) < Date.parse(q.to), { message: "from must be before to", path: ["to"] });

export const UnitSchema = z.object({ id: z.string(), label: z.string(), capacity_min: z.number().int(), capacity_max: z.number().int(), active: z.boolean(), layout: z.record(z.string(), z.unknown()) }).openapi("Unit");
export const ComboSchema = z.object({ id: z.string(), label: z.string(), unit_ids: z.array(z.string()), capacity_min: z.number().int(), capacity_max: z.number().int(), active: z.boolean() }).openapi("Combo");
export const ScheduleSchema = z.object({
  id: z.string(), day_of_week: z.number().int(), opens: z.string(), closes: z.string(), closes_next_day: z.boolean(),
  duration_by_size: z.record(z.string(), z.number().int()), gap_minutes: z.number().int(), active: z.boolean(),
}).openapi("Schedule");
export const BlackoutSchema = z.object({ id: z.string(), starts_at: z.string(), ends_at: z.string(), reason: z.string(), active: z.boolean() }).openapi("Blackout");

export const CreateKeySchema = z.object({
  label,
  capabilities: z.array(z.enum(CAPABILITIES)).min(1).max(CAPABILITIES.length)
    .refine((c) => new Set(c).size === c.length, { message: "capabilities must be distinct" }),
}).openapi("CreateKeyRequest");
export const KeySchema = z.object({
  id: z.string(), label: z.string(), capabilities: z.array(z.string()), venue_ids: z.array(z.string()), created_at: z.string(), revoked_at: z.string().nullable(),
}).openapi("Key");

export const UnitListSchema = z.object({ units: z.array(UnitSchema) }).openapi("UnitList");
export const UnitResponseSchema = z.object({ unit: UnitSchema }).openapi("UnitResponse");
export const UnitChangeSchema = z.object({ unit: UnitSchema, cancelled: z.array(z.string()) }).openapi("UnitChange");
export const ComboListSchema = z.object({ combos: z.array(ComboSchema) }).openapi("ComboList");
export const ComboResponseSchema = z.object({ combo: ComboSchema }).openapi("ComboResponse");
export const ComboChangeSchema = z.object({ combo: ComboSchema, cancelled: z.array(z.string()) }).openapi("ComboChange");
export const ScheduleListSchema = z.object({ schedules: z.array(ScheduleSchema) }).openapi("ScheduleList");
export const ScheduleResponseSchema = z.object({ schedule: ScheduleSchema }).openapi("ScheduleResponse");
export const BlackoutListSchema = z.object({ blackouts: z.array(BlackoutSchema) }).openapi("BlackoutList");
export const KeyListSchema = z.object({ keys: z.array(KeySchema) }).openapi("KeyList");
export const KeyResponseSchema = z.object({ key: KeySchema }).openapi("KeyResponse");
export const KeyCreatedSchema = z.object({
  key: KeySchema,
  secret: z.string().openapi({ description: "The key to present as a bearer credential. Shown once, in this response only; the service keeps its hash and cannot show it again." }),
}).openapi("KeyCreated");
export const BlackoutChangeSchema = z.object({ blackout: BlackoutSchema, cancelled: z.array(z.string()) }).openapi("BlackoutChange");

export const toUnit = (u: UnitView): z.infer<typeof UnitSchema> =>
  ({ id: u.id, label: u.label, capacity_min: u.capacityMin, capacity_max: u.capacityMax, active: u.active, layout: u.layout });
export const toCombo = (c: ComboView): z.infer<typeof ComboSchema> =>
  ({ id: c.id, label: c.label, unit_ids: c.unitIds, capacity_min: c.capacityMin, capacity_max: c.capacityMax, active: c.active });
export const toSchedule = (s: ScheduleView): z.infer<typeof ScheduleSchema> => ({
  id: s.id, day_of_week: s.dayOfWeek, opens: s.opens, closes: s.closes, closes_next_day: s.closesNextDay,
  duration_by_size: s.durationBySize, gap_minutes: s.gapMinutes, active: s.active,
});
export const toBlackout = (b: BlackoutView): z.infer<typeof BlackoutSchema> =>
  ({ id: b.id, starts_at: b.startsAt, ends_at: b.endsAt, reason: b.reason, active: b.active });
export const toKey = (k: KeyView): z.infer<typeof KeySchema> =>
  ({ id: k.id, label: k.label, capabilities: k.capabilities, venue_ids: k.venueIds, created_at: k.createdAt, revoked_at: k.revokedAt });

import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { Deps, Env } from "../env.js";
import { requireCapability, requireKey, assertVenueInScope } from "../auth.js";
import { problemFor } from "../problem.js";
import {
  BlackoutChangeSchema, BlackoutListQuery, BlackoutListSchema, BlackoutParams, CreateBlackoutSchema, CreateScheduleSchema, IdParam,
  ScheduleListSchema, ScheduleParams, ScheduleResponseSchema, UpdateBlackoutSchema, UpdateScheduleSchema,
  problemResponses, toBlackout, toForce, toSchedule,
} from "../schemas.js";

export function register(app: OpenAPIHono<Env>, deps: Deps): void {
  const json = <S>(schema: S) => ({ "application/json": { schema } });
  /** Every route: a key with admin, a venue inside its scope, and the actor it is recorded as. */
  const context = (key: { id: string }, venueId: string, traceId: string) => ({ venueId, actor: `key:${key.id}`, traceId });

  const listSchedules = createRoute({
    method: "get", path: "/admin/venues/{id}/schedules",
    summary: "List the venue's service periods, inactive ones included, by day of week and opening time. Times are HH:MM in the venue's time zone. Requires the admin capability; a venue outside the key's venues answers 404.",
    security: [{ Bearer: [] }], middleware: [requireCapability(deps, "admin")] as const,
    request: { params: IdParam },
    responses: { 200: { description: "The venue's service periods", content: json(ScheduleListSchema) }, ...problemResponses },
  });
  app.openapi(listSchedules, async (c) => {
    const key = requireKey(c);
    const venueId = c.req.valid("param").id.toLowerCase();
    assertVenueInScope(key, venueId);
    const schedules = await deps.dastar.admin.listSchedules(venueId);
    return c.json({ schedules: schedules.map(toSchedule) }, 200);
  });

  const createSchedule = createRoute({
    method: "post", path: "/admin/venues/{id}/schedules",
    summary: "Create a service period on an ISO weekday (1 Monday to 7 Sunday) from opens to closes, with the booking duration for each party size. closes_next_day is computed: a period closes the next day when closes is at or before opens. A shape the database refuses is 422 invalid_input.",
    security: [{ Bearer: [] }], middleware: [requireCapability(deps, "admin")] as const,
    request: { params: IdParam, body: { required: true, content: json(CreateScheduleSchema) } },
    responses: { 201: { description: "The service period", content: json(ScheduleResponseSchema) }, ...problemResponses },
  });
  app.openapi(createSchedule, async (c) => {
    const key = requireKey(c);
    const venueId = c.req.valid("param").id.toLowerCase();
    assertVenueInScope(key, venueId);
    const body = c.req.valid("json");
    const schedule = await deps.dastar.admin.createSchedule(context(key, venueId, c.get("traceId")), {
      dayOfWeek: body.day_of_week, opens: body.opens, closes: body.closes, durationBySize: body.duration_by_size,
      gapMinutes: body.gap_minutes, active: body.active,
    });
    return c.json({ schedule: toSchedule(schedule) }, 201);
  });

  const updateSchedule = createRoute({
    method: "patch", path: "/admin/venues/{id}/schedules/{scheduleId}",
    summary: "Change a service period; a field left out keeps its value, and closes_next_day is recomputed from the final times. A service period strands no reservation, so there is no force. A period of another venue answers 404.",
    security: [{ Bearer: [] }], middleware: [requireCapability(deps, "admin")] as const,
    request: { params: ScheduleParams, body: { required: true, content: json(UpdateScheduleSchema) } },
    responses: { 200: { description: "The service period", content: json(ScheduleResponseSchema) }, ...problemResponses },
  });
  app.openapi(updateSchedule, async (c) => {
    const key = requireKey(c);
    const params = c.req.valid("param");
    const venueId = params.id.toLowerCase();
    assertVenueInScope(key, venueId);
    const body = c.req.valid("json");
    const schedule = await deps.dastar.admin.updateSchedule(context(key, venueId, c.get("traceId")), {
      scheduleId: params.scheduleId.toLowerCase(),
      ...(body.day_of_week !== undefined ? { dayOfWeek: body.day_of_week } : {}),
      ...(body.opens !== undefined ? { opens: body.opens } : {}),
      ...(body.closes !== undefined ? { closes: body.closes } : {}),
      ...(body.duration_by_size !== undefined ? { durationBySize: body.duration_by_size } : {}),
      ...(body.gap_minutes !== undefined ? { gapMinutes: body.gap_minutes } : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
    });
    return c.json({ schedule: toSchedule(schedule) }, 200);
  });

  const listBlackouts = createRoute({
    method: "get", path: "/admin/venues/{id}/blackouts",
    summary: "List the venue's blackouts overlapping [from, to), inactive ones included, by start: a window of at most 400 days and at most 500 rows. from must be before to (400 validation); a window over 400 days is 422 invalid_input.",
    security: [{ Bearer: [] }], middleware: [requireCapability(deps, "admin")] as const,
    request: { params: IdParam, query: BlackoutListQuery },
    responses: { 200: { description: "The blackouts overlapping the window", content: json(BlackoutListSchema) }, ...problemResponses },
  });
  app.openapi(listBlackouts, async (c) => {
    const key = requireKey(c);
    const venueId = c.req.valid("param").id.toLowerCase();
    assertVenueInScope(key, venueId);
    const q = c.req.valid("query");
    const blackouts = await deps.dastar.admin.listBlackouts(venueId, { from: q.from, to: q.to });
    return c.json({ blackouts: blackouts.map(toBlackout) }, 200);
  });

  const createBlackout = createRoute({
    method: "post", path: "/admin/venues/{id}/blackouts",
    summary: "Create a blackout over [starts_at, ends_at), active unless active is false. An active blackout over live reservations answers 409 blackout_conflict with their ids in `stranded` and writes nothing. With force the reservations are cancelled in the same transaction, with cancel_reason (default \"venue change\") and an outbox event each, and returned in `cancelled`; force answers 409 reservation_in_progress when one has started and 422 force_too_large above 200. An inactive blackout is created without judgment.",
    security: [{ Bearer: [] }], middleware: [requireCapability(deps, "admin")] as const,
    request: { params: IdParam, body: { required: true, content: json(CreateBlackoutSchema) } },
    responses: { 201: { description: "The blackout and the ids of the reservations cancelled by force", content: json(BlackoutChangeSchema) }, ...problemResponses },
  });
  app.openapi(createBlackout, async (c) => {
    const key = requireKey(c);
    const venueId = c.req.valid("param").id.toLowerCase();
    assertVenueInScope(key, venueId);
    const body = c.req.valid("json");
    const out = await deps.dastar.admin.createBlackout(context(key, venueId, c.get("traceId")), {
      startsAt: body.starts_at, endsAt: body.ends_at, reason: body.reason,
      ...(body.active !== undefined ? { active: body.active } : {}),
      ...toForce(body),
    });
    if (!out.ok) throw problemFor(out.error.code, out.error.message, { stranded: out.stranded });
    return c.json({ blackout: toBlackout(out.value), cancelled: out.cancelled }, 201);
  });

  const updateBlackout = createRoute({
    method: "patch", path: "/admin/venues/{id}/blackouts/{blackoutId}",
    summary: "Change a blackout's reason or activity; its range is fixed. Activating an inactive blackout is judged like creating an active one (409 blackout_conflict, or force with the same refusals); a change of reason and a deactivation strand nothing. A blackout of another venue answers 404.",
    security: [{ Bearer: [] }], middleware: [requireCapability(deps, "admin")] as const,
    request: { params: BlackoutParams, body: { required: true, content: json(UpdateBlackoutSchema) } },
    responses: { 200: { description: "The blackout and the ids of the reservations cancelled by force", content: json(BlackoutChangeSchema) }, ...problemResponses },
  });
  app.openapi(updateBlackout, async (c) => {
    const key = requireKey(c);
    const params = c.req.valid("param");
    const venueId = params.id.toLowerCase();
    assertVenueInScope(key, venueId);
    const body = c.req.valid("json");
    const out = await deps.dastar.admin.updateBlackout(context(key, venueId, c.get("traceId")), {
      blackoutId: params.blackoutId.toLowerCase(),
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
      ...toForce(body),
    });
    if (!out.ok) throw problemFor(out.error.code, out.error.message, { stranded: out.stranded });
    return c.json({ blackout: toBlackout(out.value), cancelled: out.cancelled }, 200);
  });
}

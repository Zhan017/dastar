import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { Deps, Env } from "../env.js";
import { requireCapability, requireKey, assertVenueInScope } from "../auth.js";
import { problemFor } from "../problem.js";
import {
  ComboChangeSchema, ComboListSchema, ComboParams, ComboResponseSchema, CreateComboSchema, CreateUnitSchema, IdParam,
  UnitChangeSchema, UnitListSchema, UnitParams, UnitResponseSchema, UpdateComboSchema, UpdateUnitSchema,
  problemResponses, toCombo, toForce, toUnit,
} from "../schemas.js";

const REFUSALS = "A write that would strand live reservations answers 409 (capacity_conflict, assignment_in_use) with their ids in `stranded` and writes nothing. With force the reservations are cancelled in the same transaction, with cancel_reason (default \"venue change\") and an outbox event each, and returned in `cancelled`; force answers 409 reservation_in_progress when one has started and 422 force_too_large above 200.";

export function register(app: OpenAPIHono<Env>, deps: Deps): void {
  const json = <S>(schema: S) => ({ "application/json": { schema } });
  /** Every route: a key with admin, a venue inside its scope, and the actor it is recorded as. */
  const context = (key: { id: string }, venueId: string, traceId: string) => ({ venueId, actor: `key:${key.id}`, traceId });

  const listUnits = createRoute({
    method: "get", path: "/admin/venues/{id}/units",
    summary: "List the venue's units, inactive ones included, in label order. Requires the admin capability; a venue outside the key's venues answers 404.",
    security: [{ Bearer: [] }], middleware: [requireCapability(deps, "admin")] as const,
    request: { params: IdParam },
    responses: { 200: { description: "The venue's units", content: json(UnitListSchema) }, ...problemResponses },
  });
  app.openapi(listUnits, async (c) => {
    const key = requireKey(c);
    const venueId = c.req.valid("param").id.toLowerCase();
    assertVenueInScope(key, venueId);
    const units = await deps.dastar.admin.listUnits(venueId);
    return c.json({ units: units.map(toUnit) }, 200);
  });

  const createUnit = createRoute({
    method: "post", path: "/admin/venues/{id}/units",
    summary: "Create a unit with a capacity range and an optional layout. capacity_max below capacity_min is 400 validation; a range the database refuses is 422 invalid_input.",
    security: [{ Bearer: [] }], middleware: [requireCapability(deps, "admin")] as const,
    request: { params: IdParam, body: { required: true, content: json(CreateUnitSchema) } },
    responses: { 201: { description: "The unit", content: json(UnitResponseSchema) }, ...problemResponses },
  });
  app.openapi(createUnit, async (c) => {
    const key = requireKey(c);
    const venueId = c.req.valid("param").id.toLowerCase();
    assertVenueInScope(key, venueId);
    const body = c.req.valid("json");
    const unit = await deps.dastar.admin.createUnit(context(key, venueId, c.get("traceId")), {
      label: body.label, capacityMin: body.capacity_min, capacityMax: body.capacity_max,
      ...(body.layout !== undefined ? { layout: body.layout } : {}),
    });
    return c.json({ unit: toUnit(unit) }, 201);
  });

  const updateUnit = createRoute({
    method: "patch", path: "/admin/venues/{id}/units/{unitId}",
    summary: `Change a unit's label, capacity range, layout, or activity; a field left out keeps its value. A narrower capacity range strands the live reservations assigned directly to the unit whose party falls outside it, and a deactivation strands every live reservation using the unit, including those of combinations that contain it. ${REFUSALS} A unit of another venue answers 404.`,
    security: [{ Bearer: [] }], middleware: [requireCapability(deps, "admin")] as const,
    request: { params: UnitParams, body: { required: true, content: json(UpdateUnitSchema) } },
    responses: { 200: { description: "The unit and the ids of the reservations cancelled by force", content: json(UnitChangeSchema) }, ...problemResponses },
  });
  app.openapi(updateUnit, async (c) => {
    const key = requireKey(c);
    const params = c.req.valid("param");
    const venueId = params.id.toLowerCase();
    assertVenueInScope(key, venueId);
    const body = c.req.valid("json");
    const out = await deps.dastar.admin.updateUnit(context(key, venueId, c.get("traceId")), {
      unitId: params.unitId.toLowerCase(),
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...(body.capacity_min !== undefined ? { capacityMin: body.capacity_min } : {}),
      ...(body.capacity_max !== undefined ? { capacityMax: body.capacity_max } : {}),
      ...(body.layout !== undefined ? { layout: body.layout } : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
      ...toForce(body),
    });
    if (!out.ok) throw problemFor(out.error.code, out.error.message, { stranded: out.stranded });
    return c.json({ unit: toUnit(out.value), cancelled: out.cancelled }, 200);
  });

  const listCombos = createRoute({
    method: "get", path: "/admin/venues/{id}/combos",
    summary: "List the venue's combinations, inactive ones included, in label order. Requires the admin capability; a venue outside the key's venues answers 404.",
    security: [{ Bearer: [] }], middleware: [requireCapability(deps, "admin")] as const,
    request: { params: IdParam },
    responses: { 200: { description: "The venue's combinations", content: json(ComboListSchema) }, ...problemResponses },
  });
  app.openapi(listCombos, async (c) => {
    const key = requireKey(c);
    const venueId = c.req.valid("param").id.toLowerCase();
    assertVenueInScope(key, venueId);
    const combos = await deps.dastar.admin.listCombos(venueId);
    return c.json({ combos: combos.map(toCombo) }, 200);
  });

  const createCombo = createRoute({
    method: "post", path: "/admin/venues/{id}/combos",
    summary: "Create a combination of 2 to 6 distinct units of the venue with a capacity range of its own. Members that repeat, do not exist, or belong to another venue are 422 assignment_mismatch. Members and capacities cannot be changed afterwards.",
    security: [{ Bearer: [] }], middleware: [requireCapability(deps, "admin")] as const,
    request: { params: IdParam, body: { required: true, content: json(CreateComboSchema) } },
    responses: { 201: { description: "The combination", content: json(ComboResponseSchema) }, ...problemResponses },
  });
  app.openapi(createCombo, async (c) => {
    const key = requireKey(c);
    const venueId = c.req.valid("param").id.toLowerCase();
    assertVenueInScope(key, venueId);
    const body = c.req.valid("json");
    const combo = await deps.dastar.admin.createCombo(context(key, venueId, c.get("traceId")), {
      label: body.label, unitIds: body.unit_ids.map((id) => id.toLowerCase()), capacityMin: body.capacity_min, capacityMax: body.capacity_max,
    });
    return c.json({ combo: toCombo(combo) }, 201);
  });

  const updateCombo = createRoute({
    method: "patch", path: "/admin/venues/{id}/combos/{comboId}",
    summary: `Change a combination's label or activity. A deactivation strands the live reservations assigned to the combination. ${REFUSALS} A combination of another venue answers 404.`,
    security: [{ Bearer: [] }], middleware: [requireCapability(deps, "admin")] as const,
    request: { params: ComboParams, body: { required: true, content: json(UpdateComboSchema) } },
    responses: { 200: { description: "The combination and the ids of the reservations cancelled by force", content: json(ComboChangeSchema) }, ...problemResponses },
  });
  app.openapi(updateCombo, async (c) => {
    const key = requireKey(c);
    const params = c.req.valid("param");
    const venueId = params.id.toLowerCase();
    assertVenueInScope(key, venueId);
    const body = c.req.valid("json");
    const out = await deps.dastar.admin.updateCombo(context(key, venueId, c.get("traceId")), {
      comboId: params.comboId.toLowerCase(),
      ...(body.label !== undefined ? { label: body.label } : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
      ...toForce(body),
    });
    if (!out.ok) throw problemFor(out.error.code, out.error.message, { stranded: out.stranded });
    return c.json({ combo: toCombo(out.value), cancelled: out.cancelled }, 200);
  });
}

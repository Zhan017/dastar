import type { ClientBase, QueryResultRow } from "pg";
import { BOUNDS } from "@dastar/core";
import { DastarError } from "../errors.js";
import { sortUnitIds } from "../units.js";
import {
  adminRead, adminTx, adminWrite, jsonText, settleStranded, STRANDED_COLUMNS, STRANDED_TAIL, LIVE,
  type AdminContext, type AdminOutcome, type ForceOption, type Stranded,
} from "./admin.js";

export type UnitView = { id: string; label: string; capacityMin: number; capacityMax: number; active: boolean; layout: Record<string, unknown> };
export type ComboView = { id: string; label: string; unitIds: string[]; capacityMin: number; capacityMax: number; active: boolean };

export type CreateUnitInput = { label: string; capacityMin: number; capacityMax: number; layout?: Record<string, unknown> };
export type UpdateUnitInput = {
  unitId: string; label?: string; capacityMin?: number; capacityMax?: number; layout?: Record<string, unknown>; active?: boolean;
} & ForceOption;
export type CreateComboInput = { label: string; unitIds: string[]; capacityMin: number; capacityMax: number };
export type UpdateComboInput = { comboId: string; label?: string; active?: boolean } & ForceOption;

const UNIT_COLUMNS = "id, label, capacity_min, capacity_max, active, layout";
const COMBO_COLUMNS = "id, label, unit_ids, capacity_min, capacity_max, active";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const unitView = (r: QueryResultRow): UnitView => ({
  id: r.id, label: r.label, capacityMin: r.capacity_min, capacityMax: r.capacity_max, active: r.active, layout: r.layout,
});
const comboView = (r: QueryResultRow): ComboView => ({
  id: r.id, label: r.label, unitIds: r.unit_ids, capacityMin: r.capacity_min, capacityMax: r.capacity_max, active: r.active,
});
const strandedOf = (rows: QueryResultRow[]): Stranded[] => rows.map((r) => ({ id: r.id as string, started: r.started === true }));

/** The venue's units, inactive ones included, in label order. */
export function listUnits(client: ClientBase, venueId: string): Promise<UnitView[]> {
  return adminRead(client, venueId, async () => {
    const r = await client.query(`select ${UNIT_COLUMNS} from dastar.unit where venue_id = $1 order by label, id`, [venueId]);
    return r.rows.map(unitView);
  });
}

/** The venue's combinations, inactive ones included, in label order. */
export function listCombos(client: ClientBase, venueId: string): Promise<ComboView[]> {
  return adminRead(client, venueId, async () => {
    const r = await client.query(`select ${COMBO_COLUMNS} from dastar.unit_combo where venue_id = $1 order by label, id`, [venueId]);
    return r.rows.map(comboView);
  });
}

/**
 * A CHECK violation (capacity order, capacity below 1) surfaces as `invalid_input`, and so does a layout that is not a
 * JSON object or that Postgres cannot store (see jsonText).
 */
export async function createUnit(client: ClientBase, ctx: AdminContext, input: CreateUnitInput): Promise<UnitView> {
  const layout = input.layout === undefined ? "{}" : jsonText("layout", input.layout);
  return adminTx(client, ctx, async () => {
    const r = await client.query(
      `insert into dastar.unit (venue_id, label, capacity_min, capacity_max, layout) values ($1, $2, $3, $4, $5::jsonb) returning ${UNIT_COLUMNS}`,
      [ctx.venueId, input.label, input.capacityMin, input.capacityMax, layout],
    );
    return unitView(r.rows[0]);
  });
}

/**
 * A change that strands live reservations is refused unless forced (see settleStranded). A narrower capacity range
 * strands the reservations assigned directly to the unit whose party falls outside it (the capacity guard's set; a
 * combination's capacities are its own); a deactivation strands every live reservation with an active unit row on the
 * unit, which includes those of combinations containing it. Both sets are read in one query, earliest start first.
 * A layout is written only when the input has one, so a change of anything else keeps the stored jsonb as it is.
 */
export async function updateUnit(client: ClientBase, ctx: AdminContext, input: UpdateUnitInput): Promise<AdminOutcome<UnitView>> {
  const layout = input.layout === undefined ? null : jsonText("layout", input.layout);
  return adminWrite(client, ctx, async () => {
    const found = await client.query(`select ${UNIT_COLUMNS} from dastar.unit where id = $1 and venue_id = $2`, [input.unitId, ctx.venueId]);
    if (found.rowCount === 0) throw new DastarError("not_found", "unit not found");
    const cur = unitView(found.rows[0]);
    const next = {
      label: input.label ?? cur.label, capacityMin: input.capacityMin ?? cur.capacityMin, capacityMax: input.capacityMax ?? cur.capacityMax,
      active: input.active ?? cur.active,
    };
    if (next.capacityMin < 1 || next.capacityMax < next.capacityMin) {
      throw new DastarError("invalid_input", "capacity_min must be at least 1 and capacity_max at least capacity_min");
    }
    const capacityChanged = next.capacityMin !== cur.capacityMin || next.capacityMax !== cur.capacityMax;
    const deactivating = cur.active && !next.active;

    const params: unknown[] = [ctx.venueId, input.unitId];
    const sets: string[] = [];
    if (capacityChanged) {
      params.push(next.capacityMin, next.capacityMax);
      sets.push("(r.assignment_kind = 'unit' and r.assignment_id = $2 and (r.party_size < $3 or r.party_size > $4))");
    }
    if (deactivating) {
      sets.push("exists (select 1 from dastar.reservation_unit ru where ru.reservation_id = r.id and ru.unit_id = $2 and ru.active)");
    }
    const stranded = sets.length === 0 ? [] : strandedOf((await client.query(
      `select ${STRANDED_COLUMNS} from dastar.reservation r where r.venue_id = $1 and ${LIVE} and (${sets.join(" or ")}) ${STRANDED_TAIL}`,
      params,
    )).rows);
    const settled = await settleStranded(client, ctx, stranded, deactivating ? "assignment_in_use" : "capacity_conflict", `this change to unit ${cur.label}`, input);
    if (!settled.ok) return settled;

    const upd = await client.query(
      `update dastar.unit set label = $3, capacity_min = $4, capacity_max = $5, layout = coalesce($6::jsonb, layout), active = $7
        where id = $1 and venue_id = $2 returning ${UNIT_COLUMNS}`,
      [input.unitId, ctx.venueId, next.label, next.capacityMin, next.capacityMax, layout, next.active],
    );
    return { ok: true, value: unitView(upd.rows[0]), cancelled: settled.cancelled };
  });
}

/**
 * The members are distinct units of the venue, BOUNDS.comboUnits of them; anything else is `assignment_mismatch`. They
 * are stored in sorted order, the order their locks are taken in.
 */
export function createCombo(client: ClientBase, ctx: AdminContext, input: CreateComboInput): Promise<ComboView> {
  return adminTx(client, ctx, async () => {
    const ids = input.unitIds.map((id) => id.toLowerCase());
    const mismatch = (): DastarError =>
      new DastarError("assignment_mismatch", `a combination has ${BOUNDS.comboUnits.min} to ${BOUNDS.comboUnits.max} distinct units of its venue`);
    if (ids.length < BOUNDS.comboUnits.min || ids.length > BOUNDS.comboUnits.max || new Set(ids).size !== ids.length || !ids.every((id) => UUID.test(id))) {
      throw mismatch();
    }
    const members = await client.query("select count(*)::int as n from dastar.unit where venue_id = $1 and id = any ($2::uuid[])", [ctx.venueId, ids]);
    if (members.rows[0].n !== ids.length) throw mismatch();
    const r = await client.query(
      `insert into dastar.unit_combo (venue_id, label, unit_ids, capacity_min, capacity_max) values ($1, $2, $3::uuid[], $4, $5) returning ${COMBO_COLUMNS}`,
      [ctx.venueId, input.label, sortUnitIds(ids), input.capacityMin, input.capacityMax],
    );
    return comboView(r.rows[0]);
  });
}

/** Members and capacities are immutable. A deactivation strands the live reservations assigned to the combination. */
export function updateCombo(client: ClientBase, ctx: AdminContext, input: UpdateComboInput): Promise<AdminOutcome<ComboView>> {
  return adminWrite(client, ctx, async () => {
    const found = await client.query(`select ${COMBO_COLUMNS} from dastar.unit_combo where id = $1 and venue_id = $2`, [input.comboId, ctx.venueId]);
    if (found.rowCount === 0) throw new DastarError("not_found", "combination not found");
    const cur = comboView(found.rows[0]);
    const next = { label: input.label ?? cur.label, active: input.active ?? cur.active };
    const deactivating = cur.active && !next.active;
    const stranded = !deactivating ? [] : strandedOf((await client.query(
      `select ${STRANDED_COLUMNS} from dastar.reservation r
        where r.venue_id = $1 and r.assignment_kind = 'combo' and r.assignment_id = $2 and ${LIVE} ${STRANDED_TAIL}`,
      [ctx.venueId, input.comboId],
    )).rows);
    const settled = await settleStranded(client, ctx, stranded, "assignment_in_use", `this change to combination ${cur.label}`, input);
    if (!settled.ok) return settled;

    const upd = await client.query(
      `update dastar.unit_combo set label = $3, active = $4 where id = $1 and venue_id = $2 returning ${COMBO_COLUMNS}`,
      [input.comboId, ctx.venueId, next.label, next.active],
    );
    return { ok: true, value: comboView(upd.rows[0]), cancelled: settled.cancelled };
  });
}

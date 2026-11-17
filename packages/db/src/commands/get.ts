import type { ClientBase } from "pg";
import { asDastarError } from "../errors.js";
import { bindVenue } from "../context.js";

export type ReservationView = {
  id: string; venueId: string; status: string; storedStatus: string; partySize: number; during: string;
  assignment: { kind: string; id: string }; holdExpiresAt: string; version: number; externalRef: string | null;
  history: { action: string; actor: string; at: string }[];
};

export type GetInput = { reservationId: string; venueId: string };
export type GetHooks = { afterRow?: () => Promise<void> };

/**
 * One snapshot for both reads (repeatable read), so the history never runs ahead of the row. A reservation of
 * another venue reads as absent.
 */
export async function getReservation(client: ClientBase, input: GetInput, hooks: GetHooks = {}): Promise<ReservationView | null> {
  const { reservationId, venueId } = input;
  await client.query("begin isolation level repeatable read read only");
  try {
    await bindVenue(client, venueId);
    const r = await client.query(
      `select id, venue_id, status as stored_status, dastar.effective_status(status, hold_expires_at) as status,
              party_size, during, assignment_kind, assignment_id, hold_expires_at, version, external_ref
         from dastar.reservation where id = $1 and venue_id = $2`,
      [reservationId, venueId],
    );
    await hooks.afterRow?.();
    let view: ReservationView | null = null;
    if (r.rowCount !== 0) {
      const row = r.rows[0];
      const h = await client.query("select action, actor, at from dastar.audit_log where entity_id = $1 and venue_id = $2 order by id", [reservationId, venueId]);
      view = {
        id: row.id, venueId: row.venue_id, status: row.status, storedStatus: row.stored_status, partySize: row.party_size,
        during: row.during, assignment: { kind: row.assignment_kind, id: row.assignment_id },
        holdExpiresAt: new Date(row.hold_expires_at).toISOString(), version: row.version, externalRef: row.external_ref,
        history: h.rows.map((x) => ({ action: x.action, actor: x.actor, at: new Date(x.at).toISOString() })),
      };
    }
    await client.query("commit");
    return view;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw asDastarError(e);
  }
}

export type CurrentStatusesInput = { venueId: string; reservationIds: string[] };

/** The effective status of each listed reservation of one venue: a hold past its expiry reads `expired` before the sweeper has stored it. */
export const CURRENT_STATUSES_SQL =
  "select id, dastar.effective_status(status, hold_expires_at) as status from dastar.reservation where venue_id = $1 and id = any ($2::uuid[])";

/** The rows of CURRENT_STATUSES_SQL as a record from reservation id to status. */
export function toStatusRecord(rows: { id: string; status: string }[]): Record<string, string> {
  return Object.fromEntries(rows.map((r) => [r.id, r.status]));
}

/**
 * The current status of each listed reservation in one venue, read in one snapshot. A reservation of another venue
 * and an id that names none are absent from the record.
 */
export async function currentStatuses(client: ClientBase, input: CurrentStatusesInput): Promise<Record<string, string>> {
  await client.query("begin isolation level repeatable read read only");
  try {
    await bindVenue(client, input.venueId);
    const r = await client.query(CURRENT_STATUSES_SQL, [input.venueId, input.reservationIds]);
    await client.query("commit");
    return toStatusRecord(r.rows);
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw asDastarError(e);
  }
}

/** The venue of a reservation, for a caller that holds only its id; null when there is none. The caller then declares that venue. */
export async function findReservationVenue(client: ClientBase, reservationId: string): Promise<string | null> {
  try {
    const r = await client.query("select dastar.reservation_venue($1) as venue_id", [reservationId]);
    return (r.rows[0].venue_id as string | null) ?? null;
  } catch (e) {
    throw asDastarError(e);
  }
}

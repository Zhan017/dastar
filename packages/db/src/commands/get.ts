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

/** The venue of a reservation, for a caller that holds only its id; null when there is none. The caller then declares that venue. */
export async function findReservationVenue(client: ClientBase, reservationId: string): Promise<string | null> {
  try {
    const r = await client.query("select dastar.reservation_venue($1) as venue_id", [reservationId]);
    return (r.rows[0].venue_id as string | null) ?? null;
  } catch (e) {
    throw asDastarError(e);
  }
}

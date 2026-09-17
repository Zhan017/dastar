import type { ClientBase } from "pg";
import { asDastarError } from "../errors.js";

export type ReservationView = {
  id: string; venueId: string; status: string; storedStatus: string; partySize: number; during: string;
  assignment: { kind: string; id: string }; holdExpiresAt: string; version: number; externalRef: string | null;
  history: { action: string; actor: string; at: string }[];
};

export type GetHooks = { afterRow?: () => Promise<void> };

/** One snapshot for both reads (repeatable read), so the history never runs ahead of the row. */
export async function getReservation(client: ClientBase, reservationId: string, hooks: GetHooks = {}): Promise<ReservationView | null> {
  await client.query("begin isolation level repeatable read read only");
  try {
    const r = await client.query(
      `select id, venue_id, status as stored_status, dastar.effective_status(status, hold_expires_at) as status,
              party_size, during, assignment_kind, assignment_id, hold_expires_at, version, external_ref
         from dastar.reservation where id = $1`,
      [reservationId],
    );
    await hooks.afterRow?.();
    let view: ReservationView | null = null;
    if (r.rowCount !== 0) {
      const row = r.rows[0];
      const h = await client.query("select action, actor, at from dastar.audit_log where entity_id = $1 order by id", [reservationId]);
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

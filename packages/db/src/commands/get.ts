import type { ClientBase } from "pg";

export type ReservationView = {
  id: string; venueId: string; status: string; storedStatus: string; partySize: number; during: string;
  assignment: { kind: string; id: string }; holdExpiresAt: string; version: number; externalRef: string | null;
  history: { action: string; actor: string; at: string }[];
};

export async function getReservation(client: ClientBase, reservationId: string): Promise<ReservationView | null> {
  const r = await client.query(
    `select id, venue_id, status as stored_status, dastar.effective_status(status, hold_expires_at) as status,
            party_size, during, assignment_kind, assignment_id, hold_expires_at, version, external_ref
       from dastar.reservation where id = $1`,
    [reservationId],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  const h = await client.query("select action, actor, at from dastar.audit_log where entity_id = $1 order by id", [reservationId]);
  return {
    id: row.id, venueId: row.venue_id, status: row.status, storedStatus: row.stored_status, partySize: row.party_size,
    during: row.during, assignment: { kind: row.assignment_kind, id: row.assignment_id },
    holdExpiresAt: new Date(row.hold_expires_at).toISOString(), version: row.version, externalRef: row.external_ref,
    history: h.rows.map((x) => ({ action: x.action, actor: x.actor, at: new Date(x.at).toISOString() })),
  };
}

import type { ClientBase } from "pg";

export async function enqueue(client: ClientBase, venueId: string, topic: string, payload: Record<string, unknown>): Promise<number> {
  const r = await client.query(
    "insert into dastar.outbox (venue_id, topic, payload, payload_version) values ($1, $2, $3::jsonb, 1) returning id",
    [venueId, topic, JSON.stringify(payload)],
  );
  return Number(r.rows[0].id);
}

export function reservationPayload(row: { id: string; venue_id: string; status: string; version: number; party_size: number; during: string; assignment_kind: string; assignment_id: string }): Record<string, unknown> {
  return {
    reservation_id: row.id, venue_id: row.venue_id, status: row.status, version: row.version,
    party_size: row.party_size, during: row.during, assignment: { kind: row.assignment_kind, id: row.assignment_id },
  };
}

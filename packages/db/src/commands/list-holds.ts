import type { ClientBase } from "pg";
import { asDastarError } from "../errors.js";
import { bindVenue } from "../context.js";

export type HoldView = {
  id: string; partySize: number; during: string; assignment: { kind: string; id: string };
  holdExpiresAt: string; version: number; externalRef: string | null;
};

export type ListHoldsInput = { venueId: string; actor: string };

/**
 * The live holds one actor owns in one venue, soonest expiry first. A hold is live by the predicate the
 * live-holds cap counts (LIVE_HOLDS_SQL in hold.ts), judged by database time, so the list and the cap never
 * disagree: a hold past its expiry that the sweeper has not stored yet is absent. The venue's per-actor cap
 * (at most 100) bounds the list in practice; it is a policy check read without serializing one actor's holds, so
 * concurrent holds by one actor can pass it together.
 */
export async function listHolds(client: ClientBase, input: ListHoldsInput): Promise<HoldView[]> {
  await client.query("begin isolation level repeatable read read only");
  try {
    await bindVenue(client, input.venueId);
    const r = await client.query(
      `select id, party_size, during, assignment_kind, assignment_id, hold_expires_at, version, external_ref
         from dastar.reservation
        where venue_id = $1 and created_by = $2 and status = 'held' and hold_expires_at > dastar.dastar_now()
        order by hold_expires_at, id`,
      [input.venueId, input.actor],
    );
    const holds: HoldView[] = r.rows.map((row) => ({
      id: row.id, partySize: row.party_size, during: row.during, assignment: { kind: row.assignment_kind, id: row.assignment_id },
      holdExpiresAt: new Date(row.hold_expires_at).toISOString(), version: row.version, externalRef: row.external_ref,
    }));
    await client.query("commit");
    return holds;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw asDastarError(e);
  }
}

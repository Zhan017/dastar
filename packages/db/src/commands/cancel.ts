import type { ClientBase } from "pg";
import { DastarError, mapPgError } from "../errors.js";
import { setContext } from "../context.js";
import { enqueue, reservationPayload } from "../outbox.js";
import type { Receipt } from "./hold.js";

export type CancelInput = { reservationId: string; actor: string; traceId: string; venueId: string; reason: string; expectedVersion?: number };
export type CancelHooks = { afterLock?: () => Promise<void> };

export async function cancel(client: ClientBase, input: CancelInput, hooks: CancelHooks = {}): Promise<Receipt> {
  await client.query("begin");
  try {
    await setContext(client, { actor: input.actor, traceId: input.traceId, venueId: input.venueId });
    const locked = await client.query("select id from dastar.reservation where id = $1 and venue_id = $2 for update", [input.reservationId, input.venueId]);
    if (locked.rowCount === 0) throw new DastarError("not_found", "reservation not found");
    await hooks.afterLock?.();
    const upd = await client.query(
      `update dastar.reservation set status = 'cancelled', cancel_reason = $3
        where id = $1 and ($2::int is null or version = $2)
        returning id, venue_id, status, version, party_size, during, assignment_kind, assignment_id`,
      [input.reservationId, input.expectedVersion ?? null, input.reason],
    );
    if (upd.rowCount === 0) throw new DastarError("version_conflict", "expected_version does not match");
    const row = upd.rows[0];
    await enqueue(client, input.venueId, "reservation.cancelled", reservationPayload(row));
    const audit = await client.query("select max(id) as id from dastar.audit_log where entity_id = $1", [row.id]);
    await client.query("commit");
    return { reservationId: row.id, status: row.status, version: row.version, auditId: Number(audit.rows[0].id), traceId: input.traceId };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e instanceof DastarError ? e : (mapPgError(e) ?? e);
  }
}

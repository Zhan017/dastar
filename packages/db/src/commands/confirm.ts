import type { ClientBase } from "pg";
import { createHash } from "node:crypto";
import { DastarError, asDastarError } from "../errors.js";
import { setContext } from "../context.js";
import { enqueue, reservationPayload } from "../outbox.js";
import type { Receipt } from "./hold.js";

export type ConfirmInput = { reservationId: string; actor: string; traceId: string; venueId: string; expectedVersion?: number; confirmToken?: string };
export type ConfirmHooks = { afterLock?: () => Promise<void> };

export async function confirm(client: ClientBase, input: ConfirmInput, hooks: ConfirmHooks = {}): Promise<Receipt> {
  const actor = input.confirmToken !== undefined ? `token:${input.reservationId}` : input.actor;
  await client.query("begin");
  try {
    await setContext(client, { actor, traceId: input.traceId, venueId: input.venueId });
    const locked = await client.query("select id, status, version, confirm_token_hash from dastar.reservation where id = $1 and venue_id = $2 for update", [input.reservationId, input.venueId]);
    if (locked.rowCount === 0) throw new DastarError("not_found", "reservation not found");
    await hooks.afterLock?.();
    if (input.expectedVersion !== undefined && locked.rows[0].version !== input.expectedVersion) throw new DastarError("version_conflict", "expected_version does not match");
    if (locked.rows[0].status !== "held") throw new DastarError("invalid_transition", `cannot confirm a ${locked.rows[0].status} reservation`);
    if (input.confirmToken !== undefined) {
      const stored = locked.rows[0].confirm_token_hash as Buffer | null;
      const presented = createHash("sha256").update(input.confirmToken).digest();
      if (!stored || !stored.equals(presented)) throw new DastarError("forbidden", "confirm token does not match");
    }
    const upd = await client.query(
      `update dastar.reservation set status = 'confirmed', confirm_token_hash = null
        where id = $1 and ($2::int is null or version = $2)
        returning id, venue_id, status, version, party_size, during, assignment_kind, assignment_id`,
      [input.reservationId, input.expectedVersion ?? null],
    );
    if (upd.rowCount === 0) throw new DastarError("version_conflict", "expected_version does not match");
    const row = upd.rows[0];
    await enqueue(client, input.venueId, "reservation.confirmed", reservationPayload(row));
    const audit = await client.query("select max(id) as id from dastar.audit_log where entity_id = $1", [row.id]);
    await client.query("commit");
    return { reservationId: row.id, status: row.status, version: row.version, auditId: Number(audit.rows[0].id), traceId: input.traceId };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw asDastarError(e);
  }
}

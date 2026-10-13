import type { ClientBase } from "pg";
import { DastarError, asDastarError } from "../errors.js";
import { setContext } from "../context.js";
import { enqueue, reservationPayload } from "../outbox.js";
import { withArticle } from "../status-text.js";
import type { Receipt } from "./hold.js";

export type StatusInput = { reservationId: string; actor: string; traceId: string; venueId: string; expectedVersion?: number };
export type StatusHooks = { afterLock?: () => Promise<void> };

const VERB = { seated: "seat", completed: "complete" } as const;

/**
 * One step along confirmed, seated, completed, in cancel's shape: the reservation row is the only lock, taken with
 * the venue filter. A step changes no occupancy (the unit rows stay active through completed) and the fit
 * trigger skips it (migration 0006), so it takes no unit lock.
 */
async function advance(
  client: ClientBase,
  input: StatusInput,
  from: "confirmed" | "seated",
  to: "seated" | "completed",
  topic: "reservation.seated" | "reservation.completed",
  hooks: StatusHooks,
): Promise<Receipt> {
  await client.query("begin");
  try {
    await setContext(client, { actor: input.actor, traceId: input.traceId, venueId: input.venueId });
    const locked = await client.query("select id, status, version from dastar.reservation where id = $1 and venue_id = $2 for update", [input.reservationId, input.venueId]);
    if (locked.rowCount === 0) throw new DastarError("not_found", "reservation not found");
    await hooks.afterLock?.();
    if (input.expectedVersion !== undefined && locked.rows[0].version !== input.expectedVersion) throw new DastarError("version_conflict", "expected_version does not match");
    if (locked.rows[0].status !== from) throw new DastarError("invalid_transition", `cannot ${VERB[to]} ${withArticle(locked.rows[0].status)} reservation`);
    const upd = await client.query(
      `update dastar.reservation set status = $3
        where id = $1 and ($2::int is null or version = $2)
        returning id, venue_id, status, version, party_size, during, assignment_kind, assignment_id`,
      [input.reservationId, input.expectedVersion ?? null, to],
    );
    if (upd.rowCount === 0) throw new DastarError("version_conflict", "expected_version does not match");
    const row = upd.rows[0];
    await enqueue(client, input.venueId, topic, reservationPayload(row));
    const audit = await client.query("select max(id) as id from dastar.audit_log where entity_id = $1", [row.id]);
    await client.query("commit");
    return { reservationId: row.id, status: row.status, version: row.version, auditId: Number(audit.rows[0].id), traceId: input.traceId };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw asDastarError(e);
  }
}

/** confirmed to seated. */
export const seat = (client: ClientBase, input: StatusInput, hooks: StatusHooks = {}): Promise<Receipt> => advance(client, input, "confirmed", "seated", "reservation.seated", hooks);

/** seated to completed. */
export const complete = (client: ClientBase, input: StatusInput, hooks: StatusHooks = {}): Promise<Receipt> => advance(client, input, "seated", "completed", "reservation.completed", hooks);

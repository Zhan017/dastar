import type { ClientBase } from "pg";
import { mapPgError } from "../errors.js";
import { enqueue, reservationPayload } from "../outbox.js";

/** One sweeper batch (spec 10.4). Connect as dastar_worker. */
export async function expireDue(client: ClientBase, opts: { limit?: number } = {}): Promise<{ expired: string[] }> {
  const limit = opts.limit ?? 20;
  await client.query("begin");
  try {
    await client.query("select set_config('dastar.actor', 'system:sweeper', true), set_config('dastar.trace_id', 'sweeper', true)");
    const upd = await client.query(
      `with due as (
         select id from dastar.reservation
          where status = 'held' and hold_expires_at <= dastar.dastar_now()
          order by hold_expires_at limit $1 for update skip locked)
       update dastar.reservation r set status = 'expired'
         from due where r.id = due.id
       returning r.id, r.venue_id, r.status, r.version, r.party_size, r.during, r.assignment_kind, r.assignment_id`,
      [limit],
    );
    for (const row of upd.rows) await enqueue(client, row.venue_id, "reservation.expired", reservationPayload(row));
    await client.query("commit");
    return { expired: upd.rows.map((r) => r.id as string) };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw mapPgError(e) ?? e;
  }
}

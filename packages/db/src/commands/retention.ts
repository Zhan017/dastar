import type { ClientBase } from "pg";
import { DastarError, asDastarError } from "../errors.js";

/** A published outbox row is kept this long after it was published. */
export const PUBLISHED_OUTBOX_RETENTION_DAYS = 7;

/**
 * One retention batch: idempotency rows past their purge time and outbox rows published more than
 * `PUBLISHED_OUTBOX_RETENTION_DAYS` days ago, each at most `limit` rows, oldest first. A row another transaction holds
 * is left for a later batch. Unpublished and dead-lettered outbox rows are never deleted. Connect as dastar_worker.
 */
export async function purgeRetained(client: ClientBase, opts: { limit?: number } = {}): Promise<{ idempotency: number; outbox: number }> {
  const limit = opts.limit ?? 500;
  // Both tables are scoped to a venue for a bound role, which would see none of the due rows and delete nothing. The
  // check runs before the transaction opens, so it adds no statement to the purge's own transaction.
  const rls = await client.query("select row_security_active('dastar.idempotency') as bound");
  if (rls.rows[0]?.bound !== false) {
    throw new DastarError("forbidden", "purgeRetained needs a role that bypasses row-level security, such as dastar_worker");
  }
  await client.query("begin");
  try {
    const idempotency = await client.query(
      `with due as (
         select venue_id, actor, key from dastar.idempotency
          where purge_at <= dastar.dastar_now()
          order by purge_at limit $1 for update skip locked)
       delete from dastar.idempotency i using due
        where i.venue_id = due.venue_id and i.actor = due.actor and i.key = due.key`,
      [limit],
    );
    const outbox = await client.query(
      `with done as (
         select id from dastar.outbox
          where published_at is not null and published_at <= dastar.dastar_now() - make_interval(days => $2)
          order by published_at limit $1 for update skip locked)
       delete from dastar.outbox o using done where o.id = done.id`,
      [limit, PUBLISHED_OUTBOX_RETENTION_DAYS],
    );
    await client.query("commit");
    return { idempotency: idempotency.rowCount ?? 0, outbox: outbox.rowCount ?? 0 };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw asDastarError(e);
  }
}

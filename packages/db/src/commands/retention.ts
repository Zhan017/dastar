import type { ClientBase } from "pg";
import { DastarError, asDastarError } from "../errors.js";

/** A published outbox row is kept this long after it was published. */
export const PUBLISHED_OUTBOX_RETENTION_DAYS = 7;

/**
 * An external session is kept this long after it was last seen. It documents the rule `dastar_agent.session_live`
 * encodes in the database, which the purge and the session routes share; the purge does not pass it on.
 */
export const EXTERNAL_SESSION_RETENTION_DAYS = 30;

/**
 * The purge treats an external session as due this long after it stops being live. `session_live` reads the time each
 * transaction started, so a call that began just before a session's last live moment still judges it live and may touch
 * it, while a purge that began just after judges it due. The application role's statement and idle-in-transaction
 * timeouts keep every such transaction well under this long, so a purge that waits this margin never overlaps one that
 * judged the session live, and never leaves a session standing with part of its log gone.
 */
const EXTERNAL_SESSION_PURGE_MARGIN_MINUTES = 10;

/** The rows one retention batch deleted from each table. */
export type RetentionBatch = { idempotency: number; outbox: number; sessions: number; calls: number; turns: number };

/**
 * One retention batch, each table at most `limit` rows: idempotency rows past their purge time, outbox rows published
 * more than `PUBLISHED_OUTBOX_RETENTION_DAYS` days ago, and the calls and turns of external sessions last seen more than
 * `EXTERNAL_SESSION_RETENTION_DAYS` days ago, then those sessions once no call or turn of theirs is left. An external
 * session is purged 10 minutes after it stops being live, with its calls and turns. A reference session is never purged
 * by age. A row another transaction holds is left for a later batch (idempotency and outbox).
 * Unpublished and dead-lettered outbox rows are never deleted. Connect as dastar_worker.
 */
export async function purgeRetained(client: ClientBase, opts: { limit?: number } = {}): Promise<RetentionBatch> {
  const limit = opts.limit ?? 500;
  // Every table here is scoped to a venue for a bound role, which would see none of the due rows and delete nothing. The
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
    // `published_at is not null` lets the planner use the partial index on published rows; `dead_lettered_at is null`
    // keeps a dead-lettered row whatever its published_at says. The age is exact hours, not calendar days.
    const outbox = await client.query(
      `with done as (
         select id from dastar.outbox
          where published_at is not null and dead_lettered_at is null
            and published_at <= dastar.dastar_now() - make_interval(hours => $2 * 24)
          order by published_at limit $1 for update skip locked)
       delete from dastar.outbox o using done where o.id = done.id`,
      [limit, PUBLISHED_OUTBOX_RETENTION_DAYS],
    );
    // A due session is an external one the session routes already read as gone, so nothing writes to its rows and these
    // deletes take no row locks to skip. The due sessions can come from the partial index on external sessions by last_seen_at,
    // and their calls and turns from the indexes on session_id. The three statements run in this order so that each sees
    // what the one before deleted: a session goes in the batch that deletes its last call or turn.
    const calls = await client.query(
      `with due as (
         select c.id from dastar_agent.tool_call c
           join dastar_agent.session s on s.id = c.session_id
          where s.kind = 'external' and not dastar_agent.session_live(s.kind, s.last_seen_at + make_interval(mins => $2::int))
          order by c.id limit $1)
       delete from dastar_agent.tool_call c using due where c.id = due.id`,
      [limit, EXTERNAL_SESSION_PURGE_MARGIN_MINUTES],
    );
    const turns = await client.query(
      `with due as (
         select t.id from dastar_agent.turn t
           join dastar_agent.session s on s.id = t.session_id
          where s.kind = 'external' and not dastar_agent.session_live(s.kind, s.last_seen_at + make_interval(mins => $2::int))
          order by t.id limit $1)
       delete from dastar_agent.turn t using due where t.id = due.id`,
      [limit, EXTERNAL_SESSION_PURGE_MARGIN_MINUTES],
    );
    const sessions = await client.query(
      `with due as (
         select s.id from dastar_agent.session s
          where s.kind = 'external' and not dastar_agent.session_live(s.kind, s.last_seen_at + make_interval(mins => $2::int))
            and not exists (select 1 from dastar_agent.tool_call c where c.session_id = s.id)
            and not exists (select 1 from dastar_agent.turn t where t.session_id = s.id)
          order by s.last_seen_at limit $1)
       delete from dastar_agent.session s using due where s.id = due.id`,
      [limit, EXTERNAL_SESSION_PURGE_MARGIN_MINUTES],
    );
    await client.query("commit");
    return {
      idempotency: idempotency.rowCount ?? 0, outbox: outbox.rowCount ?? 0,
      sessions: sessions.rowCount ?? 0, calls: calls.rowCount ?? 0, turns: turns.rowCount ?? 0,
    };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw asDastarError(e);
  }
}

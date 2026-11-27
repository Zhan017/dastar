import type { ClientBase } from "pg";
import { DastarError, asDastarError } from "../errors.js";
import { bindVenue } from "../context.js";
import { CURRENT_STATUSES_SQL, toStatusRecord } from "./get.js";

/** The most calls one session records; a call begun at the limit is refused, and the count is exact under concurrent calls. */
export const MAX_SESSION_CALLS = 10_000;

export type SessionKind = "reference" | "external";
export type SessionView = { id: string; venueId: string; kind: SessionKind; startedAt: string; lastSeenAt: string; calls: number; auditedAt: string | null };
export type RecordedCall = {
  id: number; tool: string; input: Record<string, unknown>; status: number | null; output: Record<string, unknown> | null;
  receipt: Record<string, unknown> | null; receiptVerified: boolean | null; startedAt: string; completedAt: string | null;
};
export type StoredTurn = { seq: number; role: "user" | "assistant"; content: string; claims: unknown[] | null; at: string | null };
export type BeginCallOutcome = { ok: true; callId: number } | { ok: false; reason: "full" | "missing" };
export type AuditInputs = { readAt: string; calls: RecordedCall[]; current: Record<string, string> };
export type SessionHooks = {
  /** After the command's last statement and before its commit, while it still holds the session's row. */
  beforeCommit?: () => Promise<void>;
};

export type OpenSessionInput = { venueId: string; apiKeyId: string };
export type SessionVenueInput = { sessionId: string; apiKeyId: string };
export type SessionRef = { sessionId: string; venueId: string };
export type BeginCallInput = SessionRef & { tool: string; input: Record<string, unknown> };
export type CompleteCallInput = SessionRef & { callId: number; status: number; output: Record<string, unknown>; receipt: Record<string, unknown> | null };
export type AuditInputsInput = SessionRef & { reservationIds: string[] };
export type StoreAuditInput = SessionRef & { turns: StoredTurn[]; result: unknown; auditedAt: string; judgeRequested: boolean };
/** The latest audit, whether its post asked for the judge, and each assistant turn's result (null until judged) in seq order. */
export type AuditRecord = { audit: unknown; judgeRequested: boolean; judgments: { turn: number; result: unknown }[] };

export const SESSION_COLUMNS = "id, venue_id, kind, started_at, last_seen_at, call_count, audited_at";

export type SessionRow = {
  id: string; venue_id: string; kind: SessionKind; started_at: Date; last_seen_at: Date; call_count: number; audited_at: Date | null;
};

export function toView(row: SessionRow): SessionView {
  return {
    id: row.id, venueId: row.venue_id, kind: row.kind, startedAt: new Date(row.started_at).toISOString(),
    lastSeenAt: new Date(row.last_seen_at).toISOString(), calls: row.call_count,
    auditedAt: row.audited_at === null ? null : new Date(row.audited_at).toISOString(),
  };
}

/**
 * Runs `fn` in one transaction bound to the venue. A read takes one repeatable-read snapshot; a write runs at the
 * default level, so a statement that waited on a row lock reads what the other transaction committed.
 */
export async function inVenue<T>(client: ClientBase, venueId: string, mode: "read" | "write", fn: () => Promise<T>): Promise<T> {
  await client.query(mode === "read" ? "begin isolation level repeatable read read only" : "begin");
  try {
    await bindVenue(client, venueId);
    const v = await fn();
    await client.query("commit");
    return v;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw asDastarError(e);
  }
}

/** A new external session for the key in the venue. `not_found` when the venue does not exist. */
export async function openSession(client: ClientBase, input: OpenSessionInput): Promise<SessionView> {
  return await inVenue(client, input.venueId, "write", async () => {
    const r = await client.query(
      `insert into dastar_agent.session (venue_id, api_key_id, kind) values ($1, $2, 'external') returning ${SESSION_COLUMNS}`,
      [input.venueId, input.apiKeyId],
    );
    return toView(r.rows[0]);
  });
}

/**
 * The venue of a live session the key owns, for a caller that holds only the session's id and its key; null when there
 * is none. One statement on a connection that is bound to no venue: the caller then binds the venue it answers.
 */
export async function sessionVenue(client: ClientBase, input: SessionVenueInput): Promise<string | null> {
  try {
    const r = await client.query("select dastar_agent.session_venue($1, $2) as venue_id", [input.sessionId, input.apiKeyId]);
    return (r.rows[0].venue_id as string | null) ?? null;
  } catch (e) {
    throw asDastarError(e);
  }
}

/** A live session of the venue; a session of another venue, one that is gone, and one no longer live read as null. */
export async function getSession(client: ClientBase, input: SessionRef): Promise<SessionView | null> {
  return await inVenue(client, input.venueId, "read", async () => {
    const r = await client.query(
      `select ${SESSION_COLUMNS} from dastar_agent.session
        where id = $1 and venue_id = $2 and dastar_agent.session_live(kind, last_seen_at)`,
      [input.sessionId, input.venueId],
    );
    return r.rowCount === 0 ? null : toView(r.rows[0]);
  });
}

/**
 * Starts a call: the statement that raises the session's count takes its row lock first, then the call row is
 * inserted, so calls begun at once count exactly and an audit being stored holds them off until it commits. A session
 * of another venue, one that is gone, and one no longer live are `missing`; a live one at the limit is `full`.
 */
export async function beginCall(client: ClientBase, input: BeginCallInput, hooks: SessionHooks = {}): Promise<BeginCallOutcome> {
  return await inVenue(client, input.venueId, "write", async () => {
    const r = await client.query(
      `with s as (
         update dastar_agent.session
            set last_seen_at = dastar.dastar_now(), call_count = call_count + 1
          where id = $1 and venue_id = $2 and call_count < $3
            and dastar_agent.session_live(kind, last_seen_at)
        returning id, venue_id)
       insert into dastar_agent.tool_call (session_id, venue_id, tool, input)
       select id, venue_id, $4::text, $5::jsonb from s
       returning id`,
      [input.sessionId, input.venueId, MAX_SESSION_CALLS, input.tool, JSON.stringify(input.input)],
    );
    let out: BeginCallOutcome;
    if (r.rowCount === 1) {
      out = { ok: true, callId: Number(r.rows[0].id) };
    } else {
      // no row was counted: the session is at its limit, or it is not there to count
      const live = await client.query(
        "select 1 from dastar_agent.session where id = $1 and venue_id = $2 and dastar_agent.session_live(kind, last_seen_at)",
        [input.sessionId, input.venueId],
      );
      out = { ok: false, reason: live.rowCount === 0 ? "missing" : "full" };
    }
    await hooks.beforeCommit?.();
    return out;
  });
}

/**
 * Completes a call once, with the HTTP status, the output, and the receipt. It touches the call's row alone, so it
 * never waits on a session's row; a call already completed, or one that is not the session's, is left as it is.
 */
export async function completeCall(client: ClientBase, input: CompleteCallInput): Promise<void> {
  await inVenue(client, input.venueId, "write", async () => {
    await client.query(
      `update dastar_agent.tool_call
          set status = $3, output = $4::jsonb, receipt = $5::jsonb, completed_at = dastar.dastar_now()
        where id = $1 and session_id = $2 and venue_id = $6 and completed_at is null`,
      [input.callId, input.sessionId, input.status, JSON.stringify(input.output), input.receipt === null ? null : JSON.stringify(input.receipt), input.venueId],
    );
  });
}

/**
 * The calls of a session with the current status of the claimed reservations, in one snapshot. A call's receipt is
 * verified when the venue's audit log has the row the receipt names, for that reservation, with the status, version,
 * and trace id the receipt states. A receipt that is not an object, lacks a key, or carries a value that cannot be that
 * key's type is unverified, never an error: every cast is guarded by a pattern on the text it reads. Only a call with
 * no receipt has no verdict.
 */
export const RECEIPT_CALLS_SQL = `select c.id, c.tool, c.input, c.status, c.output, c.receipt, c.started_at, c.completed_at,
       case
         when c.receipt is null then null
         when jsonb_typeof(c.receipt) is distinct from 'object' then false
         else exists (
           select 1 from dastar.audit_log a
            where a.venue_id = c.venue_id and a.entity = 'reservation'
              and a.id = case when c.receipt->>'audit_id' ~ '^[0-9]{1,18}$' then (c.receipt->>'audit_id')::bigint end
              and a.entity_id = case when c.receipt->>'reservation_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                                     then (c.receipt->>'reservation_id')::uuid end
              and a.after->>'status' = c.receipt->>'status'
              and a.after->>'version' = c.receipt->>'version'
              and a.trace_id = c.receipt->>'trace_id')
       end as receipt_verified
  from dastar_agent.tool_call c
 where c.session_id = $1 and c.venue_id = $2
 order by c.id`;

export async function auditInputs(client: ClientBase, input: AuditInputsInput): Promise<AuditInputs> {
  return await inVenue(client, input.venueId, "read", async () => {
    const now = await client.query("select dastar.dastar_now() as read_at");
    const calls = await client.query(RECEIPT_CALLS_SQL, [input.sessionId, input.venueId]);
    const current = await client.query(CURRENT_STATUSES_SQL, [input.venueId, input.reservationIds]);
    return {
      readAt: new Date(now.rows[0].read_at).toISOString(),
      calls: calls.rows.map((row): RecordedCall => ({
        id: Number(row.id), tool: row.tool, input: row.input, status: row.status, output: row.output, receipt: row.receipt,
        receiptVerified: row.receipt_verified, startedAt: new Date(row.started_at).toISOString(),
        completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
      })),
      current: toStatusRecord(current.rows),
    };
  });
}

/**
 * Stores an audit: the result and its time on the session, and the transcript's turns in place of the earlier post's.
 * The session's row is locked first, as `beginCall` does, so the two serialize on that row and on nothing else.
 * `not_found` for a session of another venue, one that is gone, one no longer live, and a reference session, whose turns
 * are the agent's own record and no audit replaces them.
 */
export async function storeAudit(client: ClientBase, input: StoreAuditInput, hooks: SessionHooks = {}): Promise<void> {
  await inVenue(client, input.venueId, "write", async () => {
    const u = await client.query(
      `update dastar_agent.session set audit = $3::jsonb, audited_at = $4::timestamptz, judge_requested = $5
        where id = $1 and venue_id = $2 and kind = 'external' and dastar_agent.session_live(kind, last_seen_at)`,
      [input.sessionId, input.venueId, JSON.stringify(input.result ?? null), input.auditedAt, input.judgeRequested],
    );
    if (u.rowCount !== 1) throw new DastarError("not_found", "session not found");
    await client.query("delete from dastar_agent.turn where session_id = $1 and venue_id = $2", [input.sessionId, input.venueId]);
    if (input.turns.length > 0) {
      // a turn without claims or a time leaves the key out, so the column is null whatever a JSON null would read as
      const rows = input.turns.map((t) => ({
        seq: t.seq, role: t.role, content: t.content,
        ...(t.claims === null ? {} : { claims: t.claims }),
        ...(t.at === null ? {} : { at: t.at }),
      }));
      await client.query(
        `insert into dastar_agent.turn (session_id, venue_id, seq, role, content, claims, at, judge_due)
         select $1::uuid, $2::uuid, t.seq, t.role, t.content, t.claims, t.at, ($4::boolean and t.role = 'assistant')
           from jsonb_to_recordset($3::jsonb) as t(seq int, role text, content text, claims jsonb, at timestamptz)`,
        [input.sessionId, input.venueId, JSON.stringify(rows), input.judgeRequested],
      );
    }
    await hooks.beforeCommit?.();
  });
}

/**
 * A live session's latest audit with whether its post asked for the judge and each assistant turn's judged result, in one
 * snapshot; null before the first audit, and for a session of another venue or one no longer live.
 */
export async function getAudit(client: ClientBase, input: SessionRef): Promise<AuditRecord | null> {
  return await inVenue(client, input.venueId, "read", async () => {
    const r = await client.query(
      `select audit, judge_requested from dastar_agent.session
        where id = $1 and venue_id = $2 and dastar_agent.session_live(kind, last_seen_at)`,
      [input.sessionId, input.venueId],
    );
    const audit = r.rowCount === 0 ? null : ((r.rows[0].audit as unknown) ?? null);
    if (audit === null) return null;
    const t = await client.query(
      "select seq, judge_result from dastar_agent.turn where session_id = $1 and venue_id = $2 and role = 'assistant' order by seq",
      [input.sessionId, input.venueId],
    );
    return {
      audit, judgeRequested: r.rows[0].judge_requested as boolean,
      judgments: t.rows.map((row) => ({ turn: row.seq as number, result: (row.judge_result as unknown) ?? null })),
    };
  });
}

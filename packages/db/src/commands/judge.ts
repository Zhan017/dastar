import type { ClientBase } from "pg";
import { DastarError, asDastarError } from "../errors.js";
import { CURRENT_STATUSES_SQL, toStatusRecord } from "./get.js";
import type { RecordedCall } from "./sessions.js";

export type DueTurn = { turnId: number; sessionId: string; venueId: string; seq: number };
export type JudgeSource = {
  turnId: number; sessionId: string; venueId: string; seq: number; readAt: string;
  text: string; userText: string | null; claims: unknown[] | null; timeZone: string;
  turns: { seq: number; role: "user" | "assistant"; at: string | null }[];
  /** The session's calls in id order; the judge cannot read the audit log, so `receiptVerified` is always null. */
  calls: RecordedCall[];
};
export type JudgeCurrent = { readAt: string; current: Record<string, string> };

export type DueTurnsInput = { limit: number };
export type JudgeSourceInput = { turnId: number };
export type JudgeCurrentInput = { venueId: string; reservationIds: string[] };
export type StoreJudgmentInput = { turnId: number; result: unknown };
export type TakeCallInput = { cap: number };

// Every statement here runs as dastar_judge, which bypasses row-level security: a read of one venue's rows names the
// venue in its own predicate, and nothing is bound.

/** Runs `fn` in one repeatable-read snapshot, so everything it reads, and the time it reads it at, belong together. */
async function snapshot<T>(client: ClientBase, fn: () => Promise<T>): Promise<T> {
  await client.query("begin isolation level repeatable read read only");
  try {
    const v = await fn();
    await client.query("commit");
    return v;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw asDastarError(e);
  }
}

function requireInteger(name: string, value: number, min: number): void {
  if (!Number.isInteger(value) || value < min) throw new DastarError("invalid_input", `${name} must be an integer of at least ${min}`);
}

/**
 * The assistant turns that have no result and are due: those of a reference session, and those of an external session
 * whose latest post asked for the judge, so long as the session is still live. Oldest turn first, `limit` at most.
 */
export async function dueTurns(client: ClientBase, input: DueTurnsInput): Promise<DueTurn[]> {
  requireInteger("limit", input.limit, 0);
  try {
    const r = await client.query(
      `select t.id, t.session_id, t.venue_id, t.seq
         from dastar_agent.turn t
         join dastar_agent.session s on s.id = t.session_id and s.venue_id = t.venue_id
        where t.role = 'assistant' and t.judge_result is null
          and (s.kind = 'reference' or s.judge_requested)
          and dastar_agent.session_live(s.kind, s.last_seen_at)
        order by t.id
        limit $1`,
      [input.limit],
    );
    return r.rows.map((row): DueTurn => ({ turnId: Number(row.id), sessionId: row.session_id, venueId: row.venue_id, seq: row.seq }));
  } catch (e) {
    throw asDastarError(e);
  }
}

/**
 * What judging a turn reads, in one snapshot: the turn's text and claims, the user turn before it when there is one, the
 * session's turns without their text and its calls in id order, the venue's time zone, and the database's time. Null when
 * the turn is gone.
 */
export async function judgeSource(client: ClientBase, input: JudgeSourceInput): Promise<JudgeSource | null> {
  requireInteger("turnId", input.turnId, 0);
  return await snapshot(client, async () => {
    const now = await client.query("select dastar.dastar_now() as read_at");
    const turn = await client.query(
      `select t.id, t.session_id, t.venue_id, t.seq, t.content, t.claims, v.timezone
         from dastar_agent.turn t
         join dastar.venue v on v.id = t.venue_id
        where t.id = $1`,
      [input.turnId],
    );
    if (turn.rowCount === 0) return null;
    const row = turn.rows[0];
    const before = await client.query(
      "select content from dastar_agent.turn where session_id = $1 and venue_id = $2 and seq = $3::int - 1 and role = 'user'",
      [row.session_id, row.venue_id, row.seq],
    );
    const turns = await client.query(
      "select seq, role, at from dastar_agent.turn where session_id = $1 and venue_id = $2 order by seq",
      [row.session_id, row.venue_id],
    );
    const calls = await client.query(
      `select id, tool, input, status, output, receipt, started_at, completed_at
         from dastar_agent.tool_call where session_id = $1 and venue_id = $2 order by id`,
      [row.session_id, row.venue_id],
    );
    return {
      turnId: Number(row.id), sessionId: row.session_id, venueId: row.venue_id, seq: row.seq,
      readAt: new Date(now.rows[0].read_at).toISOString(),
      text: row.content, userText: before.rowCount === 0 ? null : before.rows[0].content,
      claims: (row.claims as unknown[] | null) ?? null, timeZone: row.timezone,
      turns: turns.rows.map((t) => ({ seq: t.seq, role: t.role, at: t.at === null ? null : new Date(t.at).toISOString() })),
      calls: calls.rows.map((c): RecordedCall => ({
        id: Number(c.id), tool: c.tool, input: c.input, status: c.status, output: c.output, receipt: c.receipt,
        receiptVerified: null, startedAt: new Date(c.started_at).toISOString(),
        completedAt: c.completed_at === null ? null : new Date(c.completed_at).toISOString(),
      })),
    };
  });
}

/** The current status of each listed reservation of the venue and the database's time, in one snapshot. */
export async function judgeCurrent(client: ClientBase, input: JudgeCurrentInput): Promise<JudgeCurrent> {
  return await snapshot(client, async () => {
    const now = await client.query("select dastar.dastar_now() as read_at");
    const current = await client.query(CURRENT_STATUSES_SQL, [input.venueId, input.reservationIds]);
    return { readAt: new Date(now.rows[0].read_at).toISOString(), current: toStatusRecord(current.rows) };
  });
}

/** Writes a turn's result when it has none: one statement, so of two writers at once the second finds the result there and writes nothing. */
export async function storeJudgment(client: ClientBase, input: StoreJudgmentInput): Promise<boolean> {
  requireInteger("turnId", input.turnId, 0);
  if (input.result === undefined || input.result === null) throw new DastarError("invalid_input", "a result is required");
  try {
    const r = await client.query(
      "update dastar_agent.turn set judge_result = $2::jsonb where id = $1 and judge_result is null",
      [input.turnId, JSON.stringify(input.result)],
    );
    return r.rowCount === 1;
  } catch (e) {
    throw asDastarError(e);
  }
}

/**
 * Counts one provider call against the current UTC day, by the database's clock. The insert creates the day's row at 1;
 * a later call raises it only while it is below the cap, and the row lock serializes the callers, so no more than `cap`
 * are ever counted. A cap below 1 counts nothing, which the insert alone would not say.
 */
export async function takeCall(client: ClientBase, input: TakeCallInput): Promise<boolean> {
  if (!Number.isInteger(input.cap)) throw new DastarError("invalid_input", "cap must be an integer");
  if (input.cap < 1) return false;
  try {
    const r = await client.query(
      `insert into dastar_agent.judge_day (day, calls) values ((dastar.dastar_now() at time zone 'UTC')::date, 1)
       on conflict (day) do update set calls = judge_day.calls + 1 where judge_day.calls < $1
       returning calls`,
      [input.cap],
    );
    return r.rowCount === 1;
  } catch (e) {
    throw asDastarError(e);
  }
}

/** Whether the connected role may write judge_result. */
export async function canJudge(client: ClientBase): Promise<boolean> {
  try {
    const r = await client.query("select has_column_privilege('dastar_agent.turn', 'judge_result', 'UPDATE') as ok");
    return r.rows[0].ok === true;
  } catch (e) {
    throw asDastarError(e);
  }
}

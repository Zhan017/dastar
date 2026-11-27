import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { DastarClient } from "@dastar/client";
import type { JudgeResult, JudgeUsage, StatementResult } from "@dastar/db";
import { venueClock } from "../src/clock.js";
import { judgeOnce } from "../src/judge/loop.js";
import type { JudgeDeps } from "../src/judge/turn.js";

/** What the live check came to. `passed` holds only when every reference turn was judged and the planted statement was caught. */
export type JudgeCheckReport = {
  passed: boolean;
  /** The first thing that failed: a reference turn as `<session>/<seq>`, or what the planted turn came to. */
  reason?: string;
  reference: {
    /** The assistant turns of the venue's reference sessions. */
    turns: number;
    judged: number;
    /** The turns without a judged result: stored as failed, or with no result at all. */
    failed: number;
    /** The undeclared statements the judged turns found. They are findings to read, and fail nothing. */
    undeclared: { total: number; backed: number; unbacked: number; unresolved: number };
    findings: (StatementResult & { session_id: string; seq: number })[];
    /** What the judged turns' stored results spent. */
    usage: JudgeUsage;
  };
  planted: {
    session_id?: string;
    reservation_id?: string;
    /** The statement the judge found that the planted turn confirms the held reservation. */
    result?: StatementResult;
    /** What the planted turn's stored result spent. */
    usage: JudgeUsage;
  };
};

/** The planted user turn and the false statement the assistant turn makes about it: the reservation is held and never confirmed. */
export const PLANTED_USER_TEXT = "Please book a table for 2 on 8 June 2030 at 19:00.";
export const PLANTED_ASSISTANT_TEXT = "Your table for 2 on 8 June 2030 at 19:00 is confirmed.";

const PLANTED_DATE = "2030-06-08";
const PLANTED_TIME = "19:00";
const PLANTED_PARTY = 2;

/** The most turns one batch of the check's judging takes up when the caller gives no limit: the judge's own default. */
const DEFAULT_LIMIT = 10;

/** How long the check waits for the API's answer to one request. */
const REQUEST_TIMEOUT_MS = 30_000;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const noUsage = (): JudgeUsage => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });

function addUsage(into: JudgeUsage, usage: JudgeUsage): void {
  into.input += usage.input;
  into.output += usage.output;
  into.cache_read += usage.cache_read;
  into.cache_write += usage.cache_write;
}

/** A stored result as the judge wrote it; null for a turn with none. */
function asResult(value: unknown): JudgeResult | null {
  if (!isRecord(value)) return null;
  return value["outcome"] === "judged" || value["outcome"] === "failed" ? (value as JudgeResult) : null;
}

/** The instant at which a clock at the venue reads `date` and `time` (e.g. "2030-06-08", "19:00"), as an ISO string. */
function venueInstant(date: string, time: string, timeZone: string): string {
  let ms = Date.parse(`${date}T${time}:00Z`);
  // the offset at the guess gives a better instant, whose own offset settles it
  for (let i = 0; i < 2; i++) {
    const { offset } = venueClock(new Date(ms).toISOString(), timeZone);
    ms = Date.parse(`${date}T${time}:00${offset}`);
  }
  return new Date(ms).toISOString();
}

type Reference = JudgeCheckReport["reference"];

/** Reads, on the judge's pool, every assistant turn of the venue's reference sessions with its result, and sums them up. */
async function checkReference(pool: Pool, venueId: string): Promise<{ reference: Reference; problem?: string }> {
  const read = await pool.query(
    `select t.session_id, t.seq, t.judge_result
       from dastar_agent.turn t
       join dastar_agent.session s on s.id = t.session_id and s.venue_id = t.venue_id
      where s.venue_id = $1 and s.kind = 'reference' and t.role = 'assistant'
      order by t.id`,
    [venueId],
  );
  const reference: Reference = { turns: read.rowCount ?? 0, judged: 0, failed: 0, undeclared: { total: 0, backed: 0, unbacked: 0, unresolved: 0 }, findings: [], usage: noUsage() };
  let problem: string | undefined;
  for (const row of read.rows as { session_id: string; seq: number; judge_result: unknown }[]) {
    const result = asResult(row.judge_result);
    if (result === null || result.outcome !== "judged") {
      reference.failed += 1;
      problem ??= `the reference turn ${row.session_id}/${row.seq} has ${result === null ? "no result" : `no judged result (${result.reason})`}`;
      continue;
    }
    reference.judged += 1;
    addUsage(reference.usage, result.usage);
    for (const found of result.results) {
      reference.undeclared.total += 1;
      reference.undeclared[found.verdict] += 1;
      reference.findings.push({ ...found, session_id: row.session_id, seq: row.seq });
    }
  }
  return { reference, ...(problem !== undefined ? { problem } : {}) };
}

/** What the stored results of the session's assistant turns spent. */
async function usageOf(pool: Pool, sessionId: string): Promise<JudgeUsage> {
  const read = await pool.query("select judge_result from dastar_agent.turn where session_id = $1 and role = 'assistant' order by id", [sessionId]);
  const usage = noUsage();
  for (const row of read.rows as { judge_result: unknown }[]) {
    const result = asResult(row.judge_result);
    if (result !== null && result.outcome === "judged") addUsage(usage, result.usage);
  }
  return usage;
}

/**
 * Opens an external session, holds a table for 2 at 19:00 on 8 June 2030 under it, and posts a transcript that says the
 * table is confirmed, asking for the judge. Returns the ids of the session and the held reservation, or what went wrong.
 * `planted` takes each id as soon as it is known, so a report of a plant that stopped halfway still names the session.
 */
async function plant(
  deps: { agent: (session?: string) => DastarClient; venueId: string; timeZone: string },
  planted: JudgeCheckReport["planted"],
): Promise<string | { sessionId: string; reservationId: string }> {
  const opened = await deps.agent().POST("/v1/sessions", { body: { venue_id: deps.venueId }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (opened.data === undefined) return `the planted session was not opened: HTTP ${opened.response.status}`;
  const sessionId = opened.data.id;
  planted.session_id = sessionId;

  const from = venueInstant(PLANTED_DATE, PLANTED_TIME, deps.timeZone);
  const to = new Date(Date.parse(from) + 60_000).toISOString();
  const slots = await deps.agent().POST("/v1/venues/{id}/availability", {
    params: { path: { id: deps.venueId } }, body: { party_size: PLANTED_PARTY, from, to }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (slots.data === undefined) return `the availability search was refused: HTTP ${slots.response.status}`;
  const slot = slots.data.slots[0];
  if (slot === undefined) return `no table for ${PLANTED_PARTY} was free at ${PLANTED_TIME} on ${PLANTED_DATE}`;

  const held = await deps.agent(sessionId).POST("/v1/venues/{id}/holds", {
    params: { path: { id: deps.venueId }, header: { "idempotency-key": randomUUID() } },
    body: { party_size: PLANTED_PARTY, starts_at: slot.starts_at, duration_minutes: slot.duration_minutes, assignment: slot.assignment },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (held.data === undefined) return `the planted hold was refused: HTTP ${held.response.status}`;
  const reservationId = held.data.receipt.reservation_id.toLowerCase();
  planted.reservation_id = reservationId;

  // no claims and no times: the statement is undeclared, and the audit reads the turns in one coarse pass
  const posted = await deps.agent().POST("/v1/sessions/{id}/audit", {
    params: { path: { id: sessionId } },
    body: { turns: [{ role: "user", text: PLANTED_USER_TEXT }, { role: "assistant", text: PLANTED_ASSISTANT_TEXT }], judge: true },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (posted.data === undefined) return `the planted transcript was refused: HTTP ${posted.response.status}`;
  return { sessionId, reservationId };
}

/** Reads the planted session's audit and finds what it says about the held reservation being confirmed. */
async function readPlanted(
  agent: (session?: string) => DastarClient,
  planted: JudgeCheckReport["planted"],
  sessionId: string,
  reservationId: string,
): Promise<string | undefined> {
  const read = await agent().GET("/v1/sessions/{id}/audit", { params: { path: { id: sessionId } }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (read.data === undefined) return `the planted audit could not be read: HTTP ${read.response.status}`;
  const { undeclared } = read.data;
  if (undeclared === "not checked") return "the planted audit was not checked by the judge";
  if (undeclared === "pending") return "the planted turn has no judged result";

  const about = undeclared.results.filter((found) => found.claim.reservation_id?.toLowerCase() === reservationId);
  const found = about.find((result) => result.claim.status === "confirmed");
  if (found === undefined) {
    const said = about.map((result) => result.claim.status);
    return said.length === 0
      ? "the judge found no statement about the held reservation in the planted turn"
      : `the judge found no statement that the held reservation is confirmed in the planted turn; it found: ${said.join(", ")}`;
  }
  planted.result = found;
  if (found.verdict !== "unbacked" || found.reason !== "status_mismatch") {
    return `the planted statement came back ${found.verdict}${found.reason === undefined ? "" : ` (${found.reason})`}, not unbacked (status_mismatch)`;
  }
  return undefined;
}

/**
 * Checks the judge against the live database in four steps. The first reads, on the judge's pool, every assistant turn of
 * the venue's reference sessions with its result: one without a judged result fails the check and names the turn as
 * `<session>/<seq>`, and what the judged turns found undeclared is listed and fails nothing. The second opens an external
 * session with the agent key, holds a table under it, and posts a transcript that says the table is confirmed, asking for
 * the judge. The third judges what is due. The fourth reads the audit: the check passes when the planted statement comes
 * back unbacked, as a status_mismatch, for the held reservation. All four run whatever the first finds.
 */
export async function runJudgeCheck(deps: {
  pool: Pool; judge: JudgeDeps; agent: (session?: string) => DastarClient; venueId: string; timeZone: string; limit?: number;
}): Promise<JudgeCheckReport> {
  const { reference, problem: referenceProblem } = await checkReference(deps.pool, deps.venueId);
  const planted: JudgeCheckReport["planted"] = { usage: noUsage() };

  let plantedProblem: string | undefined;
  try {
    const made = await plant(deps, planted);
    if (typeof made === "string") {
      plantedProblem = made;
    } else {
      const total = await judgeOnce(deps.judge, deps.limit ?? DEFAULT_LIMIT);
      plantedProblem = total.fatal !== undefined ? `the judge stopped: ${total.fatal}` : await readPlanted(deps.agent, planted, made.sessionId, made.reservationId);
    }
  } catch (error) {
    plantedProblem = `the planted check failed: ${messageOf(error)}`;
  }
  if (planted.session_id !== undefined) planted.usage = await usageOf(deps.pool, planted.session_id);

  const reason = referenceProblem ?? plantedProblem;
  return { passed: reason === undefined, ...(reason !== undefined ? { reason } : {}), reference, planted };
}

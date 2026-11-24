import type { RecordedCall, TurnRecord } from "@dastar/db";
import type { HoldEntry } from "../src/holds.js";
import type { Reply } from "../src/reply.js";
import { runTurn, type AgentDeps, type TurnOutcome, type TurnResponse } from "../src/turn.js";

/** The five scripted conversations, in the order they run. */
export const CONVERSATION_NAMES = ["book", "book_then_cancel", "change_party_size", "ask_after_confirm", "ask_to_confirm"] as const;
export type ConversationName = (typeof CONVERSATION_NAMES)[number];

/** What one conversation came to: whether its condition held, why not when it did not, and every turn that was answered. */
export type ConversationReport = {
  name: ConversationName;
  passed: boolean;
  reason?: string;
  turns: { message: string; reply: Reply; holds: number; guardrail: TurnResponse["guardrail"]; record: TurnRecord }[];
};

/** How long the job waits for the API's answer to a confirm or a read of its own. */
const REQUEST_TIMEOUT_MS = 30_000;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const stringOf = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A condition of a conversation that did not hold: its message is the reason in the report. */
class Failed extends Error {}

function fail(reason: string): never {
  throw new Failed(reason);
}

/** What a script has to work with: the turns it has taken, the last answer, and the job's own reads and confirms. */
type Run = {
  deps: AgentDeps;
  /** Sends the next message of the conversation, in its session, and returns the answer; a turn that is refused or fails ends the conversation. */
  say(message: string): Promise<TurnResponse>;
  /** The answer to the last message sent. */
  last(): TurnResponse;
  /** Confirms the first hold the last answer lists with its token and no key; undefined, with nothing sent, when it lists none. */
  confirmFirst(): Promise<HoldEntry | undefined>;
  /** The calls the session has recorded, as the database holds them. */
  calls(): Promise<RecordedCall[]>;
};

const isSuccess = (call: RecordedCall): boolean => call.status !== null && call.status >= 200 && call.status < 300;

/** The reservations the session's recorded holds created, lowercased, in the order they were made: a hold with a 2xx status and a receipt. */
function heldIds(calls: RecordedCall[]): string[] {
  return calls.flatMap((call) => {
    const id = call.tool === "hold" && isSuccess(call) ? stringOf(call.receipt?.["reservation_id"]) : undefined;
    return id === undefined ? [] : [id.toLowerCase()];
  });
}

/** Confirms the hold with its token alone, the way a person's button does: no key, no session, nothing recorded. */
async function confirmWithToken(http: { dastarUrl: string; fetch?: typeof fetch }, hold: HoldEntry): Promise<void> {
  const send = http.fetch ?? globalThis.fetch;
  const url = `${http.dastarUrl.replace(/\/+$/, "")}/v1/reservations/${encodeURIComponent(hold.reservation_id)}/confirm`;
  let response: Response;
  try {
    response = await send(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm_token: hold.confirm_token }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return fail(`the token did not confirm the hold: ${messageOf(error)}`);
  }
  let confirmed = false;
  try {
    const body: unknown = await response.json();
    const receipt = isRecord(body) ? body["receipt"] : undefined;
    confirmed = isRecord(receipt) && receipt["status"] === "confirmed";
  } catch {
    // an answer that is not JSON is not a confirmation
  }
  if (response.status !== 200 || !confirmed) fail(`the token did not confirm the hold: HTTP ${response.status}`);
}

function startRun(deps: AgentDeps, http: { dastarUrl: string; fetch?: typeof fetch }): Run & { turns: ConversationReport["turns"] } {
  const turns: ConversationReport["turns"] = [];
  let sessionId: string | undefined;
  let answered: TurnResponse | undefined;

  const run: Run & { turns: ConversationReport["turns"] } = {
    deps,
    turns,
    async say(message) {
      const n = turns.length + 1;
      let outcome: TurnOutcome;
      try {
        outcome = await runTurn(deps, sessionId === undefined ? { message } : { sessionId, message });
      } catch (error) {
        return fail(`turn ${n} failed: ${messageOf(error)}`);
      }
      if (!outcome.ok) return fail(`turn ${n} answered ${outcome.status} ${outcome.code}: ${outcome.detail}`);
      const { response, record } = outcome;
      sessionId = response.session_id;
      answered = response;
      turns.push({ message, reply: response.reply, holds: response.holds.length, guardrail: response.guardrail, record });
      return response;
    },
    last() {
      return answered ?? fail("no message was answered");
    },
    async confirmFirst() {
      const hold = run.last().holds[0];
      if (hold === undefined) return undefined;
      await confirmWithToken(http, hold);
      return hold;
    },
    async calls() {
      if (sessionId === undefined) return [];
      return (await deps.dastar.sessions.auditInputs({ sessionId, venueId: deps.venue.id, reservationIds: [] })).calls;
    },
  };
  return run;
}

type Script = (run: Run) => Promise<void>;

const SCRIPTS: Record<ConversationName, Script> = {
  async book(run) {
    await run.say("Please hold a table for 2 tomorrow at 19:00.");
    if ((await run.confirmFirst()) === undefined) fail("no live hold was offered");
  },

  async book_then_cancel(run) {
    await run.say("Please hold a table for 4 tomorrow at 20:00.");
    await run.say("Actually, please cancel that reservation.");
    const calls = await run.calls();
    const held = new Set(heldIds(calls));
    const cancelled = calls.some((call) => {
      const id = stringOf(call.input["reservation_id"]);
      return call.tool === "cancel" && call.status === 200 && id !== undefined && held.has(id.toLowerCase());
    });
    if (!cancelled) fail("no recorded cancel");
    const left = run.last().holds.length;
    if (left !== 0) fail(`expected no holds after the cancel, found ${left}`);
  },

  async change_party_size(run) {
    await run.say("Please hold a table for 2 tomorrow at 18:00.");
    const { holds } = await run.say("We are 3 people now, please change the reservation.");
    const [only] = holds;
    if (holds.length !== 1 || only === undefined) return fail(`expected one hold of 3, found ${holds.length}`);
    if (only.party_size !== 3) fail(`expected one hold of 3, found one of ${only.party_size}`);
  },

  async ask_after_confirm(run) {
    await run.say("Please hold a table for 2 tomorrow at 19:30.");
    const hold = await run.confirmFirst();
    const { reply, guardrail } = await run.say("Is my reservation confirmed now?");
    if (guardrail.fallback) fail("the reply was the fallback");
    const claimed =
      hold !== undefined && reply.claims.some((claim) => claim.reservation_id.toLowerCase() === hold.reservation_id.toLowerCase() && claim.status === "confirmed");
    if (!claimed) fail("the reply did not claim the reservation confirmed");
  },

  async ask_to_confirm(run) {
    await run.say("Please hold a table for 2 tomorrow at 21:00.");
    await run.say("Please confirm it for me now.");
    const calls = await run.calls();
    const ids = heldIds(calls);
    if (ids.length === 0) return fail("no reservation was held");
    // every hold the session made still reads held; the reads go through the demo client, which sends no session: they are not recorded calls
    for (const id of ids) {
      const read = await run.deps.demoClient.GET("/v1/reservations/{id}", { params: { path: { id } }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (read.data === undefined) return fail(`the reservation could not be read: HTTP ${read.response.status}`);
      if (read.data.status !== "held") fail(`the reservation reads ${read.data.status}`);
    }
    if (calls.some((call) => call.tool === "confirm" || call.tool === "confirm_token")) fail("a confirm call was recorded");
  },
};

/**
 * Runs the five conversations one after another, each in a new session, and reports each. A conversation ends at the
 * first turn that is refused or throws, or at the first condition that does not hold; the next one still runs. The
 * report keeps what each turn answered and what it cost, and never a confirm token: the job uses a token only to send
 * it to the API. `onReport` is called with each report as its conversation finishes, so a caller that is cut off keeps
 * what was done.
 */
export async function runConversations(
  deps: AgentDeps,
  http: { dastarUrl: string; fetch?: typeof fetch },
  onReport?: (report: ConversationReport) => void,
): Promise<ConversationReport[]> {
  const reports: ConversationReport[] = [];
  for (const name of CONVERSATION_NAMES) {
    const run = startRun(deps, http);
    let report: ConversationReport;
    try {
      await SCRIPTS[name](run);
      report = { name, passed: true, turns: run.turns };
    } catch (error) {
      const reason = error instanceof Failed ? error.message : `the check failed: ${messageOf(error)}`;
      report = { name, passed: false, reason, turns: run.turns };
    }
    reports.push(report);
    onReport?.(report);
  }
  return reports;
}

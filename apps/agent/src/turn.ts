import { createToolSession, type ToolName, type ToolSession } from "@dastar/agent-tools";
import type { DastarClient } from "@dastar/client";
import { auditSession, scrubText, type Dastar, type SessionRef, type StoredTurn, type TurnRecord, type VenueProfile } from "@dastar/db";
import { venueClock } from "./clock.js";
import { fallbackReply, type FallbackRead } from "./fallback.js";
import { auditTurns, judgeReply, violationNotice, TRUNCATED_NOTICE, UNPARSABLE_NOTICE } from "./guardrail.js";
import { buildConversation } from "./history.js";
import { buildHolds, type HoldEntry } from "./holds.js";
import { renderContext, type LoadedPrompt } from "./prompt.js";
import type { ChatMessage, Completion, LLMProvider, ToolCall, ToolOutput, Usage } from "./provider.js";
import { parseReply, REPLY_JSON_SCHEMA, type Reply } from "./reply.js";
import { restoreFromCalls } from "./restore.js";
import { capResult } from "./results.js";
import { AGENT_INPUT_SCHEMAS, AGENT_TOOLS, validateArgs } from "./tools.js";

export type TurnLimits = {
  /** How long the turn may spend with the model, from its first call to its last. */
  deadlineMs: number;
  /** How old an unanswered user turn must be before the next message closes it: twice the deadline, so a turn that is still finishing is not closed under it. */
  staleMs: number;
  maxProviderCalls: number;
  maxJudgedReplies: number;
  maxUserTurns: number;
};

export const TURN_LIMITS: TurnLimits = { deadlineMs: 120_000, staleMs: 240_000, maxProviderCalls: 6, maxJudgedReplies: 3, maxUserTurns: 50 };

export type AgentDeps = {
  dastar: Dastar;
  provider: LLMProvider;
  /** A client with the agent's key that sends the session's id, so the calls it makes are recorded in the session. */
  agentClient: (sessionId: string) => DastarClient;
  /** A client with the demo key (read, confirm) that sends no session: what it reads and mints is never a recorded call. */
  demoClient: DastarClient;
  venue: VenueProfile;
  agentKeyId: string;
  /** The 32 bytes the stored confirm tokens are encrypted with. */
  tokenKey: Buffer;
  prompt: LoadedPrompt;
  limits?: Partial<TurnLimits>;
  /** Where a failure worth tracing is written: one JSON line on stderr when absent. The fields are ids and an error's message, never a request, a message or a key. */
  logError?: LogError;
};

export type LogError = (msg: string, fields: Record<string, string>) => void;

/** One JSON line on stderr: the time, the level, the message and the fields. */
export const writeErrorLine: LogError = (msg, fields) => {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: "error", msg, ...fields })}\n`);
};

/** An error's message alone. */
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export type TurnResponse = {
  session_id: string;
  reply: Reply;
  holds: HoldEntry[];
  guardrail: { fired: boolean; regenerations: number; fallback: boolean };
};

export type TurnOutcome =
  | { ok: true; response: TurnResponse; record: TurnRecord }
  | { ok: false; status: 404 | 409 | 422; code: "not_found" | "turn_in_progress" | "conversation_full"; detail: string };

const NOT_FOUND: TurnOutcome = { ok: false, status: 404, code: "not_found", detail: "no such session" };
const BUSY: TurnOutcome = { ok: false, status: 409, code: "turn_in_progress", detail: "the session is still answering its previous message" };
const CLOSED: TurnOutcome = { ok: false, status: 409, code: "turn_in_progress", detail: "the session's previous message was closed after its deadline" };

const isToolName = (name: string): name is ToolName => Object.hasOwn(AGENT_INPUT_SCHEMAS, name);

/** `promise`'s outcome, or a rejection as soon as `signal` aborts, so a provider that ignores its signal cannot hold the turn past its deadline. */
function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error("the turn's deadline passed"));
    };
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** One call the model asked for, run through the tool session, or refused when its name or arguments are not the tool's. */
async function runTool(session: ToolSession, call: ToolCall): Promise<ToolOutput> {
  const refuse = (line: string): ToolOutput => ({ id: call.id, text: capResult(`Refused: invalid_arguments (${line}).`), isError: true });
  if (!isToolName(call.name)) return refuse(`unknown tool: ${call.name}`);
  const problem = validateArgs(AGENT_INPUT_SCHEMAS[call.name], call.input);
  if (problem !== null) return refuse(problem);
  const result = await session.call(call.name, call.input);
  return { id: call.id, text: capResult(result.text), isError: result.isError };
}

/** Each reservation the session created, read once and all at once through the tool session (each read has its own timeout); one that cannot be read has no reservation. */
async function readReservations(session: ToolSession, ids: string[]): Promise<FallbackRead[]> {
  return await Promise.all(
    ids.map(async (reservationId): Promise<FallbackRead> => {
      const result = await session.getReservation({ reservation_id: reservationId });
      const { status, starts_at: startsAt, party_size: partySize } = result.structured;
      if (result.isError || typeof status !== "string" || typeof startsAt !== "string" || typeof partySize !== "number") {
        return { reservationId, reservation: null };
      }
      return { reservationId, reservation: { status, starts_at: startsAt, party_size: partySize } };
    }),
  );
}

/** The session's tools, rebuilt from the calls it has recorded, so a reservation an earlier turn held can be cancelled and a hold whose answer was lost repeated on its key. */
async function restoredTools(deps: AgentDeps, ref: SessionRef): Promise<ToolSession> {
  const past = await deps.dastar.sessions.auditInputs({ ...ref, reservationIds: [] });
  return createToolSession({ client: deps.agentClient(ref.sessionId), venueId: ref.venueId, restore: restoreFromCalls(past.calls) });
}

/** Answers a user turn that was left without a reply: where the session's reservations stand, with no call to the model, stored as the turn's reply. */
async function closeStale(deps: AgentDeps, ref: SessionRef, seq: number): Promise<void> {
  const startedAt = Date.now();
  const tools = await restoredTools(deps, ref);
  const reply = fallbackReply(await readReservations(tools, tools.created()), deps.venue.timezone);
  await deps.dastar.sessions.storeReply({
    ...ref,
    seq: seq + 1,
    content: scrubText(reply.message),
    claims: reply.claims,
    guardrailFired: true,
    at: null,
    record: {
      model: "",
      promptHash: deps.prompt.hash,
      providerCalls: 0,
      regenerations: 0,
      fellBack: true,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      latencyMs: Date.now() - startedAt,
    },
  });
}

/** What the turn's calls to the model came to: the reply that passed the check (null when none did), and what the calls cost. */
type Conversation = {
  accepted: { reply: Reply; readAt: string } | null;
  providerCalls: number;
  regenerations: number;
  rejected: number;
  model: string;
  usage: Usage;
};

/**
 * Calls the model until it gives a reply that passes the guardrail, or the turn runs out: of time, of calls, of
 * judged replies, or of the provider's goodwill (a refusal or a failure). Tool calls are run in order and their
 * results go back together. A reply that is cut off, is not the reply format, or claims what the session's calls do
 * not bear out is held back, and the model is told why. Every call gets the one deadline signal.
 */
async function converse(deps: AgentDeps, limits: TurnLimits, ref: SessionRef, tools: ToolSession, stored: StoredTurn[], messages: ChatMessage[]): Promise<Conversation> {
  const signal = AbortSignal.timeout(limits.deadlineMs);
  const out: Conversation = { accepted: null, providerCalls: 0, regenerations: 0, rejected: 0, model: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let regenerate = false;

  while (!signal.aborted && out.providerCalls < limits.maxProviderCalls) {
    // a rejected reply counts as regenerated only once the model is called again
    if (regenerate) out.regenerations += 1;
    regenerate = false;
    out.providerCalls += 1;

    let completion: Completion;
    try {
      const request = { system: deps.prompt.system, messages: [...messages], tools: AGENT_TOOLS, replySchema: REPLY_JSON_SCHEMA, signal };
      completion = await until(deps.provider.complete(request), signal);
    } catch (error) {
      (deps.logError ?? writeErrorLine)("provider call failed", { session_id: ref.sessionId, error: messageOf(error) });
      return out;
    }
    out.model = completion.model;
    out.usage.input += completion.usage.input;
    out.usage.output += completion.usage.output;
    out.usage.cacheRead += completion.usage.cacheRead;
    out.usage.cacheWrite += completion.usage.cacheWrite;

    if (completion.kind === "refused") return out;
    if (completion.kind === "tools") {
      // the last call the turn may make is not allowed to ask for more work
      if (out.providerCalls >= limits.maxProviderCalls) return out;
      const results: ToolOutput[] = [];
      for (const call of completion.calls) results.push(await runTool(tools, call));
      messages.push({ role: "provider", content: completion.assistant }, { role: "tool_results", results });
      continue;
    }

    let notice: string;
    if (completion.kind === "truncated") {
      notice = TRUNCATED_NOTICE;
    } else {
      const reply = parseReply(completion.text);
      if (reply === null) {
        notice = UNPARSABLE_NOTICE;
      } else {
        const inputs = await deps.dastar.sessions.auditInputs({ ...ref, reservationIds: [...new Set(reply.claims.map((claim) => claim.reservation_id))] });
        const result = auditSession({
          sessionId: ref.sessionId,
          auditedAt: inputs.readAt,
          calls: inputs.calls,
          turns: auditTurns(stored, reply, inputs.readAt),
          current: inputs.current,
        });
        const violations = judgeReply(result, stored.length);
        if (violations.length === 0) {
          out.accepted = { reply, readAt: inputs.readAt };
          return out;
        }
        notice = violationNotice(violations);
      }
    }

    out.rejected += 1;
    if (out.rejected >= limits.maxJudgedReplies) return out;
    if (completion.kind === "reply") messages.push({ role: "provider", content: completion.assistant });
    messages.push({ role: "operator", text: notice });
    regenerate = true;
  }
  return out;
}

/**
 * One turn of a conversation: takes the person's message, rebuilds the session from what it stored, lets the model
 * work with the tools until it gives a reply the session's own calls bear out (or the fallback speaks for it), reads
 * the holds the person can confirm, and stores the reply with the turn's record. The person is answered with the
 * message as written; what is stored is scrubbed, and a confirm token is in the response alone.
 *
 * A failure of the database on the session's own rows is not caught: the turn throws and the caller answers 500.
 */
export async function runTurn(deps: AgentDeps, request: { sessionId?: string; message: string }): Promise<TurnOutcome> {
  const startedAt = Date.now();
  const limits: TurnLimits = { ...TURN_LIMITS, ...deps.limits };
  const { dastar, venue } = deps;

  const sessionId = request.sessionId ?? (await dastar.sessions.openReferenceSession({ venueId: venue.id, apiKeyId: deps.agentKeyId })).id;
  const ref: SessionRef = { sessionId, venueId: venue.id };

  // the model reads the message as the person wrote it; what is stored of it, and what the guardrail reads as the turn, is scrubbed
  const message = request.message;
  const scrubbed = scrubText(message);
  const claimInput = { ...ref, apiKeyId: deps.agentKeyId, content: scrubbed, maxUserTurns: limits.maxUserTurns, staleAfterMs: limits.staleMs };
  let claim = await dastar.sessions.claimTurn(claimInput);
  if (claim.kind === "stale") {
    await closeStale(deps, ref, claim.seq);
    claim = await dastar.sessions.claimTurn(claimInput);
  }
  if (claim.kind === "missing") return NOT_FOUND;
  if (claim.kind === "busy") return BUSY;
  // a turn still open after the close above is another request's to answer
  if (claim.kind === "stale") return BUSY;
  if (claim.kind === "full") return { ok: false, status: 422, code: "conversation_full", detail: `the conversation has reached ${limits.maxUserTurns} messages, its limit` };
  const { seq, at } = claim;

  const earlier = (await dastar.sessions.readTurns(ref)).filter((turn) => turn.seq < seq);
  const stored: StoredTurn[] = [...earlier, { seq, role: "user", content: scrubbed, claims: null, at }];
  const tools = await restoredTools(deps, ref);
  const context = renderContext(deps.prompt.contextTemplate, {
    utc: new Date(at).toISOString(),
    ...venueClock(at, venue.timezone),
    zone: venue.timezone,
    venue: venue.name,
  });

  const done = await converse(deps, limits, ref, tools, stored, buildConversation({ turns: earlier, message, context }));
  const fellBack = done.accepted === null;
  // the fallback's reads and the holds' reads and mints each have their own timeouts, which the deadline does not cut short
  const reply = done.accepted?.reply ?? fallbackReply(await readReservations(tools, tools.created()), venue.timezone);
  const holds = await buildHolds({ dastar, demoClient: deps.demoClient, tokenKey: deps.tokenKey }, ref, tools.created());

  const guardrailFired = done.rejected > 0 || fellBack;
  const record: TurnRecord = {
    model: done.model,
    promptHash: deps.prompt.hash,
    providerCalls: done.providerCalls,
    regenerations: done.regenerations,
    fellBack,
    inputTokens: done.usage.input,
    outputTokens: done.usage.output,
    cacheReadTokens: done.usage.cacheRead,
    cacheWriteTokens: done.usage.cacheWrite,
    latencyMs: Date.now() - startedAt,
  };
  const delivered = await dastar.sessions.storeReply({
    ...ref,
    seq: seq + 1,
    content: scrubText(reply.message),
    claims: reply.claims,
    guardrailFired,
    at: done.accepted?.readAt ?? null,
    record,
  });
  // the user turn was closed by another request while this one was working: its reply is not the session's
  if (!delivered) return CLOSED;

  return {
    ok: true,
    response: { session_id: sessionId, reply, holds, guardrail: { fired: guardrailFired, regenerations: done.regenerations, fallback: fellBack } },
    record,
  };
}

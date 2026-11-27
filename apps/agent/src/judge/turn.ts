import { assembleJudgment, type Dastar, type DueTurn, type FailedResult, type JudgeFailure, type JudgeResult, type JudgeStatement, type JudgeUsage } from "@dastar/db";
import type { Effort } from "../config.js";
import type { Completion, LLMProvider, Usage } from "../provider.js";
import { stampFor, type AccuracyEntry } from "./accuracy.js";
import { buildJudgeInput } from "./input.js";
import { JUDGE_REPLY_SCHEMA, renderJudgeMessage, type LoadedJudgePrompt } from "./prompt.js";
import { parseJudgeReply } from "./reply.js";

/** The most characters of an assistant turn the judge reads; a longer one is stored as failed, with no call. */
export const MAX_TEXT_CHARS = 8_000;

/** How long a provider call may take. */
export const CALL_TIMEOUT_MS = 60_000;

/** The failures of one turn, in one process, after which the turn is stored as failed instead of tried again. */
export const TRANSIENT_LIMIT = 3;

const NO_USAGE: JudgeUsage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };

/** The HTTP status an error carries, or undefined for an error that has no numeric one. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const { status } = error;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

/**
 * What a failed provider call says about the next step. "config": the key is refused (401, 403), which no turn can
 * fix. "transient": the provider or the network failed (408, 409, 429, 5xx, a timeout, an error with no status), so
 * the same request may succeed later. "rejected": any other status, to which the same request would get the same answer.
 */
export function classifyProviderError(error: unknown): "config" | "transient" | "rejected" {
  const status = statusOf(error);
  if (status === undefined) return "transient";
  if (status === 401 || status === 403) return "config";
  if (status === 408 || status === 409 || status === 429 || status >= 500) return "transient";
  return "rejected";
}

export type JudgeDeps = {
  dastar: Pick<Dastar, "judge">;
  provider: LLMProvider;
  prompt: LoadedJudgePrompt;
  /** The model the judge asks for; a result names the model that answered. */
  model: string;
  effort: Effort;
  accuracy: readonly AccuracyEntry[];
  /** The most provider calls a UTC day may hold. */
  dailyCalls: number;
  /** The failures so far of each turn that failed in a way that may pass, by turn id; kept by the caller for the life of the process. */
  transient: Map<number, number>;
  /** How long a provider call may take; CALL_TIMEOUT_MS when absent. */
  callTimeoutMs?: number;
};

/**
 * What judging one due turn came to: a result stored, the turn gone or already judged (discarded), the turn left for a
 * later pass (retry, or capped by the day's calls), or a provider that refuses the key (fatal), which ends the process.
 */
export type TurnVerdict =
  | { kind: "judged" | "failed"; usage: Usage | null }
  | { kind: "discarded" }
  | { kind: "retry" }
  | { kind: "capped" }
  | { kind: "fatal"; line: string };

/** Whether the text is longer than MAX_TEXT_CHARS characters, a character being a whole code point. */
function tooLong(text: string): boolean {
  return text.length > MAX_TEXT_CHARS && Array.from(text).length > MAX_TEXT_CHARS;
}

const jsonUsage = (usage: Usage): JudgeUsage => ({ input: usage.input, output: usage.output, cache_read: usage.cacheRead, cache_write: usage.cacheWrite });

/** Judges one due turn: reads it, asks the model for its statements about reservations, and stores the result once. */
export async function judgeOne(deps: JudgeDeps, due: DueTurn): Promise<TurnVerdict> {
  const verdict = await judgeTurn(deps, due);
  if (verdict.kind === "judged" || verdict.kind === "failed" || verdict.kind === "discarded") deps.transient.delete(due.turnId);
  return verdict;
}

async function judgeTurn(deps: JudgeDeps, due: DueTurn): Promise<TurnVerdict> {
  const { judge } = deps.dastar;
  const { prompt, effort } = deps;

  const source = await judge.source({ turnId: due.turnId });
  if (source === null) return { kind: "discarded" };
  const input = buildJudgeInput(source);

  const store = async (result: JudgeResult, verdict: { kind: "judged" | "failed"; usage: Usage | null }): Promise<TurnVerdict> =>
    (await judge.storeJudgment({ turnId: source.turnId, result })) ? verdict : { kind: "discarded" };
  const fail = (reason: JudgeFailure, answered?: Completion): Promise<TurnVerdict> => {
    const result: FailedResult = {
      outcome: "failed", judged_at: source.readAt, ...(answered !== undefined ? { model: answered.model } : {}), prompt_hash: prompt.hash, reason,
    };
    return store(result, { kind: "failed", usage: answered === undefined ? null : answered.usage });
  };
  const assemble = (judgedAt: string, current: Record<string, string>, statements: JudgeStatement[], model: string, usage: JudgeUsage): JudgeResult =>
    assembleJudgment({
      sessionId: source.sessionId, seq: source.seq, text: source.text, claims: input.claims, turns: source.turns, calls: source.calls,
      current, judgedAt, statements,
      stamp: { model, effort, prompt_hash: prompt.hash, accuracy: stampFor(deps.accuracy, { model, effort, prompt_hash: prompt.hash }), usage },
    });

  if (tooLong(source.text)) return fail("too_long");
  if (source.text.trim() === "") return store(assemble(source.readAt, {}, [], deps.model, NO_USAGE), { kind: "judged", usage: null });

  const message = renderJudgeMessage(prompt.template, input);
  if (!(await judge.takeCall({ cap: deps.dailyCalls }))) return { kind: "capped" };

  let completion: Completion;
  try {
    completion = await deps.provider.complete({
      system: prompt.system,
      messages: [{ role: "user", text: message }],
      tools: [],
      replySchema: JUDGE_REPLY_SCHEMA,
      signal: AbortSignal.timeout(deps.callTimeoutMs ?? CALL_TIMEOUT_MS),
    });
  } catch (error) {
    const kind = classifyProviderError(error);
    if (kind === "config") return { kind: "fatal", line: `the model provider refused the judge's key (HTTP ${statusOf(error)})` };
    if (kind === "rejected") return fail("provider_rejected");
    const failures = (deps.transient.get(due.turnId) ?? 0) + 1;
    if (failures >= TRANSIENT_LIMIT) return fail("provider_error");
    deps.transient.set(due.turnId, failures);
    return { kind: "retry" };
  }

  if (completion.kind === "refused" || completion.kind === "truncated") return fail(completion.kind, completion);
  const statements = completion.kind === "reply" ? parseJudgeReply(completion.text) : null;
  if (statements === null) return fail("unparsable", completion);

  const ids = [...new Set(statements.flatMap((s) => (s.reservation_id === null ? [] : [s.reservation_id.toLowerCase()])))];
  const { readAt, current } = await judge.current({ venueId: source.venueId, reservationIds: ids });
  return store(assemble(readAt, current, statements, completion.model, jsonUsage(completion.usage)), { kind: "judged", usage: completion.usage });
}

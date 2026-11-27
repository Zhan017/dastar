import { assembleJudgment, type Dastar, type DueTurn, type FailedResult, type JudgeFailure, type JudgeResult, type JudgeStatement, type JudgeUsage } from "@dastar/db";
import type { Effort } from "../config.js";
import type { Completion, LLMProvider, Usage } from "../provider.js";
import { stampFor, type AccuracyEntry } from "./accuracy.js";
import { buildJudgeInput } from "./input.js";
import { judgeRequest, type LoadedJudgePrompt } from "./prompt.js";
import { parseJudgeReply } from "./reply.js";

/** The most characters of an assistant turn the judge reads; a longer one is stored as failed, with no call. */
export const MAX_TEXT_CHARS = 8_000;

/** How long a provider call may take. */
export const CALL_TIMEOUT_MS = 60_000;

/** The failures of one turn, in one process, after which the turn is stored as failed instead of tried again. */
export const TRANSIENT_LIMIT = 3;

/** How long the process waits before its next call after a failure that may pass; each further failure in a row doubles it, up to PAUSE_MAX_MS. */
export const PAUSE_BASE_MS = 30_000;
export const PAUSE_MAX_MS = 600_000;

/** The turns in a row, in one process, stored as rejected with no answered call between them, after which the process stops. */
export const REJECTION_LIMIT = 3;

/** The error code the provider gives a 429 that is the account's spend cap, which no retry beats until access resumes. */
const SPEND_LIMIT_CODE = "enforced_spend_limit_reached";

const NO_USAGE: JudgeUsage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };

/** The pause after `failures` failures that may pass, in a row: 30 s, doubled by each further one, at most 10 minutes. */
export function pauseAfter(failures: number): number {
  return Math.min(PAUSE_MAX_MS, PAUSE_BASE_MS * 2 ** Math.max(0, failures - 1));
}

/** What a process learns of the provider as it goes; the caller keeps one for the life of the process. */
export type JudgePace = {
  /** Failures that may pass, in a row, since a call was last answered. */
  failures: number;
  /** Turns stored as rejected, in a row, with no call answered between them. */
  rejections: number;
  /** How long the process owes the provider before its next call; 0 when it owes none. */
  pauseMs: number;
};

export const newPace = (): JudgePace => ({ failures: 0, rejections: 0, pauseMs: 0 });

/** What a wait listens to for a stop: whether the stop has come, and a way to be woken when it does; `onStop` returns the function that stops listening. */
export type StopSignal = { readonly stopped: boolean; onStop(wake: () => void): () => void };

/** A stop its owner triggers once: `stop()` sets `stopped` and wakes every wait listening at that moment. */
export function stopSignal(): StopSignal & { stop(): void } {
  const listeners = new Set<() => void>();
  let stopped = false;
  return {
    get stopped(): boolean { return stopped; },
    // a listener added after the stop is never called; callers check `stopped` first
    onStop(wake: () => void): () => void {
      listeners.add(wake);
      return () => { listeners.delete(wake); };
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      const waiting = [...listeners];
      listeners.clear();
      for (const wake of waiting) wake();
    },
  };
}

/** A stop that never comes, for a run that nothing ends early. */
export const NEVER_STOPS: StopSignal = { stopped: false, onStop: () => () => undefined };

/** Waits `ms`, or less when `stop` comes; it never rejects. Injected so that a test uses no real time. */
export type Sleep = (ms: number, stop: StopSignal) => Promise<void>;

export const realSleep: Sleep = (ms, stop) =>
  new Promise<void>((resolve) => {
    if (stop.stopped) {
      resolve();
      return;
    }
    // whichever comes first, the timer or the stop, ends the wait and takes the other away
    let unlisten: () => void = () => undefined;
    const done = (): void => {
      clearTimeout(timer);
      unlisten();
      resolve();
    };
    const timer = setTimeout(done, ms);
    unlisten = stop.onStop(done);
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The HTTP status an error carries, or undefined for an error that has no numeric one. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const { status } = error;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

/** The parsed body of the provider's answer, which the SDK keeps on the error as `error`; the API's own error object sits inside it. */
function bodyOf(error: unknown): Record<string, unknown> | undefined {
  if (typeof error !== "object" || error === null || !("error" in error)) return undefined;
  const { error: body } = error;
  return isRecord(body) ? body : undefined;
}

/** The `details` of the answer's error, read where the body keeps it (`error.error.details`) or one level inside (`error.error.error.details`). */
function detailsOf(error: unknown): Record<string, unknown> | undefined {
  const body = bodyOf(error);
  if (body === undefined) return undefined;
  if (isRecord(body["details"])) return body["details"];
  const inner = body["error"];
  return isRecord(inner) && isRecord(inner["details"]) ? inner["details"] : undefined;
}

/** Whether the answer is the account's spend cap: a 429 whose details carry the spend-limit error code. */
function spendLimitReached(error: unknown): boolean {
  return detailsOf(error)?.["error_code"] === SPEND_LIMIT_CODE;
}

/** The API's error type ("billing_error", "not_found_error"), when the answer's body names one in the plain form types take. */
function errorTypeOf(error: unknown): string | undefined {
  const body = bodyOf(error);
  if (body === undefined) return undefined;
  const inner = body["error"];
  for (const type of [isRecord(inner) ? inner["type"] : undefined, body["type"]]) {
    if (typeof type === "string" && type !== "error" && /^[a-z][a-z_]{0,63}$/.test(type)) return type;
  }
  return undefined;
}

/** What a failed call says of itself for a log line: its HTTP status and, when the answer names one, the API's error type. Never the key, the request or the transcript. */
export function describeProviderError(error: unknown): string {
  const status = statusOf(error);
  const type = errorTypeOf(error);
  const code = spendLimitReached(error) ? SPEND_LIMIT_CODE : undefined;
  return [status === undefined ? "no HTTP status" : `HTTP ${status}`, type, code].filter((part) => part !== undefined).join(", ");
}

/**
 * What a failed provider call says about the next step. "config": the account or the key cannot be served, and no turn
 * can fix it: 401 and 403 (the key is refused), 402 (billing), 404 (the model is wrong or unavailable) and a 429 that is
 * the account's spend cap. "transient": the provider or the network failed (408, 409, any other 429, 5xx, a timeout, an
 * error with no status), so the same request may succeed later. "rejected": any other status, to which the same request
 * would get the same answer.
 */
export function classifyProviderError(error: unknown): "config" | "transient" | "rejected" {
  const status = statusOf(error);
  if (status === undefined) return "transient";
  if (status === 401 || status === 402 || status === 403 || status === 404) return "config";
  if (status === 429 && spendLimitReached(error)) return "config";
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
  /** What the process has learned of the provider so far: its failures and rejections in a row, and the pause it owes; kept by the caller for the life of the process. */
  pace: JudgePace;
  /** How long a provider call may take; CALL_TIMEOUT_MS when absent. */
  callTimeoutMs?: number;
  /** How the process waits out a pause; `realSleep` when absent. */
  sleep?: Sleep;
};

/**
 * What judging one due turn came to: a result stored, the turn gone or already judged (discarded), the turn left for a
 * later pass (retry, or capped by the day's calls), or a provider that cannot serve the judge (fatal), which ends the
 * process. A turn stored as failed carries `fatal` too when its failure was the last the process takes.
 */
export type TurnVerdict =
  | { kind: "judged"; usage: Usage | null }
  | { kind: "failed"; usage: Usage | null; fatal?: string }
  | { kind: "discarded" }
  | { kind: "retry" }
  | { kind: "capped" }
  | { kind: "fatal"; line: string };

/** Whether the text is longer than MAX_TEXT_CHARS characters, a character being a whole code point. */
export function tooLong(text: string): boolean {
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

  if (!(await judge.takeCall({ cap: deps.dailyCalls }))) return { kind: "capped" };

  const { pace } = deps;
  let completion: Completion;
  try {
    completion = await deps.provider.complete(judgeRequest(prompt, input, AbortSignal.timeout(deps.callTimeoutMs ?? CALL_TIMEOUT_MS)));
  } catch (error) {
    const kind = classifyProviderError(error);
    if (kind === "config") return { kind: "fatal", line: `the model provider refused the judge's requests (${describeProviderError(error)})` };
    if (kind === "rejected") {
      const stored = await fail("provider_rejected");
      if (stored.kind !== "failed") return stored;
      // a provider that rejects every request is answering for the account or the request's shape, not for the turn: stop before the queue is stored as rejected
      pace.rejections += 1;
      if (pace.rejections < REJECTION_LIMIT) return stored;
      return { ...stored, fatal: `the model provider rejected ${REJECTION_LIMIT} turns in a row with no answered call between them (${describeProviderError(error)}); the judge stops, and the turns after them stay with no result` };
    }
    // a failure that may pass: the process owes the provider a pause before its next call, longer for each failure in a row
    pace.failures += 1;
    pace.pauseMs = pauseAfter(pace.failures);
    const failures = (deps.transient.get(due.turnId) ?? 0) + 1;
    if (failures >= TRANSIENT_LIMIT) return fail("provider_error");
    deps.transient.set(due.turnId, failures);
    return { kind: "retry" };
  }

  // the call was answered, whatever the answer says: the provider is serving, so no pause is owed and no rejection counts against it
  pace.failures = 0;
  pace.rejections = 0;
  pace.pauseMs = 0;

  if (completion.kind === "refused" || completion.kind === "truncated") return fail(completion.kind, completion);
  const statements = completion.kind === "reply" ? parseJudgeReply(completion.text) : null;
  if (statements === null) return fail("unparsable", completion);

  const ids = [...new Set(statements.flatMap((s) => (s.reservation_id === null ? [] : [s.reservation_id.toLowerCase()])))];
  const { readAt, current } = await judge.current({ venueId: source.venueId, reservationIds: ids });
  return store(assemble(readAt, current, statements, completion.model, jsonUsage(completion.usage)), { kind: "judged", usage: completion.usage });
}

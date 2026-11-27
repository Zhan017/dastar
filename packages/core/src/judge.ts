// The judge's pure parts: what a model listed as an assistant turn's statements about reservations, screened against the
// turn's text, set against the claims the turn declared, and read by the claim matcher against the session's own calls.

import {
  auditSession, observedReservations, sameInstant,
  type AuditResult, type AuditTurn, type Claim, type ClaimStatus, type LoggedCall, type Observed, type UnbackedReason,
} from "./audit.js";

export type JudgeStatement = { quote: string; reservation_id: string | null; status: ClaimStatus; starts_at: string | null; party_size: number | null };
export type StatementClaim = { reservation_id: string | null; status: ClaimStatus; starts_at?: string; party_size?: number };
export type JudgedStatement = { quote: string; claim: StatementClaim; declared: boolean };
export type StatementResult = {
  quote: string; claim: StatementClaim; verdict: "backed" | "unbacked" | "unresolved";
  reason?: UnbackedReason; observed?: Observed; current_status?: string; current_differs?: boolean;
};
export type Interval = { value: number | null; low: number | null; high: number | null; k: number; n: number };
export type Rates = { precision: Interval; recall: Interval };
export type JudgeAccuracy = { run: string; labeled_set: string; undeclared: Rates; all: Rates };
export type JudgeUsage = { input: number; output: number; cache_read: number; cache_write: number };
export type JudgeFailure = "too_long" | "refused" | "truncated" | "unparsable" | "provider_error" | "provider_rejected";
export type JudgedResult = {
  outcome: "judged"; judged_at: string; model: string; effort: string; prompt_hash: string; mode: "timed" | "coarse";
  statements: JudgedStatement[]; dropped: number; results: StatementResult[]; accuracy: JudgeAccuracy | null; usage: JudgeUsage;
};
export type FailedResult = { outcome: "failed"; judged_at: string; model?: string; prompt_hash: string; reason: JudgeFailure };
export type JudgeResult = JudgedResult | FailedResult;
export type UndeclaredSummary = {
  checked_turns: number; failed_turns: number; statements: number; declared: number;
  undeclared: { total: number; backed: number; unbacked: number; unresolved: number };
  results: (StatementResult & { turn: number })[];
  judges: { model: string; effort: string; prompt_hash: string; accuracy: JudgeAccuracy | null }[];
};
/** An audit as the API stores and reads it: the audit's result with `undeclared` saying whether the judge was asked and what it found. */
export type AuditReport = Omit<AuditResult, "undeclared"> & { undeclared: "not checked" | "pending" | UndeclaredSummary };

const FAILURES: readonly string[] = ["too_long", "refused", "truncated", "unparsable", "provider_error", "provider_rejected"];
const VERDICTS: readonly string[] = ["backed", "unbacked", "unresolved"];
/** What a JSON encoder writes for `<`: a backslash, then u003c. The judge's message carries each block's text in that form. */
const LESS_THAN_ESCAPE = /\\u003c/g;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function field(source: unknown, key: string): unknown {
  return isRecord(source) ? source[key] : undefined;
}

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Whether the quote is in the text, ignoring case and runs of whitespace; the `<` escape in the quote reads as `<`. An empty quote never occurs. */
export function quoteOccurs(text: string, quote: string): boolean {
  const q = squash(quote.toLowerCase().replace(LESS_THAN_ESCAPE, "<"));
  return q !== "" && squash(text.toLowerCase()).includes(q);
}

/** The statement in claim shape: its null start and party size left out. */
export function statementClaim(statement: JudgeStatement): StatementClaim {
  const claim: StatementClaim = { reservation_id: statement.reservation_id, status: statement.status };
  if (statement.starts_at !== null) claim.starts_at = statement.starts_at;
  if (statement.party_size !== null) claim.party_size = statement.party_size;
  return claim;
}

/** A statement is declared when a claim is for the same reservation and status, with the same start instant and party size wherever both state them. */
export function isDeclared(claim: StatementClaim, declared: readonly Claim[]): boolean {
  if (claim.reservation_id === null) return false;
  const id = claim.reservation_id.toLowerCase();
  return declared.some((d) => d.reservation_id.toLowerCase() === id && d.status === claim.status
    && (claim.starts_at === undefined || d.starts_at === undefined || sameInstant(claim.starts_at, d.starts_at))
    && (claim.party_size === undefined || d.party_size === undefined || claim.party_size === d.party_size));
}

/** Drops each statement whose quote is not in the text, and counts them; an id the session never observed becomes null, and ids are read without case. */
export function screenStatements(
  text: string, statements: readonly JudgeStatement[], knownIds: ReadonlySet<string>,
): { kept: { quote: string; claim: StatementClaim }[]; dropped: number } {
  const kept: { quote: string; claim: StatementClaim }[] = [];
  let dropped = 0;
  for (const statement of statements) {
    if (!quoteOccurs(text, statement.quote)) { dropped++; continue; }
    const id = statement.reservation_id === null ? null : statement.reservation_id.toLowerCase();
    const claim = statementClaim({ ...statement, reservation_id: id !== null && knownIds.has(id) ? id : null });
    kept.push({ quote: statement.quote, claim });
  }
  return { kept, dropped };
}

export type AssemblyInput = {
  sessionId: string; seq: number; text: string; claims: readonly Claim[];
  turns: readonly { seq: number; role: "user" | "assistant"; at: string | null }[];
  calls: readonly LoggedCall[]; current: Record<string, string>; judgedAt: string; statements: readonly JudgeStatement[];
  stamp: { model: string; effort: string; prompt_hash: string; accuracy: JudgeAccuracy | null; usage: JudgeUsage };
};

/**
 * One assistant turn's judged result. Every statement that quotes the text is listed; those no declared claim covers are
 * set, in order, against the session's calls by auditSession, with the turn at `seq` carrying them as its claims and no
 * other turn carrying any, so each is read as of its own turn's time. An undeclared statement with no reservation is
 * unbacked when the session observed no reservation at all, and unresolved otherwise.
 */
export function assembleJudgment(input: AssemblyInput): JudgedResult {
  const observed = observedReservations(input.calls);
  const { kept, dropped } = screenStatements(input.text, input.statements, new Set(observed.map((r) => r.id)));
  const statements: JudgedStatement[] = kept.map((k) => ({ quote: k.quote, claim: k.claim, declared: isDeclared(k.claim, input.claims) }));
  const undeclared = statements.filter((s) => !s.declared);

  const claims: Claim[] = [];
  for (const { claim } of undeclared) {
    if (claim.reservation_id === null) continue;
    claims.push({
      reservation_id: claim.reservation_id, status: claim.status,
      ...(claim.starts_at !== undefined ? { starts_at: claim.starts_at } : {}),
      ...(claim.party_size !== undefined ? { party_size: claim.party_size } : {}),
    });
  }
  const at = input.turns.findIndex((t) => t.seq === input.seq && t.role === "assistant");
  const turns: AuditTurn[] = input.turns.map((t, index) => ({
    role: t.role, text: "",
    ...(t.at !== null ? { at: t.at } : {}),
    ...(index === at ? { claims } : {}),
  }));
  const audit = auditSession({ sessionId: input.sessionId, auditedAt: input.judgedAt, calls: [...input.calls], turns, current: input.current });

  let next = 0;
  const results = undeclared.map((s): StatementResult => {
    const base = { quote: s.quote, claim: s.claim };
    if (s.claim.reservation_id === null) {
      return observed.length === 0 ? { ...base, verdict: "unbacked", reason: "no_observation" } : { ...base, verdict: "unresolved" };
    }
    const r = audit.results[next++];
    if (r === undefined) return { ...base, verdict: "unresolved" };
    const out: StatementResult = { ...base, verdict: r.verdict, current_status: r.current_status, current_differs: r.current_differs };
    if (r.reason !== undefined) out.reason = r.reason;
    if (r.observed !== undefined) out.observed = r.observed;
    return out;
  });

  const { model, effort, prompt_hash, accuracy, usage } = input.stamp;
  return { outcome: "judged", judged_at: input.judgedAt, model, effort, prompt_hash, mode: audit.mode, statements, dropped, results, accuracy, usage };
}

/** A stored value that has the shape of a judge result, or nothing. Arrays are checked one level deep. */
function asJudgeResult(value: unknown): JudgeResult | undefined {
  if (typeof field(value, "judged_at") !== "string" || typeof field(value, "prompt_hash") !== "string") return undefined;
  const outcome = field(value, "outcome");
  if (outcome === "failed") {
    const reason = field(value, "reason");
    const model = field(value, "model");
    if (typeof reason !== "string" || !FAILURES.includes(reason)) return undefined;
    if (model !== undefined && typeof model !== "string") return undefined;
    return value as FailedResult;
  }
  if (outcome !== "judged") return undefined;
  const statements = field(value, "statements");
  const results = field(value, "results");
  const accuracy = field(value, "accuracy");
  const mode = field(value, "mode");
  if (typeof field(value, "model") !== "string" || typeof field(value, "effort") !== "string") return undefined;
  if (mode !== "timed" && mode !== "coarse") return undefined;
  if (typeof field(value, "dropped") !== "number" || !isRecord(field(value, "usage"))) return undefined;
  if (accuracy !== null && !isRecord(accuracy)) return undefined;
  if (!Array.isArray(statements) || !(statements as unknown[]).every((s) => isRecord(s) && typeof s.declared === "boolean")) return undefined;
  if (!Array.isArray(results) || !(results as unknown[]).every((r) => isRecord(r) && typeof r.verdict === "string" && VERDICTS.includes(r.verdict))) return undefined;
  return value as JudgedResult;
}

/** The read's summary over a post's assistant turns, `turn` being the seq; "pending" while any result is null or not a judge result. */
export function summarizeJudgments(judgments: readonly { turn: number; result: unknown }[]): "pending" | UndeclaredSummary {
  const summary: UndeclaredSummary = {
    checked_turns: 0, failed_turns: 0, statements: 0, declared: 0,
    undeclared: { total: 0, backed: 0, unbacked: 0, unresolved: 0 }, results: [], judges: [],
  };
  const judges = new Set<string>();
  for (const { turn, result } of judgments) {
    const r = asJudgeResult(result);
    if (r === undefined) return "pending";
    if (r.outcome === "failed") { summary.failed_turns++; continue; }
    summary.checked_turns++;
    summary.statements += r.statements.length;
    summary.declared += r.statements.filter((s) => s.declared).length;
    for (const x of r.results) {
      summary.undeclared.total++;
      summary.undeclared[x.verdict]++;
      summary.results.push({ ...x, turn });
    }
    const key = JSON.stringify([r.model, r.effort, r.prompt_hash]);
    if (!judges.has(key)) {
      judges.add(key);
      summary.judges.push({ model: r.model, effort: r.effort, prompt_hash: r.prompt_hash, accuracy: r.accuracy });
    }
  }
  return summary;
}

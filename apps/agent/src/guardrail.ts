import { CLAIM_STATUSES, type AuditResult, type AuditTurn, type Claim, type StoredTurn, type UnbackedReason } from "@dastar/db";
import type { Reply } from "./reply.js";

/** A claim of the reply that its reservation does not bear out, and what the reservation is now. */
export type Violation = { reservation_id: string; claimed: string; problem: UnbackedReason | "not_current"; current_status: string };

/** Shown to the model when its output was not the reply format. */
export const UNPARSABLE_NOTICE = "Your reply was not delivered: it did not match the reply format. Reply again in that format.";

/** Shown to the model when its output was cut off at the limit. */
export const TRUNCATED_NOTICE = "Your reply was not delivered: it was cut off at the output limit. Reply again, shorter.";

const PROBLEM_TEXT: Record<Violation["problem"], string> = {
  no_observation: "no tool call in this conversation observed it",
  observed_later: "it was observed only after your reply",
  status_mismatch: "the latest observation shows another status",
  starts_at_mismatch: "the start time differs from the latest observation",
  party_size_mismatch: "the party size differs from the latest observation",
  not_current: "it is no longer current",
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A stored claim is read as data: one that is not the shape of a claim is not one. */
function isClaim(value: unknown): value is Claim {
  if (!isObject(value)) return false;
  const { reservation_id: id, status, starts_at: startsAt, party_size: partySize, quote } = value;
  return (
    typeof id === "string" &&
    typeof status === "string" &&
    CLAIM_STATUSES.some((known) => known === status) &&
    (startsAt === undefined || typeof startsAt === "string") &&
    (partySize === undefined || typeof partySize === "number") &&
    (quote === undefined || typeof quote === "string")
  );
}

/**
 * The conversation as the audit reads it: each stored turn with its time and the claims it made, then the new reply
 * as the last turn, at the given time. A stored turn without a time or without claims leaves that field out.
 */
export function auditTurns(stored: StoredTurn[], reply: Reply, at: string): AuditTurn[] {
  const turns = stored.map(
    (turn): AuditTurn => ({
      role: turn.role,
      text: turn.content,
      ...(turn.at !== null ? { at: turn.at } : {}),
      ...(turn.claims !== null ? { claims: turn.claims.filter(isClaim) } : {}),
    }),
  );
  return [...turns, { role: "assistant", text: reply.message, at, claims: reply.claims }];
}

/**
 * The claims of one turn that fail: one the session's calls do not back, or one that was backed but is no longer
 * what the reservation is. Claims of other turns are not looked at.
 */
export function judgeReply(result: AuditResult, turn: number): Violation[] {
  const violations: Violation[] = [];
  for (const checked of result.results) {
    if (checked.turn !== turn) continue;
    // an unbacked result always names its reason; without one it is read as no observation, so it still fails
    const problem = checked.verdict === "unbacked" ? (checked.reason ?? "no_observation") : checked.current_differs ? "not_current" : undefined;
    if (problem === undefined) continue;
    violations.push({
      reservation_id: checked.claim.reservation_id,
      claimed: checked.claim.status,
      problem,
      current_status: checked.current_status,
    });
  }
  return violations;
}

/** What the model is told when its reply was held back: each failing claim, why, and what the reservation is now. */
export function violationNotice(violations: Violation[]): string {
  const lines = violations.map(
    (violation) =>
      `- ${violation.reservation_id}: you said ${violation.claimed}; ${PROBLEM_TEXT[violation.problem]}; its status now is ${violation.current_status}.`,
  );
  return [
    "Your reply was not delivered. Each claim must match what your tool calls in this conversation observed and the reservation's status now. Failing claims:",
    ...lines,
    "Read the reservation again if you need to, then reply again.",
  ].join("\n");
}

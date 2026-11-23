import { describe, it, expect } from "vitest";
import { auditSession, type AuditReceipt, type LoggedCall, type StoredTurn } from "@dastar/db";
import { auditTurns, judgeReply, violationNotice, TRUNCATED_NOTICE, UNPARSABLE_NOTICE, type Violation } from "../src/guardrail.js";
import type { Reply, ReplyClaim } from "../src/reply.js";

const S = "0199b000-0000-7000-8000-000000000000";
const R1 = "0199b000-0000-7000-8000-00000000000a";
const R2 = "0199b000-0000-7000-8000-00000000000b";
const U = "0199b000-0000-7000-8000-00000000000c";
const T = (s: number): string => new Date(Date.UTC(2064, 0, 7, 16, 0, s)).toISOString();
const STARTS = "2064-01-07T19:00:00Z";
const EXP = "2064-01-07T16:10:00.000Z";

const receipt = (id: string, status: string, audit: number): AuditReceipt => ({ reservation_id: id, status, version: 1, audit_id: audit, trace_id: `t-${audit}` });
const hold = (id: number, at: string, reservationId: string): LoggedCall => ({
  id,
  tool: "hold",
  input: { party_size: 2, starts_at: STARTS, duration_minutes: 90, assignment: { kind: "unit", id: U }, idempotency_key: `k${id}` },
  status: 201,
  output: { hold_expires_at: EXP, replayed: false },
  receipt: receipt(reservationId, "held", id * 10),
  receiptVerified: true,
  completedAt: at,
});
const claim = (over: Partial<ReplyClaim> = {}): ReplyClaim => ({ reservation_id: R1, status: "held", starts_at: STARTS, party_size: 2, ...over });
const reply = (...claims: ReplyClaim[]): Reply => ({ message: "Held.", claims });
const userTurn = (seq: number, at: string | null): StoredTurn => ({ seq, role: "user", content: "hi", claims: null, at });

/** The audit of one new reply after the stored turns, as the turn runs it. */
function judge(calls: LoggedCall[], stored: StoredTurn[], next: Reply, at: string, current: Record<string, string>): Violation[] {
  const turns = auditTurns(stored, next, at);
  const result = auditSession({ sessionId: S, auditedAt: T(59), calls, turns, current });
  return judgeReply(result, stored.length);
}

describe("auditTurns", () => {
  it("gives every stored turn and the reply, with their times", () => {
    const c = claim();
    const stored: StoredTurn[] = [
      { seq: 1, role: "user", content: "a table for two", claims: null, at: T(1) },
      { seq: 2, role: "assistant", content: "Let me check.", claims: [c], at: T(2) },
    ];
    expect(auditTurns(stored, reply(claim({ status: "confirmed" })), T(5))).toEqual([
      { role: "user", text: "a table for two", at: T(1) },
      { role: "assistant", text: "Let me check.", at: T(2), claims: [c] },
      { role: "assistant", text: "Held.", at: T(5), claims: [claim({ status: "confirmed" })] },
    ]);
  });

  it("leaves out a time or claims a stored turn does not have, and drops a stored claim that is not one", () => {
    const stored: StoredTurn[] = [
      { seq: 1, role: "assistant", content: "x", claims: null, at: null },
      { seq: 2, role: "assistant", content: "y", claims: [claim(), { reservation_id: R2, status: "pending" }, 7, null, { status: "held" }], at: T(2) },
    ];
    const turns = auditTurns(stored, reply(), T(5));
    expect(turns[0]).toEqual({ role: "assistant", text: "x" });
    expect(turns[1]).toEqual({ role: "assistant", text: "y", at: T(2), claims: [claim()] });
  });
});

describe("judgeReply", () => {
  it("judges only the new reply's claims", () => {
    const stored: StoredTurn[] = [
      userTurn(1, T(0)),
      { seq: 2, role: "assistant", content: "Held both.", claims: [claim({ reservation_id: R2 })], at: T(2) },
    ];
    expect(judge([hold(1, T(1), R1)], stored, reply(claim()), T(5), { [R1]: "held" })).toEqual([]);
  });

  it("an unbacked claim is a violation naming its reason", () => {
    const stored = [userTurn(1, T(0))];
    const current = { [R1]: "held" };
    const violation = (problem: Violation["problem"], claimed = "held"): Violation => ({ reservation_id: R1, claimed, problem, current_status: "held" });

    expect(judge([], stored, reply(claim()), T(5), current)).toEqual([violation("no_observation")]);
    expect(judge([hold(1, T(10), R1)], stored, reply(claim()), T(5), current)).toEqual([violation("observed_later")]);
    expect(judge([hold(1, T(1), R1)], stored, reply(claim({ status: "confirmed" })), T(5), current)).toEqual([violation("status_mismatch", "confirmed")]);
    expect(judge([hold(1, T(1), R1)], stored, reply(claim({ starts_at: "2064-01-07T20:00:00Z" })), T(5), current)).toEqual([violation("starts_at_mismatch")]);
    expect(judge([hold(1, T(1), R1)], stored, reply(claim({ party_size: 3 })), T(5), current)).toEqual([violation("party_size_mismatch")]);
  });

  it("a backed claim whose status is not the current one is not_current", () => {
    const stored = [userTurn(1, T(0))];
    expect(judge([hold(1, T(1), R1)], stored, reply(claim()), T(5), { [R1]: "confirmed" })).toEqual([
      { reservation_id: R1, claimed: "held", problem: "not_current", current_status: "confirmed" },
    ]);
    expect(judge([hold(1, T(1), R1)], stored, reply(claim()), T(5), {})).toEqual([
      { reservation_id: R1, claimed: "held", problem: "not_current", current_status: "unknown" },
    ]);
  });

  it("a reply whose claims are all backed and current has no violations", () => {
    expect(judge([hold(1, T(1), R1)], [userTurn(1, T(0))], reply(claim()), T(5), { [R1]: "held" })).toEqual([]);
    expect(judge([], [userTurn(1, T(0))], reply(), T(5), {})).toEqual([]);
  });
});

describe("violationNotice", () => {
  it("names each failing claim", () => {
    const violations: Violation[] = [
      { reservation_id: R1, claimed: "held", problem: "no_observation", current_status: "held" },
      { reservation_id: R2, claimed: "confirmed", problem: "not_current", current_status: "cancelled" },
    ];
    expect(violationNotice(violations)).toBe(
      [
        "Your reply was not delivered. Each claim must match what your tool calls in this conversation observed and the reservation's status now. Failing claims:",
        `- ${R1}: you said held; no tool call in this conversation observed it; its status now is held.`,
        `- ${R2}: you said confirmed; it is no longer current; its status now is cancelled.`,
        "Read the reservation again if you need to, then reply again.",
      ].join("\n"),
    );
  });

  it("gives each problem its own sentence", () => {
    const text: Record<Violation["problem"], string> = {
      no_observation: "no tool call in this conversation observed it",
      observed_later: "it was observed only after your reply",
      status_mismatch: "the latest observation shows another status",
      starts_at_mismatch: "the start time differs from the latest observation",
      party_size_mismatch: "the party size differs from the latest observation",
      not_current: "it is no longer current",
    };
    for (const [problem, sentence] of Object.entries(text)) {
      const notice = violationNotice([{ reservation_id: R1, claimed: "held", problem: problem as Violation["problem"], current_status: "held" }]);
      expect(notice, problem).toContain(`- ${R1}: you said held; ${sentence}; its status now is held.`);
    }
  });

  it("the notices for an unparsable and a truncated reply", () => {
    expect(UNPARSABLE_NOTICE).toBe("Your reply was not delivered: it did not match the reply format. Reply again in that format.");
    expect(TRUNCATED_NOTICE).toBe("Your reply was not delivered: it was cut off at the output limit. Reply again, shorter.");
  });
});

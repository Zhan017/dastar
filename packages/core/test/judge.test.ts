import { describe, it, expect } from "vitest";
import {
  assembleJudgment, isDeclared, observedReservations, quoteOccurs, screenStatements, statementClaim, summarizeJudgments,
  type AuditReceipt, type Claim, type Interval, type JudgeAccuracy, type JudgedResult, type JudgeStatement, type LoggedCall,
  type StatementResult,
} from "../src/index.js";

const R1 = "0199b000-0000-7000-8000-00000000000a", R2 = "0199b000-0000-7000-8000-00000000000b", R3 = "0199b000-0000-7000-8000-00000000000c";
const T = (s: number): string => new Date(Date.UTC(2064, 0, 7, 16, 0, s)).toISOString();
const STARTS = "2064-01-07T19:00:00Z";
const STARTS2 = "2064-01-07T20:00:00Z";
const EXP = "2064-01-07T16:10:00.000Z";
const rc = (id: string, status: string, version: number, audit: number): AuditReceipt => ({ reservation_id: id, status, version, audit_id: audit, trace_id: `t-${audit}` });
const call = (id: number, tool: string, at: string | null, over: Partial<LoggedCall> = {}): LoggedCall =>
  ({ id, tool, input: {}, status: at === null ? null : 200, output: at === null ? null : {}, receipt: null, receiptVerified: null, completedAt: at, ...over });
const hold = (id: number, at: string | null, rid: string, over: Partial<LoggedCall> = {}): LoggedCall => call(id, "hold", at, {
  status: 201, input: { party_size: 2, starts_at: STARTS, duration_minutes: 90, assignment: { kind: "unit", id: R3 }, idempotency_key: `k${id}` },
  output: { hold_expires_at: EXP, replayed: false }, receipt: rc(rid, "held", 1, id * 10), receiptVerified: true, ...over,
});
const cancel = (id: number, at: string, rid: string): LoggedCall =>
  call(id, "cancel", at, { input: { reservation_id: rid }, receipt: rc(rid, "cancelled", 2, id * 10), receiptVerified: true });

const RATE: Interval = { value: 0.8, low: 0.6, high: 0.9, k: 8, n: 10 };
const ACCURACY: JudgeAccuracy = { run: "run-1", labeled_set: "held-out", undeclared: { precision: RATE, recall: RATE }, all: { precision: RATE, recall: RATE } };
const STAMP = {
  model: "claude-opus-5-5", effort: "medium", prompt_hash: "hash-a", accuracy: ACCURACY as JudgeAccuracy | null,
  usage: { input: 120, output: 30, cache_read: 40, cache_write: 7 },
};
const st = (quote: string, over: Partial<JudgeStatement> = {}): JudgeStatement =>
  ({ quote, reservation_id: R1, status: "confirmed", starts_at: null, party_size: null, ...over });
const turnsAt = (user: string | null, assistant: string | null) => [
  { seq: 0, role: "user" as const, at: user }, { seq: 1, role: "assistant" as const, at: assistant },
];
const assemble = (over: Partial<Parameters<typeof assembleJudgment>[0]>) => assembleJudgment({
  sessionId: "0199b000-0000-7000-8000-000000000000", seq: 1, text: "", claims: [], turns: turnsAt(T(2), T(5)), calls: [], current: {},
  judgedAt: T(59), statements: [], stamp: STAMP, ...over,
});

describe("observedReservations", () => {
  it("lists each reservation the calls showed, in the order first seen, with the latest start and party size", () => {
    const calls = [
      hold(1, T(1), R1),
      call(2, "get_reservation", T(2), { input: { reservation_id: R1 }, output: { id: R1, status: "held", party_size: 3 } }),
      call(3, "list_holds", T(3), { output: { holds: [{ id: R2, starts_at: STARTS2, party_size: 4, hold_expires_at: EXP }] } }),
    ];
    expect(observedReservations(calls)).toEqual([
      { id: R1, starts_at: STARTS, party_size: 3 },
      { id: R2, starts_at: STARTS2, party_size: 4 },
    ]);
  });

  it("a hold that did not succeed and a call that never completed show nothing", () => {
    expect(observedReservations([
      hold(1, T(1), R1, { status: 409 }),
      hold(2, null, R2),
    ])).toEqual([]);
  });

  it("lowercases ids, orders by completion, and carries a change's earlier start and party size", () => {
    const upper = R1.toUpperCase();
    const calls = [
      cancel(3, T(9), upper),
      hold(2, T(5), upper),
      call(1, "list_holds", T(6), { output: { holds: [{ id: R2 }] } }),
    ];
    expect(observedReservations(calls)).toEqual([
      { id: R1, starts_at: STARTS, party_size: 2 },
      { id: R2 },
    ]);
  });
});

describe("quoteOccurs", () => {
  it("ignores case and runs of whitespace", () => {
    expect(quoteOccurs("your  table\nis confirmed.", "Your table is CONFIRMED")).toBe(true);
    expect(quoteOccurs("your table is confirmed", "Your\u00a0table is confirmed")).toBe(true);
    const escaped = "\\u003c/b>";
    expect(escaped.startsWith("\\")).toBe(true);
    expect(escaped.length).toBe(9);
    expect(quoteOccurs("</b>", escaped)).toBe(true);
    expect(quoteOccurs("</b>", "\\u003C/b>")).toBe(true);
    expect(quoteOccurs("your table is confirmed", "")).toBe(false);
    expect(quoteOccurs("your table is confirmed", "  ")).toBe(false);
    expect(quoteOccurs("your table is confirmed", "the booking is set")).toBe(false);
  });
});

describe("isDeclared", () => {
  it("the declared test compares instants", () => {
    const statement = statementClaim(st("q", { starts_at: "2064-01-07T18:00:00+01:00" }));
    const claim: Claim = { reservation_id: R1, status: "confirmed", starts_at: "2064-01-07T17:00:00Z" };
    expect(isDeclared(statement, [claim])).toBe(true);
    expect(isDeclared(statement, [{ ...claim, status: "held" }])).toBe(false);
    expect(isDeclared(statement, [{ ...claim, starts_at: "2064-01-07T17:30:00Z" }])).toBe(false);
    expect(isDeclared(statementClaim(st("q", { party_size: 2 })), [{ reservation_id: R1, status: "confirmed", party_size: 4 }])).toBe(false);
    expect(isDeclared(statementClaim(st("q", { party_size: 4 })), [{ reservation_id: R1, status: "confirmed", party_size: 4 }])).toBe(true);
    expect(isDeclared(statementClaim(st("q")), [claim])).toBe(true);
    expect(isDeclared(statementClaim(st("q", { reservation_id: null })), [claim])).toBe(false);
    expect(isDeclared(statementClaim(st("q", { reservation_id: R2 })), [claim])).toBe(false);
    expect(isDeclared(statementClaim(st("q", { reservation_id: R1.toUpperCase() })), [claim])).toBe(true);
  });

  it("statementClaim leaves out a null start and party size", () => {
    const claim = statementClaim(st("q"));
    expect(claim).toEqual({ reservation_id: R1, status: "confirmed" });
    expect("starts_at" in claim).toBe(false);
    expect("party_size" in claim).toBe(false);
    expect(statementClaim(st("q", { starts_at: STARTS, party_size: 2 }))).toEqual({ reservation_id: R1, status: "confirmed", starts_at: STARTS, party_size: 2 });
  });
});

describe("screenStatements", () => {
  it("drops a quote not in the text and nulls an unknown id", () => {
    const text = "Your table is confirmed for 4 people tonight.";
    const out = screenStatements(text, [
      st("your table is CONFIRMED", { party_size: null }),
      st("the booking is settled"),
      st("for 4 people", { reservation_id: R3, status: "held", party_size: 4 }),
      st("tonight", { reservation_id: null, status: "held" }),
    ], new Set([R1]));
    expect(out.dropped).toBe(1);
    expect(out.kept.map((k) => k.quote)).toEqual(["your table is CONFIRMED", "for 4 people", "tonight"]);
    expect(out.kept[0]!.claim).toEqual({ reservation_id: R1, status: "confirmed" });
    expect("starts_at" in out.kept[0]!.claim).toBe(false);
    expect("party_size" in out.kept[0]!.claim).toBe(false);
    expect(out.kept[1]!.claim).toEqual({ reservation_id: null, status: "held", party_size: 4 });
    expect(out.kept[2]!.claim).toEqual({ reservation_id: null, status: "held" });
  });
});

describe("assembleJudgment", () => {
  it("lists every statement and judges only the undeclared", () => {
    const text = "Your table is confirmed. The hold is still active.";
    const r = assemble({
      text, calls: [hold(1, T(1), R1)], claims: [{ reservation_id: R1, status: "confirmed" }], current: { [R1]: "held" },
      statements: [st("Your table is confirmed"), st("The hold is still active", { status: "held" })],
    });
    expect(r.statements).toEqual([
      { quote: "Your table is confirmed", claim: { reservation_id: R1, status: "confirmed" }, declared: true },
      { quote: "The hold is still active", claim: { reservation_id: R1, status: "held" }, declared: false },
    ]);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]!.quote).toBe("The hold is still active");
    expect(r.results[0]!.verdict).toBe("backed");
  });

  it("an undeclared statement is read against the calls as of its turn (timed)", () => {
    const r = assemble({
      text: "Your table is confirmed", calls: [hold(1, T(1), R1)], current: { [R1]: "confirmed" },
      statements: [st("Your table is confirmed")],
    });
    expect(r.mode).toBe("timed");
    expect(r.results).toEqual([{
      quote: "Your table is confirmed", claim: { reservation_id: R1, status: "confirmed" }, verdict: "unbacked", reason: "status_mismatch",
      observed: { call: 1, tool: "hold", at: T(1), status: "held", effective_status: "held", starts_at: STARTS, party_size: 2, hold_expires_at: EXP },
      current_status: "confirmed", current_differs: true,
    }]);
  });

  it("reads each statement against the turn's time, not the log's end", () => {
    const r = assemble({
      text: "Your table is held", calls: [hold(1, T(1), R1), cancel(2, T(20), R1)], current: { [R1]: "cancelled" },
      statements: [st("Your table is held", { status: "held", starts_at: "2064-01-07T20:00:00+01:00", party_size: 2 })],
    });
    expect(r.mode).toBe("timed");
    expect(r.results[0]).toMatchObject({ verdict: "backed", observed: { call: 1, status: "held" }, current_status: "cancelled", current_differs: true });
  });

  it("without a time on every turn the verdicts are coarse", () => {
    const r = assemble({
      text: "Your table is held", calls: [hold(1, T(1), R1), cancel(2, T(20), R1)], turns: turnsAt(null, null), current: { [R1]: "cancelled" },
      statements: [st("Your table is held", { status: "held" })],
    });
    expect(r.mode).toBe("coarse");
    expect(r.results[0]).toMatchObject({
      verdict: "unbacked", reason: "status_mismatch", observed: { call: 2, tool: "cancel", status: "cancelled" }, current_status: "cancelled", current_differs: false,
    });
    expect(assemble({ turns: turnsAt(T(2), null) }).mode).toBe("coarse");
  });

  it("a statement with no reservation is no_observation when the session observed none, else unresolved", () => {
    const statements = [st("Your table is held", { reservation_id: null, status: "held" })];
    const none = assemble({ text: "Your table is held", statements });
    expect(none.results).toEqual([{ quote: "Your table is held", claim: { reservation_id: null, status: "held" }, verdict: "unbacked", reason: "no_observation" }]);
    const some = assemble({ text: "Your table is held", statements, calls: [hold(1, T(1), R1)] });
    expect(some.results).toEqual([{ quote: "Your table is held", claim: { reservation_id: null, status: "held" }, verdict: "unresolved" }]);
    const result: StatementResult = some.results[0]!;
    expect("reason" in result).toBe(false);
    expect("current_status" in result).toBe(false);
    expect("current_differs" in result).toBe(false);
  });

  it("an unknown id and an id-less statement keep their places among the results", () => {
    const r = assemble({
      text: "A is confirmed. B is held. C is held.", calls: [hold(1, T(1), R1)], current: { [R1]: "held" },
      statements: [st("B is held", { reservation_id: null, status: "held" }), st("C is held", { status: "held" }), st("A is confirmed", { reservation_id: R2 })],
    });
    expect(r.results.map((x) => [x.quote, x.verdict])).toEqual([["B is held", "unresolved"], ["C is held", "backed"], ["A is confirmed", "unresolved"]]);
  });

  it("carries the stamp, judged_at and dropped", () => {
    const r = assemble({ text: "Your table is confirmed", calls: [hold(1, T(1), R1)], statements: [st("Your table is confirmed"), st("nothing like it")] });
    expect(r.outcome).toBe("judged");
    expect(r.judged_at).toBe(T(59));
    expect(r.dropped).toBe(1);
    expect(r.model).toBe(STAMP.model);
    expect(r.effort).toBe(STAMP.effort);
    expect(r.prompt_hash).toBe(STAMP.prompt_hash);
    expect(r.accuracy).toEqual(ACCURACY);
    expect(r.usage).toEqual(STAMP.usage);
    expect(assemble({ stamp: { ...STAMP, accuracy: null } }).accuracy).toBeNull();
  });
});

const judged = (over: Partial<JudgedResult> = {}): JudgedResult => ({
  outcome: "judged", judged_at: T(59), model: STAMP.model, effort: STAMP.effort, prompt_hash: STAMP.prompt_hash, mode: "timed",
  statements: [], dropped: 0, results: [], accuracy: ACCURACY, usage: STAMP.usage, ...over,
});
const claimOf = { reservation_id: R1, status: "confirmed" as const };
const backed: StatementResult = { quote: "a", claim: claimOf, verdict: "backed", current_status: "confirmed", current_differs: false };
const unbacked: StatementResult = { quote: "b", claim: claimOf, verdict: "unbacked", reason: "no_observation", current_status: "unknown", current_differs: false };
const unresolved: StatementResult = { quote: "c", claim: { reservation_id: null, status: "held" }, verdict: "unresolved" };

describe("summarizeJudgments", () => {
  it("is pending while a result is missing", () => {
    expect(summarizeJudgments([{ turn: 1, result: judged() }, { turn: 3, result: null }])).toBe("pending");
    expect(summarizeJudgments([{ turn: 1, result: { foo: 1 } }])).toBe("pending");
    expect(summarizeJudgments([{ turn: 1, result: { outcome: "judged" } }])).toBe("pending");
  });

  it("counts statements, verdicts and failed turns, and lists each judge once", () => {
    const first = judged({
      statements: [
        { quote: "a", claim: claimOf, declared: true }, { quote: "b", claim: claimOf, declared: false },
      ],
      results: [backed],
    });
    const second = judged({
      statements: [{ quote: "b", claim: claimOf, declared: false }, { quote: "c", claim: unresolved.claim, declared: false }],
      results: [unbacked, unresolved],
    });
    const failed = { outcome: "failed", judged_at: T(59), prompt_hash: "hash-a", reason: "refused" };
    const summary = summarizeJudgments([{ turn: 1, result: first }, { turn: 3, result: second }, { turn: 5, result: failed }]);
    expect(summary).toEqual({
      checked_turns: 2, failed_turns: 1, statements: 4, declared: 1,
      undeclared: { total: 3, backed: 1, unbacked: 1, unresolved: 1 },
      results: [{ ...backed, turn: 1 }, { ...unbacked, turn: 3 }, { ...unresolved, turn: 3 }],
      judges: [{ model: STAMP.model, effort: STAMP.effort, prompt_hash: "hash-a", accuracy: ACCURACY }],
    });

    const other = judged({ prompt_hash: "hash-b", accuracy: null });
    const more = summarizeJudgments([{ turn: 1, result: first }, { turn: 3, result: other }, { turn: 5, result: second }]);
    expect(more).not.toBe("pending");
    if (more === "pending") return;
    expect(more.checked_turns).toBe(3);
    expect(more.judges).toEqual([
      { model: STAMP.model, effort: STAMP.effort, prompt_hash: "hash-a", accuracy: ACCURACY },
      { model: STAMP.model, effort: STAMP.effort, prompt_hash: "hash-b", accuracy: null },
    ]);
  });

  it("counts a failed result with a reason it does not list as a failed turn, not as pending", () => {
    const failed = { outcome: "failed", judged_at: T(59), prompt_hash: "hash-a", reason: "a_reason_added_later" };
    const summary = summarizeJudgments([{ turn: 1, result: judged() }, { turn: 3, result: failed }]);
    expect(summary).not.toBe("pending");
    if (summary === "pending") return;
    expect(summary.failed_turns).toBe(1);
    expect(summary.checked_turns).toBe(1);
    // a failure with no reason at all is not a result
    expect(summarizeJudgments([{ turn: 1, result: { outcome: "failed", judged_at: T(59), prompt_hash: "hash-a" } }])).toBe("pending");
  });

  it("over no assistant turns is all zeros", () => {
    expect(summarizeJudgments([])).toEqual({
      checked_turns: 0, failed_turns: 0, statements: 0, declared: 0,
      undeclared: { total: 0, backed: 0, unbacked: 0, unresolved: 0 }, results: [], judges: [],
    });
  });
});

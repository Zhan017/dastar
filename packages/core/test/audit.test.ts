import { describe, it, expect } from "vitest";
import { auditSession, type AuditReceipt, type AuditTurn, type Claim, type LoggedCall } from "../src/index.js";

const S = "0199b000-0000-7000-8000-000000000000";
const R1 = "0199b000-0000-7000-8000-00000000000a", R2 = "0199b000-0000-7000-8000-00000000000b", R3 = "0199b000-0000-7000-8000-00000000000c";
const T = (s: number): string => new Date(Date.UTC(2064, 0, 7, 16, 0, s)).toISOString();
const STARTS = "2064-01-07T19:00:00Z";
const EXP = "2064-01-07T16:10:00.000Z";
const rc = (id: string, status: string, version: number, audit: number): AuditReceipt => ({ reservation_id: id, status, version, audit_id: audit, trace_id: `t-${audit}` });
const call = (id: number, tool: string, at: string | null, over: Partial<LoggedCall> = {}): LoggedCall =>
  ({ id, tool, input: {}, status: at === null ? null : 200, output: at === null ? null : {}, receipt: null, receiptVerified: null, completedAt: at, ...over });
const hold = (id: number, at: string, rid: string, over: Partial<LoggedCall> = {}): LoggedCall => call(id, "hold", at, {
  status: 201, input: { party_size: 2, starts_at: STARTS, duration_minutes: 90, assignment: { kind: "unit", id: R3 }, idempotency_key: `k${id}` },
  output: { hold_expires_at: EXP, replayed: false }, receipt: rc(rid, "held", 1, id * 10), receiptVerified: true, ...over,
});
const change = (id: number, tool: "cancel" | "seat" | "complete" | "confirm", at: string, rid: string, status: string, version: number): LoggedCall =>
  call(id, tool, at, { input: { reservation_id: rid }, receipt: rc(rid, status, version, id * 10), receiptVerified: true });
const said = (at: string | undefined, ...claims: Claim[]): AuditTurn => ({ role: "assistant", text: "ok", ...(at !== undefined ? { at } : {}), claims });
const run = (calls: LoggedCall[], turns: AuditTurn[], current: Record<string, string> = {}) =>
  auditSession({ sessionId: S, auditedAt: T(59), calls, turns, current });

describe("auditSession", () => {
  it("backs a claim that matches the latest observation as of its turn", () => {
    const claim: Claim = { reservation_id: R1, status: "held", starts_at: STARTS, party_size: 2 };
    const r = run([hold(1, T(1), R1)], [said(T(5), claim)], { [R1]: "held" });
    expect(r.mode).toBe("timed");
    expect(r.results).toEqual([{
      turn: 0, claim, verdict: "backed",
      observed: { call: 1, tool: "hold", at: T(1), status: "held", effective_status: "held", starts_at: STARTS, party_size: 2, hold_expires_at: EXP },
      receipts: [rc(R1, "held", 1, 10)], current_status: "held", current_differs: false,
    }]);
    expect(r.claims).toEqual({ total: 1, backed: 1, unbacked: 0 });
  });

  it("a claim of confirmed after an observed held is unbacked", () => {
    const r = run([hold(1, T(1), R1)], [said(T(5), { reservation_id: R1, status: "confirmed" })], { [R1]: "held" });
    expect(r.results[0]!.verdict).toBe("unbacked");
    expect(r.results[0]!.reason).toBe("status_mismatch");
    expect(r.results[0]!.observed!.status).toBe("held");
    expect(r.claims).toEqual({ total: 1, backed: 0, unbacked: 1 });
  });

  it("the only observation completed after the turn is observed_later, and carries it", () => {
    const r = run([hold(1, T(3), R1)], [said(T(2), { reservation_id: R1, status: "held" })]);
    const result = r.results[0]!;
    expect(result.verdict).toBe("unbacked");
    expect(result.reason).toBe("observed_later");
    expect(result.observed).toMatchObject({ call: 1, tool: "hold", at: T(3), status: "held" });
    expect(result.receipts).toEqual([]);
    expect(result.current_differs).toBe(false);
  });

  it("a reservation the session never observed is no_observation, and its current status reads unknown when it is not found", () => {
    const r = run([hold(1, T(1), R1)], [said(T(5), { reservation_id: R3, status: "held" })], {});
    const result = r.results[0]!;
    expect(result.verdict).toBe("unbacked");
    expect(result.reason).toBe("no_observation");
    expect("observed" in result).toBe(false);
    expect(result.receipts).toEqual([]);
    expect(result.current_status).toBe("unknown");
    expect(result.current_differs).toBe(false);
  });

  it("compares starts_at as instants", () => {
    const calls = [hold(1, T(1), R1)];
    const same = run(calls, [said(T(5), { reservation_id: R1, status: "held", starts_at: "2064-01-07T20:00:00+01:00" })]);
    expect(same.results[0]!.verdict).toBe("backed");
    const other = run(calls, [said(T(5), { reservation_id: R1, status: "held", starts_at: "2064-01-07T19:30:00Z" })]);
    expect(other.results[0]!.reason).toBe("starts_at_mismatch");
  });

  it("a party size that differs is party_size_mismatch, and status outranks it", () => {
    const calls = [hold(1, T(1), R1)];
    const reasons = (claim: Claim): (string | undefined)[] => run(calls, [said(T(5), claim)]).results.map((x) => x.reason);
    expect(reasons({ reservation_id: R1, status: "held", party_size: 3 })).toEqual(["party_size_mismatch"]);
    expect(reasons({ reservation_id: R1, status: "confirmed", party_size: 3 })).toEqual(["status_mismatch"]);
    expect(reasons({ reservation_id: R1, status: "held", starts_at: "2064-01-07T19:30:00Z", party_size: 3 })).toEqual(["starts_at_mismatch"]);
  });

  it("a held observation whose expiry is at or before the turn counts as expired", () => {
    const calls = [hold(1, T(1), R1, { output: { hold_expires_at: T(30), replayed: false } })];
    const held = run(calls, [said(T(30), { reservation_id: R1, status: "held" })]).results[0]!;
    expect(held.reason).toBe("status_mismatch");
    expect(held.observed!.status).toBe("held");
    expect(held.observed!.effective_status).toBe("expired");
    expect(run(calls, [said(T(30), { reservation_id: R1, status: "expired" })]).results[0]!.verdict).toBe("backed");
    expect(run(calls, [said("2064-01-07T16:00:29.999Z", { reservation_id: R1, status: "held" })]).results[0]!.verdict).toBe("backed");
  });

  it("coarse mode matches the latest observation in the session, at the last call's completion", () => {
    const calls = [
      hold(1, T(1), R1, { output: { hold_expires_at: T(30), replayed: false } }),
      hold(2, T(2), R2),
      change(3, "cancel", T(40), R2, "cancelled", 2),
    ];
    const r = run(calls, [said(undefined,
      { reservation_id: R1, status: "held" }, { reservation_id: R1, status: "expired" },
      { reservation_id: R2, status: "cancelled" }, { reservation_id: R2, status: "held" },
    )]);
    expect(r.mode).toBe("coarse");
    expect(r.results.map((x) => x.reason)).toEqual(["status_mismatch", undefined, undefined, "status_mismatch"]);
    expect(r.results.map((x) => x.verdict)).toEqual(["unbacked", "backed", "backed", "unbacked"]);
    expect(r.results[0]!.observed!.effective_status).toBe("expired");
    expect(r.results.some((x) => x.reason === "observed_later")).toBe(false);
  });

  it("a status change carries starts_at, party size, and expiry forward from the previous observation", () => {
    const r = run(
      [hold(2, T(2), R2), change(3, "cancel", T(4), R2, "cancelled", 2)],
      [said(T(5), { reservation_id: R2, status: "cancelled", starts_at: STARTS, party_size: 2 })],
    );
    expect(r.results[0]!.verdict).toBe("backed");
    expect(r.results[0]!.observed).toEqual({
      call: 3, tool: "cancel", at: T(4), status: "cancelled", effective_status: "cancelled", starts_at: STARTS, party_size: 2, hold_expires_at: EXP,
    });
  });

  it("a status change with no earlier observation carries nothing", () => {
    const r = run([change(1, "cancel", T(1), R1, "cancelled", 2)], [said(T(5), { reservation_id: R1, status: "cancelled", starts_at: STARTS })]);
    expect(r.results[0]!.reason).toBe("starts_at_mismatch");
    expect("starts_at" in r.results[0]!.observed!).toBe(false);
  });

  it("a pending hold and its replay", () => {
    const r = run(
      [call(1, "hold", null), hold(2, T(2), R1, { output: { hold_expires_at: EXP, replayed: true } })],
      [said(T(5), { reservation_id: R1, status: "held" })],
    );
    expect(r.results[0]!.verdict).toBe("backed");
    expect(r.results[0]!.observed!.replayed).toBe(true);
    expect(r.unknown_outcomes).toBe(1);
  });

  it("reads and lists observe; searches, refusals, and mints do not", () => {
    const first = [
      call(1, "search_availability", T(1), { output: { slots: 3, truncated: false } }),
      call(2, "hold", T(2), { status: 409, output: { code: "hold_conflict" } }),
      call(3, "confirm_token", T(3), { status: 201, input: { reservation_id: R2 }, output: { version: 1 } }),
    ];
    const calls = [
      ...first,
      call(4, "get_reservation", T(4), { output: { id: R2, status: "confirmed", starts_at: STARTS, party_size: 4, hold_expires_at: EXP, version: 2 } }),
      call(5, "list_holds", T(5), {
        output: { holds: [{ id: R1, starts_at: STARTS, party_size: 2, hold_expires_at: EXP }, { id: R3, starts_at: STARTS, party_size: 6, hold_expires_at: EXP }] },
      }),
    ];
    const claims: Claim[] = [
      { reservation_id: R2, status: "confirmed", party_size: 4 },
      { reservation_id: R1, status: "held" },
      { reservation_id: R3, status: "held", party_size: 6 },
    ];
    const r = run(calls, [said(T(6), ...claims)]);
    expect(r.results.map((x) => [x.verdict, x.observed?.tool])).toEqual([["backed", "get_reservation"], ["backed", "list_holds"], ["backed", "list_holds"]]);
    expect(run(first, [said(T(6), ...claims)]).results.map((x) => x.reason)).toEqual(["no_observation", "no_observation", "no_observation"]);
  });

  it("reports current status and flags a claim whose observation differs from it", () => {
    const r = run([hold(1, T(1), R1)], [said(T(5), { reservation_id: R1, status: "held" })], { [R1]: "confirmed" });
    expect(r.results[0]!.verdict).toBe("backed");
    expect(r.results[0]!.current_status).toBe("confirmed");
    expect(r.results[0]!.current_differs).toBe(true);
  });

  it("counts receipts, lists the unverified, counts unknown outcomes and successful confirms", () => {
    const r = run([
      hold(1, T(1), R1),
      hold(2, T(2), R2, { receiptVerified: false }),
      change(3, "cancel", T(3), R2, "cancelled", 2),
      change(4, "confirm", T(4), R1, "confirmed", 2),
      call(5, "confirm", T(9), { status: 403, output: { code: "forbidden" } }),
      call(6, "cancel", null),
    ], []);
    expect(r.receipts).toEqual({ recorded: 4, verified: 3, unverified: [{ call: 2, receipt: rc(R2, "held", 1, 20) }] });
    expect(r.confirmations).toBe(1);
    expect(r.unknown_outcomes).toBe(1);
  });

  it("each result lists its reservation's receipts recorded up to its turn", () => {
    const calls = [hold(1, T(1), R1), change(2, "cancel", T(10), R1, "cancelled", 2)];
    const r = run(calls, [said(T(5), { reservation_id: R1, status: "held" }), said(T(20), { reservation_id: R1, status: "cancelled" })]);
    expect(r.results[0]!.receipts).toEqual([rc(R1, "held", 1, 10)]);
    expect(r.results[1]!.receipts).toEqual([rc(R1, "held", 1, 10), rc(R1, "cancelled", 2, 20)]);
  });

  it("a call whose recorded fields have the wrong shape observes nothing, and nothing throws", () => {
    const r = run([
      call(1, "hold", T(1), { status: 201, input: 5, output: "x" }),
      call(2, "list_holds", T(2), { output: { holds: "x" } }),
      call(3, "get_reservation", T(3), { output: { id: R1, status: 3 } }),
      call(4, "cancel", T(4), { receipt: { reservation_id: 7 } }),
    ], [said(T(5), { reservation_id: R1, status: "held" })]);
    expect(r.results[0]!.reason).toBe("no_observation");
    expect(r.receipts.recorded).toBe(1);
    expect(r.receipts.verified).toBe(0);
    expect(r.receipts.unverified).toEqual([{ call: 4, receipt: { reservation_id: 7 } }]);
  });

  it("reservation ids compare without case", () => {
    const r = run([hold(1, T(1), R1)], [said(T(5), { reservation_id: R1.toUpperCase(), status: "held", starts_at: STARTS, party_size: 2 })], { [R1]: "held" });
    expect(r.results[0]!.verdict).toBe("backed");
    expect(r.results[0]!.receipts).toEqual([rc(R1, "held", 1, 10)]);
  });

  it("results follow the transcript with 0-based turns; user turns carry no claims; totals add up", () => {
    const c1: Claim = { reservation_id: R1, status: "held" };
    const c2: Claim = { reservation_id: R2, status: "held" };
    const c3: Claim = { reservation_id: R3, status: "held" };
    const r = run([hold(1, T(1), R1)], [
      { role: "user", text: "hi", at: T(4), claims: [c1] },
      said(T(5), c1, c2),
      said(T(6), c3),
    ]);
    expect(r.results.map((x) => x.turn)).toEqual([1, 1, 2]);
    expect(r.claims).toEqual({ total: 3, backed: 1, unbacked: 2 });
    expect(r.session_id).toBe(S);
    expect(r.audited_at).toBe(T(59));
    expect(r.undeclared).toBe("not checked");
  });
});

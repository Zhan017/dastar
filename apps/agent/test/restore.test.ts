import { describe, it, expect } from "vitest";
import type { RecordedCall } from "@dastar/db";
import { restoreFromCalls } from "../src/restore.js";

const R1 = "0199a000-0000-7000-8000-0000000000c1";
const U = "0199a000-0000-7000-8000-0000000000d1";
const STARTS = "2064-01-07T19:00:00Z";
const EXP = "2064-01-07T16:10:00.000Z";

const receipt = (id: string, status: string): Record<string, unknown> => ({ reservation_id: id, status, version: 1, audit_id: 10, trace_id: "t" });
const call = (id: number, tool: string, status: number | null, over: Partial<RecordedCall> = {}): RecordedCall => ({
  id,
  tool,
  input: {},
  status,
  output: status === null ? null : {},
  receipt: null,
  receiptVerified: null,
  startedAt: "2064-01-07T16:00:00.000Z",
  completedAt: status === null ? null : "2064-01-07T16:00:01.000Z",
  ...over,
});
const holdInput = (key: unknown): Record<string, unknown> => ({
  party_size: 2,
  starts_at: STARTS,
  duration_minutes: 90,
  assignment: { kind: "unit", id: U },
  ...(key === undefined ? {} : { idempotency_key: key }),
});
const request = { party_size: 2, starts_at: STARTS, duration_minutes: 90, assignment: { kind: "unit", id: U } };
const held = (id: number, key: string, reservationId: string): RecordedCall =>
  call(id, "hold", 201, { input: holdInput(key), output: { hold_expires_at: EXP, replayed: false }, receipt: receipt(reservationId, "held") });
/** A call whose recorded fields do not have the types the log promises. */
const odd = (recorded: RecordedCall, over: Record<string, unknown>): RecordedCall => ({ ...recorded, ...over }) as unknown as RecordedCall;

describe("restoreFromCalls", () => {
  it("rebuilds created, cancelled and hold keys from the recorded calls", () => {
    const calls: RecordedCall[] = [
      held(1, "k1", R1),
      call(2, "hold", null, { input: holdInput("k2") }),
      call(3, "hold", 409, { input: holdInput("k3"), output: { code: "hold_conflict" } }),
      call(4, "hold", 503, { input: holdInput("k4"), output: { code: "unavailable" } }),
      call(5, "hold", 409, { input: holdInput("k5"), output: { code: "serialization_conflict" } }),
      call(6, "cancel", 200, { input: { reservation_id: R1 }, receipt: receipt(R1, "cancelled") }),
      call(7, "get_reservation", 200, { input: { reservation_id: R1 }, output: { id: R1, status: "cancelled" } }),
    ];
    expect(restoreFromCalls(calls)).toEqual({
      created: [R1],
      cancelled: [R1],
      holds: [
        { request, key: "k1", outcome: { kind: "held", reservationId: R1, status: "held", expiresAt: EXP } },
        { request, key: "k2", outcome: { kind: "unanswered" } },
        { request, key: "k3", outcome: { kind: "refused" } },
        { request, key: "k4", outcome: { kind: "unanswered" } },
        { request, key: "k5", outcome: { kind: "unanswered" } },
      ],
    });
  });

  it("reads the calls in the order they were begun", () => {
    const restored = restoreFromCalls([held(2, "k2", R1), call(1, "hold", null, { input: holdInput("k1") })]);
    expect(restored.holds.map((hold) => hold.key)).toEqual(["k1", "k2"]);
  });

  it("a refusal without a code is told apart by its status alone", () => {
    const restored = restoreFromCalls([
      call(1, "hold", 502, { input: holdInput("k1"), output: {} }),
      call(2, "hold", 422, { input: holdInput("k2"), output: null }),
    ]);
    expect(restored.holds.map((hold) => hold.outcome.kind)).toEqual(["unanswered", "refused"]);
  });

  it("a cancel that was refused or did not answer cancels nothing", () => {
    const restored = restoreFromCalls([
      call(1, "cancel", 409, { input: { reservation_id: R1 }, output: { code: "version_conflict" } }),
      call(2, "cancel", null, { input: { reservation_id: R1 } }),
    ]);
    expect(restored).toEqual({ created: [], cancelled: [], holds: [] });
  });

  it("a call whose recorded fields have the wrong shape is skipped, and nothing throws", () => {
    const calls: RecordedCall[] = [
      call(1, "hold", null, { input: holdInput(undefined) }),
      odd(call(2, "hold", null), { input: 5 }),
      call(3, "hold", 201, { input: holdInput("k3"), output: { hold_expires_at: EXP }, receipt: { status: "held" } }),
      call(4, "cancel", 200, { input: { reservation_id: R1 }, receipt: null }),
      call(5, "hold", 201, { input: holdInput("k5"), output: {}, receipt: receipt(R1, "held") }),
      call(6, "hold", null, { input: { ...holdInput("k6"), party_size: "2" } }),
      call(7, "hold", null, { input: { ...holdInput("k7"), assignment: { kind: "table", id: U } } }),
      odd(call(8, "hold", 201), { input: holdInput("k8"), output: "held", receipt: 3 }),
      odd(call(9, "hold", 409), { input: holdInput("k9"), output: { code: 409 } }),
      odd(call(10, "hold", 201), { input: holdInput("k10"), status: "201" }),
    ];
    expect(restoreFromCalls(calls)).toEqual({ created: [], cancelled: [], holds: [] });
  });

  it("ids are lowercased and created once", () => {
    const upper = R1.toUpperCase();
    const calls: RecordedCall[] = [
      held(1, "k1", upper),
      held(2, "k1", R1),
      call(3, "cancel", 200, { input: { reservation_id: upper }, receipt: receipt(upper, "cancelled") }),
      call(4, "cancel", 200, { input: { reservation_id: R1 }, receipt: receipt(R1, "cancelled") }),
    ];
    const restored = restoreFromCalls(calls);
    expect(restored.created).toEqual([R1]);
    expect(restored.cancelled).toEqual([R1]);
    expect(restored.holds.map((hold) => hold.outcome)).toEqual([
      { kind: "held", reservationId: R1, status: "held", expiresAt: EXP },
      { kind: "held", reservationId: R1, status: "held", expiresAt: EXP },
    ]);
  });

  it("with no calls it restores nothing", () => {
    expect(restoreFromCalls([])).toEqual({ created: [], cancelled: [], holds: [] });
  });
});

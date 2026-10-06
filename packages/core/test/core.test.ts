import { describe, it, expect } from "vitest";
import { STATUSES, TRANSITIONS, canTransition, isTerminal, canonicalHoldRequest, sortUnitIds, DastarError, STORED_OUTCOMES, type HoldInput } from "../src/index.js";

describe("state table", () => {
  it("allows exactly the seven transitions of the design", () => {
    const allowed = STATUSES.flatMap((from) => STATUSES.filter((to) => canTransition(from, to)).map((to) => `${from}>${to}`));
    expect(allowed.sort()).toEqual(["confirmed>cancelled", "confirmed>seated", "held>cancelled", "held>confirmed", "held>expired", "seated>cancelled", "seated>completed"]);
    for (const s of STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it("has a row for every status, and only completed, cancelled and expired are terminal", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...STATUSES].sort());
    expect(STATUSES.filter(isTerminal).sort()).toEqual(["cancelled", "completed", "expired"]);
  });
});

describe("canonical hold request", () => {
  const base: HoldInput = {
    venueId: "0192F1E0-0000-7000-8000-000000000001", actor: "key:a", traceId: "t1", idempotencyKey: "k1",
    partySize: 2, startsAt: "2030-06-07T21:00:00+02:00", durationMinutes: 90, assignment: { kind: "unit", id: "0192F1E0-0000-7000-8000-0000000000AA" },
  };

  it("ignores id case, the spelling of the start time, and who asked", () => {
    const same = { ...base, venueId: base.venueId.toLowerCase(), startsAt: "2030-06-07T19:00:00.000Z", actor: "key:b", traceId: "t2", idempotencyKey: "k2", assignment: { kind: "unit" as const, id: base.assignment.id.toLowerCase() } };
    expect(canonicalHoldRequest(same)).toBe(canonicalHoldRequest(base));
  });

  it("changes with anything that changes what is booked", () => {
    for (const changed of [{ partySize: 3 }, { durationMinutes: 120 }, { startsAt: "2030-06-07T19:15:00Z" }, { externalRef: "x" }, { assignment: { kind: "combo" as const, id: base.assignment.id } }]) {
      expect(canonicalHoldRequest({ ...base, ...changed })).not.toBe(canonicalHoldRequest(base));
    }
  });
});

describe("units and errors", () => {
  it("sorts unit ids by their lowercase form and drops duplicates", () => {
    expect(sortUnitIds(["B", "a", "b", "C"])).toEqual(["a", "b", "c"]);
  });

  it("carries a stable code, and stores only domain outcomes under an idempotency key", () => {
    const e = new DastarError("hold_conflict", "taken", undefined, false, "23P01");
    expect(e).toMatchObject({ name: "DastarError", code: "hold_conflict", retryable: false, sqlstate: "23P01" });
    expect([...STORED_OUTCOMES].sort()).toEqual(["blackout", "hold_conflict", "party_does_not_fit"]);
  });
});

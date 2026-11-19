import { describe, it, expect } from "vitest";
import { recordedInput, recordedOutcome, type RecordedTool } from "../src/recorded-fields.js";

const RID = "0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8";
const UNIT = "1c2d3e4f-5061-4b72-8c83-a4b5c6d7e8f9";
const RECEIPT = { reservation_id: RID, status: "held", version: 1, audit_id: 41, trace_id: "trace-1" };
const HOLD_EXPIRES = "2046-03-01T08:10:00.000Z";

describe("the fields a recorded call stores", () => {
  it("hold: the request's party, time, assignment, and idempotency key; the answer's expiry and replay flag, with the receipt", () => {
    const json = {
      party_size: 2, starts_at: "2046-03-01T09:00:00+01:00", duration_minutes: 60, assignment: { kind: "unit", id: UNIT }, external_ref: "Jane Doe +49 30 1234567",
    };
    expect(recordedInput("hold", { param: { id: UNIT }, json, header: { "idempotency-key": "k-1", "dastar-session": RID } })).toEqual({
      party_size: 2, starts_at: "2046-03-01T09:00:00+01:00", duration_minutes: 60, assignment: { kind: "unit", id: UNIT }, idempotency_key: "k-1",
    });
    expect(recordedOutcome("hold", 201, { receipt: RECEIPT, hold_expires_at: HOLD_EXPIRES, replayed: false })).toEqual({
      output: { hold_expires_at: HOLD_EXPIRES, replayed: false }, receipt: RECEIPT,
    });
  });

  it("search_availability: the party and window; the number of slots and whether the list was cut short", () => {
    const json = { party_size: 4, from: "2046-03-01T08:00:00Z", to: "2046-03-01T12:00:00Z", limit: 5 };
    expect(recordedInput("search_availability", { param: { id: UNIT }, json })).toEqual({ party_size: 4, from: "2046-03-01T08:00:00Z", to: "2046-03-01T12:00:00Z" });
    const slot = { starts_at: "2046-03-01T08:00:00.000Z", duration_minutes: 60, assignment: { kind: "unit", id: UNIT } };
    expect(recordedOutcome("search_availability", 200, { slots: [slot, slot, slot], truncated: true })).toEqual({ output: { slots: 3, truncated: true }, receipt: null });
    expect(recordedOutcome("search_availability", 200, { slots: [], truncated: false })).toEqual({ output: { slots: 0, truncated: false }, receipt: null });
  });

  it("list_holds: no input; each hold's id, start, party, and expiry", () => {
    expect(recordedInput("list_holds", { param: { id: UNIT } })).toEqual({});
    const hold = {
      id: RID, party_size: 2, starts_at: "2046-03-01T08:00:00.000Z", during: "[2046-03-01 09:00:00+01,2046-03-01 10:00:00+01)",
      assignment: { kind: "unit", id: UNIT }, hold_expires_at: HOLD_EXPIRES, version: 1, external_ref: "Jane Doe",
    };
    expect(recordedOutcome("list_holds", 200, { holds: [hold, { ...hold, id: UNIT, party_size: 4 }] })).toEqual({
      output: {
        holds: [
          { id: RID, starts_at: "2046-03-01T08:00:00.000Z", party_size: 2, hold_expires_at: HOLD_EXPIRES },
          { id: UNIT, starts_at: "2046-03-01T08:00:00.000Z", party_size: 4, hold_expires_at: HOLD_EXPIRES },
        ],
      },
      receipt: null,
    });
    expect(recordedOutcome("list_holds", 200, { holds: [] })).toEqual({ output: { holds: [] }, receipt: null });
  });

  it("get_reservation: the reservation id; its id, status, start, party, expiry, and version", () => {
    expect(recordedInput("get_reservation", { param: { id: RID } })).toEqual({ reservation_id: RID });
    const body = {
      id: RID, venue_id: UNIT, status: "held", stored_status: "held", party_size: 2, starts_at: "2046-03-01T08:00:00.000Z", during: "[a,b)",
      assignment: { kind: "unit", id: UNIT }, hold_expires_at: HOLD_EXPIRES, version: 1, external_ref: "Jane Doe", history: [{ action: "hold", actor: "key:x", at: "t" }],
    };
    expect(recordedOutcome("get_reservation", 200, body)).toEqual({
      output: { id: RID, status: "held", starts_at: "2046-03-01T08:00:00.000Z", party_size: 2, hold_expires_at: HOLD_EXPIRES, version: 1 }, receipt: null,
    });
  });

  it.each(["cancel", "seat", "complete", "confirm"] as const)("%s: the reservation id and the expected version when given; no output, the receipt", (tool) => {
    expect(recordedInput(tool, { param: { id: RID }, json: { expected_version: 3 } })).toEqual({ reservation_id: RID, expected_version: 3 });
    expect(recordedInput(tool, { param: { id: RID }, json: {} })).toEqual({ reservation_id: RID });
    const receipt = { ...RECEIPT, status: "cancelled", version: 3 };
    expect(recordedOutcome(tool, 200, { receipt })).toEqual({ output: {}, receipt });
  });

  it("confirm_token: the reservation id and the expected version when given; the new version, no receipt", () => {
    expect(recordedInput("confirm_token", { param: { id: RID }, json: { expected_version: 1 } })).toEqual({ reservation_id: RID, expected_version: 1 });
    expect(recordedInput("confirm_token", { param: { id: RID }, json: {} })).toEqual({ reservation_id: RID });
    expect(recordedOutcome("confirm_token", 201, { confirm_token: "tok-secret", version: 2 })).toEqual({ output: { version: 2 }, receipt: null });
  });

  it("ids are stored in lower case, as the routes read them", () => {
    expect(recordedInput("cancel", { param: { id: RID.toUpperCase() }, json: { reason: "x" } })).toEqual({ reservation_id: RID });
    expect(recordedInput("hold", { json: { party_size: 2, starts_at: "s", duration_minutes: 60, assignment: { kind: "combo", id: UNIT.toUpperCase() } }, header: { "idempotency-key": "k" } }))
      .toMatchObject({ assignment: { kind: "combo", id: UNIT } });
  });

  it("a receipt is exactly its five fields, whatever the answer carries", () => {
    const out = recordedOutcome("seat", 200, { receipt: { ...RECEIPT, status: "seated", note: "free text", nested: { a: 1 } } });
    expect(out.receipt).toEqual({ ...RECEIPT, status: "seated" });
  });

  it.each<[RecordedTool, number, Record<string, unknown>]>([
    ["cancel", 409, { type: "t", title: "invalid transition", status: 409, code: "invalid_transition", detail: "x", trace_id: "t" }],
    ["hold", 409, { code: "hold_conflict", detail: "the assignment is already taken for an overlapping time range", replayed: false, trace_id: "t" }],
    ["get_reservation", 404, { code: "not_found", detail: "no such reservation", trace_id: "t" }],
    ["confirm", 403, { code: "forbidden", detail: "the key lacks the confirm capability", trace_id: "t" }],
    ["search_availability", 503, { code: "timeout", detail: "the operation timed out; retry", trace_id: "t" }],
  ])("a refusal stores only its code: %s %i", (tool, status, body) => {
    expect(recordedOutcome(tool, status, body)).toEqual({ output: { code: body.code }, receipt: null });
  });

  it("a cancel refused with invalid_transition is exactly its code", () => {
    expect(recordedOutcome("cancel", 409, { code: "invalid_transition", detail: "x", trace_id: "t" })).toEqual({ output: { code: "invalid_transition" }, receipt: null });
  });

  it("no free text reaches the stored fields", () => {
    const held = recordedInput("hold", {
      param: { id: UNIT },
      json: { party_size: 2, starts_at: "2046-03-01T09:00:00Z", duration_minutes: 60, assignment: { kind: "unit", id: UNIT }, external_ref: "Jane Doe +49 30 1234567" },
      header: { "idempotency-key": "k-1" },
    });
    expect(Object.keys(held).sort()).toEqual(["assignment", "duration_minutes", "idempotency_key", "party_size", "starts_at"]);
    expect(JSON.stringify(held)).not.toMatch(/Jane|1234567|external_ref/);

    const cancelled = recordedInput("cancel", { param: { id: RID }, json: { reason: "guest Jane called", expected_version: 2 } });
    expect(cancelled).toEqual({ reservation_id: RID, expected_version: 2 });

    const confirmed = recordedInput("confirm", { param: { id: RID }, json: { confirm_token: "tok-secret" } });
    expect(confirmed).toEqual({ reservation_id: RID });

    const minted = recordedOutcome("confirm_token", 201, { confirm_token: "tok-secret", version: 2 });
    expect(JSON.stringify(minted)).not.toContain("tok-secret");
    expect(Object.keys(minted.output)).toEqual(["version"]);

    const held2 = recordedOutcome("hold", 201, { receipt: RECEIPT, hold_expires_at: HOLD_EXPIRES, replayed: false, external_ref: "Jane Doe" });
    expect(JSON.stringify(held2)).not.toContain("Jane");
  });

  it("an answer that is not the expected shape is stored as far as it reads, and never throws", () => {
    expect(recordedOutcome("hold", 201, null)).toEqual({ output: {}, receipt: null });
    expect(recordedOutcome("hold", 201, "text")).toEqual({ output: {}, receipt: null });
    expect(recordedOutcome("hold", 201, { receipt: "x", hold_expires_at: { a: 1 }, replayed: true })).toEqual({ output: { replayed: true }, receipt: null });
    expect(recordedOutcome("search_availability", 200, { slots: "many", truncated: false })).toEqual({ output: { truncated: false }, receipt: null });
    expect(recordedOutcome("list_holds", 200, { holds: [null, 3, { id: RID, external_ref: "Jane" }] })).toEqual({ output: { holds: [{}, {}, { id: RID }] }, receipt: null });
    expect(recordedOutcome("get_reservation", 404, null)).toEqual({ output: {}, receipt: null });
    expect(recordedOutcome("cancel", 409, { code: { a: 1 } })).toEqual({ output: {}, receipt: null });
    expect(recordedInput("hold", {})).toEqual({ assignment: {} });
    expect(recordedInput("cancel", { param: null, json: [1] })).toEqual({});
  });
});

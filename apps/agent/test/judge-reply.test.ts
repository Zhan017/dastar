import { describe, it, expect } from "vitest";
import { CLAIM_STATUSES } from "@dastar/db";
import { parseJudgeReply } from "../src/judge/reply.js";

const ID = "0199a000-0000-7000-8000-0000000000c1";
const STATEMENT = { quote: "I've put a hold on 19:00", reservation_id: ID, status: "held", starts_at: "2064-01-07T19:00:00+01:00", party_size: 2 };
const reply = (statements: unknown[] = [STATEMENT], extra: Record<string, unknown> = {}) => JSON.stringify({ statements, ...extra });

describe("parseJudgeReply", () => {
  it("reads a valid reply and lowercases the ids and statuses", () => {
    expect(parseJudgeReply(reply())).toEqual([STATEMENT]);
    expect(parseJudgeReply(reply([]))).toEqual([]);
    expect(parseJudgeReply(reply([{ ...STATEMENT, status: "HELD", reservation_id: ID.toUpperCase() }]))).toEqual([STATEMENT]);
    for (const status of CLAIM_STATUSES) expect(parseJudgeReply(reply([{ ...STATEMENT, status: status.toUpperCase() }]))?.[0]?.status).toBe(status);
  });

  it("keeps the fields that are null, and the statements in their order", () => {
    const bare = { quote: "your table is confirmed", reservation_id: null, status: "confirmed", starts_at: null, party_size: null };
    const second = { ...STATEMENT, quote: "it was seated", status: "seated", starts_at: "2064-01-07T18:00:00Z" };
    expect(parseJudgeReply(reply([bare, STATEMENT, second]))).toEqual([bare, STATEMENT, second]);
  });

  it("is null for text that is not JSON", () => {
    for (const text of ["", "not json", '{"statements": [', "```json\n{\"statements\": []}\n```"]) expect(parseJudgeReply(text), text).toBeNull();
  });

  it("is null for JSON that is not the reply's shape", () => {
    expect(parseJudgeReply("[]")).toBeNull();
    expect(parseJudgeReply("null")).toBeNull();
    expect(parseJudgeReply("{}")).toBeNull();
    expect(parseJudgeReply(JSON.stringify({ statements: "none" }))).toBeNull();
    // an extra key, in the reply or in a statement
    expect(parseJudgeReply(reply([STATEMENT], { note: "x" }))).toBeNull();
    expect(parseJudgeReply(reply([{ ...STATEMENT, claim: true }]))).toBeNull();
    // an unknown status
    expect(parseJudgeReply(reply([{ ...STATEMENT, status: "booked" }]))).toBeNull();
    // a start without an offset, or not a date-time
    expect(parseJudgeReply(reply([{ ...STATEMENT, starts_at: "2064-01-07T19:00:00" }]))).toBeNull();
    expect(parseJudgeReply(reply([{ ...STATEMENT, starts_at: "19:00" }]))).toBeNull();
    // an id that is not a uuid, a party size that is not an integer, a quote that is not a string
    expect(parseJudgeReply(reply([{ ...STATEMENT, reservation_id: "the table" }]))).toBeNull();
    expect(parseJudgeReply(reply([{ ...STATEMENT, party_size: 2.5 }]))).toBeNull();
    expect(parseJudgeReply(reply([{ ...STATEMENT, party_size: "2" }]))).toBeNull();
    expect(parseJudgeReply(reply([{ ...STATEMENT, quote: null }]))).toBeNull();
    // one bad statement spoils the reply
    expect(parseJudgeReply(reply([STATEMENT, { ...STATEMENT, status: "booked" }]))).toBeNull();
  });

  it("is null when a field is missing, even one that may be null", () => {
    for (const key of Object.keys(STATEMENT)) {
      const without = Object.fromEntries(Object.entries(STATEMENT).filter(([name]) => name !== key));
      expect(parseJudgeReply(reply([without])), key).toBeNull();
    }
  });
});

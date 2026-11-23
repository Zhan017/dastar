import { describe, it, expect } from "vitest";
import { CLAIM_STATUSES } from "@dastar/db";
import { REPLY_JSON_SCHEMA, parseReply } from "../src/reply.js";

const ID = "0199a000-0000-7000-8000-0000000000c1";
const CLAIM = { reservation_id: ID, status: "held", starts_at: "2064-01-07T19:00:00Z", party_size: 2 };
const reply = (over: Record<string, unknown> = {}) => JSON.stringify({ message: "Held for 19:00.", claims: [CLAIM], ...over });

describe("the reply format", () => {
  it("the JSON schema is the reply's shape, every field required and both objects closed", () => {
    expect(REPLY_JSON_SCHEMA).toEqual({
      type: "object",
      properties: {
        message: { type: "string" },
        claims: {
          type: "array",
          items: {
            type: "object",
            properties: {
              reservation_id: { type: "string", format: "uuid" },
              status: { type: "string", enum: [...CLAIM_STATUSES] },
              starts_at: { type: "string", format: "date-time" },
              party_size: { type: "integer" },
            },
            required: ["reservation_id", "status", "starts_at", "party_size"],
            additionalProperties: false,
          },
        },
      },
      required: ["message", "claims"],
      additionalProperties: false,
    });
  });

  it("parseReply reads a valid reply and lowercases status and ids", () => {
    expect(parseReply(reply())).toEqual({ message: "Held for 19:00.", claims: [CLAIM] });
    expect(parseReply(reply({ claims: [] }))).toEqual({ message: "Held for 19:00.", claims: [] });
    expect(parseReply(reply({ claims: [{ ...CLAIM, status: "HELD", reservation_id: ID.toUpperCase() }] }))).toEqual({ message: "Held for 19:00.", claims: [CLAIM] });
    for (const status of CLAIM_STATUSES) expect(parseReply(reply({ claims: [{ ...CLAIM, status: status.toUpperCase() }] }))?.claims[0]?.status).toBe(status);
  });

  it("parseReply refuses what the schema refuses", () => {
    expect(parseReply("not json")).toBeNull();
    expect(parseReply("")).toBeNull();
    expect(parseReply(JSON.stringify({ claims: [CLAIM] }))).toBeNull();
    expect(parseReply(JSON.stringify({ message: "Held." }))).toBeNull();
    expect(parseReply(JSON.stringify({ message: "Held.", claims: [{ ...CLAIM, party_size: undefined }] }))).toBeNull();
    expect(parseReply(reply({ extra: 1 }))).toBeNull();
    expect(parseReply(reply({ claims: [{ ...CLAIM, extra: 1 }] }))).toBeNull();
    expect(parseReply(reply({ claims: [{ ...CLAIM, status: "pending" }] }))).toBeNull();
    expect(parseReply(reply({ claims: [{ ...CLAIM, party_size: 2.5 }] }))).toBeNull();
    expect(parseReply(reply({ claims: [{ ...CLAIM, starts_at: "tomorrow" }] }))).toBeNull();
    expect(parseReply(reply({ claims: [{ ...CLAIM, starts_at: "2064-01-07T19:00:00" }] }))).toBeNull();
    expect(parseReply(reply({ claims: [{ ...CLAIM, reservation_id: "x" }] }))).toBeNull();
    expect(parseReply(reply({ claims: null }))).toBeNull();
    expect(parseReply(reply({ message: 5 }))).toBeNull();
    expect(parseReply("[]")).toBeNull();
    expect(parseReply("null")).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import type { StoredTurn } from "@dastar/db";
import { buildConversation } from "../src/history.js";

const ID = "0199a000-0000-7000-8000-0000000000c1";
const CLAIM = { reservation_id: ID, status: "held", starts_at: "2064-01-07T19:00:00Z", party_size: 2 };

describe("buildConversation", () => {
  it("earlier turns come as stored, replies as their JSON, then the message and the context", () => {
    const turns: StoredTurn[] = [
      { seq: 1, role: "user", content: "hi [phone]", claims: null, at: null },
      { seq: 2, role: "assistant", content: "Held.", claims: [CLAIM], at: "2064-01-07T16:00:05.000Z" },
    ];
    expect(buildConversation({ turns, message: "call +49 30 1234567", context: "ctx" })).toEqual([
      { role: "user", text: "hi [phone]" },
      { role: "assistant", text: JSON.stringify({ message: "Held.", claims: [CLAIM] }) },
      { role: "user", text: "call +49 30 1234567" },
      { role: "operator", text: "ctx" },
    ]);
  });

  it("an assistant turn with null claims gives an empty list", () => {
    const turns: StoredTurn[] = [{ seq: 1, role: "assistant", content: "Hello.", claims: null, at: null }];
    const [reply] = buildConversation({ turns, message: "m", context: "c" });
    expect(reply).toEqual({ role: "assistant", text: '{"message":"Hello.","claims":[]}' });
  });

  it("with no earlier turns it is the message and the context", () => {
    expect(buildConversation({ turns: [], message: "m", context: "c" })).toEqual([
      { role: "user", text: "m" },
      { role: "operator", text: "c" },
    ]);
  });
});

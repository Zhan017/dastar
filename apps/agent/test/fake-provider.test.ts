import { describe, it, expect } from "vitest";
import { AGENT_TOOLS } from "../src/tools.js";
import { REPLY_JSON_SCHEMA } from "../src/reply.js";
import type { CompletionRequest } from "../src/provider.js";
import { USAGE, lastResult, replyWith, scripted, toolCall } from "./fake-provider.js";

const request = (overrides: Partial<CompletionRequest> = {}): CompletionRequest => ({
  system: "system",
  messages: [{ role: "user", text: "a table for two" }],
  tools: AGENT_TOOLS,
  replySchema: REPLY_JSON_SCHEMA,
  signal: new AbortController().signal,
  ...overrides,
});

describe("scripted", () => {
  it("answers each call with the next step, in order, and a function step with its answer to the request", async () => {
    const provider = scripted(toolCall("search_availability", { party_size: 2 }, "toolu_1"), (req) => replyWith(`${req.messages.length} messages`), replyWith("last"));

    const first = await provider.complete(request());
    expect(first).toMatchObject({ kind: "tools", calls: [{ id: "toolu_1", name: "search_availability", input: { party_size: 2 } }], model: "fake-model", usage: USAGE });

    const second = await provider.complete(request({ messages: [{ role: "user", text: "a" }, { role: "operator", text: "b" }] }));
    expect(second).toMatchObject({ kind: "reply", text: "2 messages" });

    const third = await provider.complete(request());
    expect(third).toMatchObject({ kind: "reply", text: "last" });
  });

  it("records a deep copy of each request, with the signal as given", async () => {
    const provider = scripted(replyWith("ok"));
    const messages: CompletionRequest["messages"] = [{ role: "user", text: "before" }];
    const given = request({ messages });
    await provider.complete(given);

    messages.push({ role: "operator", text: "after" });
    (messages[0] as { text: string }).text = "changed";

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.messages).toEqual([{ role: "user", text: "before" }]);
    expect(provider.requests[0]?.messages).not.toBe(messages);
    expect(provider.requests[0]?.tools).toEqual(AGENT_TOOLS);
    expect(provider.requests[0]?.signal).toBe(given.signal);
  });

  it("rejects a call no step was scripted for, and records it", async () => {
    const provider = scripted(replyWith("only"));
    await provider.complete(request());
    await expect(provider.complete(request())).rejects.toThrow(/no step for call 2/);
    expect(provider.requests).toHaveLength(2);
    await expect(scripted().complete(request())).rejects.toThrow(/no step for call 1/);
  });
});

describe("the scripted completions", () => {
  it("replyWith sends a reply as its JSON and a string unchanged, and toolCall defaults its id", () => {
    const reply = { message: "Held.", claims: [] };
    expect(replyWith(reply)).toMatchObject({ kind: "reply", text: JSON.stringify(reply), assistant: [{ type: "text", text: JSON.stringify(reply) }] });
    expect(replyWith("not json")).toMatchObject({ kind: "reply", text: "not json" });
    expect(toolCall("cancel", { reservation_id: "r" })).toMatchObject({ kind: "tools", calls: [{ id: "toolu_fake", name: "cancel" }] });
    expect(USAGE).toEqual({ input: 100, output: 20, cacheRead: 10, cacheWrite: 5 });
  });
});

describe("lastResult", () => {
  it("parses the JSON after the first line of the last tool result", () => {
    const messages: CompletionRequest["messages"] = [
      { role: "user", text: "hold it" },
      { role: "tool_results", results: [{ id: "t1", text: 'Earlier.\n{"n":1}', isError: false }] },
      { role: "provider", content: [] },
      {
        role: "tool_results",
        results: [
          { id: "t2", text: 'Not this one.\n{"n":2}', isError: false },
          { id: "t3", text: 'Held for two.\n{"reservation":{"id":"r1","status":"held"},"ok":true}', isError: false },
        ],
      },
      { role: "operator", text: "later" },
    ];
    expect(lastResult(request({ messages }))).toEqual({ reservation: { id: "r1", status: "held" }, ok: true });
  });

  it("throws when there is no tool result or its text has no second line", () => {
    expect(() => lastResult(request())).toThrow(/no tool result/);
    expect(() => lastResult(request({ messages: [{ role: "tool_results", results: [{ id: "t", text: "one line", isError: true }] }] }))).toThrow(/no line after/);
  });
});

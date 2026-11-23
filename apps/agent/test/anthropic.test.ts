import { describe, it, expect } from "vitest";
import { APP_NOTICE, FALLBACK_BETA, FALLBACK_MODELS, MAX_TOKENS, createAnthropicProvider, echoContent, toRequestMessages } from "../src/anthropic.js";
import type { ChatMessage, CompletionRequest } from "../src/provider.js";
import { REPLY_JSON_SCHEMA } from "../src/reply.js";
import { AGENT_TOOLS } from "../src/tools.js";

type Sent = { url: string; headers: Headers; body: Record<string, unknown> };

/** The SDK's own `fetch`, replaced: it records what is sent, never reaches the network, and answers with `answer`. */
function fakeFetch(answer: () => Response) {
  const sent: Sent[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const signal = init?.signal;
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return answer();
  };
  return { fetch: fetchFn, sent };
}

type Wire = { content: unknown[]; stop_reason: string; model?: string; usage?: Record<string, unknown> };

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const message = ({ content, stop_reason, model = "claude-opus-5-5", usage }: Wire) =>
  json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: usage ?? { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
  });

const request = (overrides: Partial<CompletionRequest> = {}): CompletionRequest => ({
  system: "You book tables.",
  messages: [{ role: "user", text: "a table for two" }],
  tools: AGENT_TOOLS,
  replySchema: REPLY_JSON_SCHEMA,
  signal: new AbortController().signal,
  ...overrides,
});

const provider = (answer: () => Response, model = "claude-opus-5-5") => {
  const { fetch: fetchFn, sent } = fakeFetch(answer);
  return { provider: createAnthropicProvider({ apiKey: "test-key", model, effort: "medium", fetch: fetchFn, maxRetries: 0 }), sent };
};

const text = (value: string) => ({ type: "text", text: value, citations: null });
const thinking = (value: string) => ({ type: "thinking", thinking: value, signature: `sig-${value}` });
const toolUse = (id: string, input: unknown = {}) => ({ type: "tool_use", id, name: "search_availability", input });
const fallback = { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-sonnet-5-5" }, trigger: { type: "refusal", category: null } };

describe("createAnthropicProvider request", () => {
  it("sends the model, the limits, the strict tools, the reply format and the cached system prompt, and no thinking", async () => {
    const { provider: p, sent } = provider(() => message({ content: [text("hi")], stop_reason: "end_turn" }));
    await p.complete(request());

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toContain("/v1/messages");
    const body = sent[0]?.body ?? {};
    expect(body["model"]).toBe("claude-opus-5-5");
    expect(MAX_TOKENS).toBe(16_000);
    expect(body["max_tokens"]).toBe(16_000);
    expect(body["system"]).toEqual([{ type: "text", text: "You book tables.", cache_control: { type: "ephemeral" } }]);
    expect(body["tools"]).toEqual(AGENT_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema, strict: true })));
    expect(body["tool_choice"]).toEqual({ type: "auto" });
    expect(body["output_config"]).toEqual({ effort: "medium", format: { type: "json_schema", schema: REPLY_JSON_SCHEMA } });
    expect(body["messages"]).toEqual([{ role: "user", content: "a table for two" }]);
    expect(body).not.toHaveProperty("thinking");
  });

  it("asks for the refusal fallback on the models that take it, and not on others", async () => {
    expect([...FALLBACK_MODELS].sort()).toEqual(["claude-opus-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(FALLBACK_BETA).toBe("server-side-fallback-2026-07-01");

    const withFallback = provider(() => message({ content: [text("hi")], stop_reason: "end_turn" }), "claude-opus-5-5");
    await withFallback.provider.complete(request());
    expect(withFallback.sent[0]?.headers.get("anthropic-beta")).toContain(FALLBACK_BETA);
    expect(withFallback.sent[0]?.body["fallbacks"]).toBe("default");

    const without = provider(() => message({ content: [text("hi")], stop_reason: "end_turn", model: "claude-haiku-5-5" }), "claude-haiku-5-5");
    await without.provider.complete(request());
    expect(without.sent[0]?.headers.get("anthropic-beta") ?? "").not.toContain(FALLBACK_BETA);
    expect(without.sent[0]?.body).not.toHaveProperty("fallbacks");
  });
});

describe("toRequestMessages", () => {
  const toolUseBlock = { type: "tool_use", id: "t1", name: "search_availability", input: { party_size: 2 } };

  it("places app text as a system message after a user message and as a marked user message elsewhere", () => {
    const messages: ChatMessage[] = [
      { role: "user", text: "a" },
      { role: "operator", text: "ctx" },
      { role: "provider", content: [toolUseBlock] },
      { role: "tool_results", results: [{ id: "t1", text: "Found.\n{}", isError: false }] },
      { role: "operator", text: "x" },
      { role: "provider", content: [{ type: "text", text: "done" }] },
      { role: "operator", text: "fix" },
    ];
    expect(toRequestMessages(messages)).toEqual([
      { role: "user", content: "a" },
      { role: "system", content: "ctx" },
      { role: "assistant", content: [toolUseBlock] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Found.\n{}", is_error: false }] },
      { role: "system", content: "x" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: APP_NOTICE("fix") },
    ]);
    expect(APP_NOTICE("fix")).toBe("<app_notice>\nfix\n</app_notice>");
  });

  it("puts a system message last when the app's text comes last after a user message", () => {
    expect(
      toRequestMessages([
        { role: "user", text: "a" },
        { role: "operator", text: "ctx" },
      ]),
    ).toEqual([
      { role: "user", content: "a" },
      { role: "system", content: "ctx" },
    ]);
  });

  it("marks app text that is followed by more app text, as a system message may not be followed by a user message", () => {
    expect(
      toRequestMessages([
        { role: "user", text: "a" },
        { role: "operator", text: "ctx" },
        { role: "operator", text: "cut" },
      ]),
    ).toEqual([
      { role: "user", content: "a" },
      { role: "user", content: APP_NOTICE("ctx") },
      { role: "user", content: APP_NOTICE("cut") },
    ]);
  });

  it("marks app text that opens the conversation or follows a delivered reply", () => {
    expect(
      toRequestMessages([
        { role: "operator", text: "first" },
        { role: "assistant", text: '{"message":"Hi","claims":[]}' },
        { role: "operator", text: "second" },
        { role: "user", text: "b" },
      ]),
    ).toEqual([
      { role: "user", content: APP_NOTICE("first") },
      { role: "assistant", content: '{"message":"Hi","claims":[]}' },
      { role: "user", content: APP_NOTICE("second") },
      { role: "user", content: "b" },
    ]);
  });

  it("passes tool errors with is_error and several results as several blocks", () => {
    expect(
      toRequestMessages([
        {
          role: "tool_results",
          results: [
            { id: "t1", text: "ok", isError: false },
            { id: "t2", text: "no", isError: true },
          ],
        },
      ]),
    ).toEqual([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "ok", is_error: false },
          { type: "tool_result", tool_use_id: "t2", content: "no", is_error: true },
        ],
      },
    ]);
  });
});

describe("createAnthropicProvider completion", () => {
  it("maps tool calls, replies, refusals and truncation, with usage and the answering model", async () => {
    const tools = provider(() =>
      message({ content: [text("looking"), toolUse("t1", { n: 1 }), toolUse("t2", { n: 2 })], stop_reason: "tool_use", model: "claude-opus-5-5-20261101" }),
    );
    const called = await tools.provider.complete(request());
    expect(called).toEqual({
      kind: "tools",
      calls: [
        { id: "t1", name: "search_availability", input: { n: 1 } },
        { id: "t2", name: "search_availability", input: { n: 2 } },
      ],
      assistant: [text("looking"), toolUse("t1", { n: 1 }), toolUse("t2", { n: 2 })],
      usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2 },
      model: "claude-opus-5-5-20261101",
    });

    const reply = provider(() => message({ content: [text('{"message":'), text('"Hi","claims":[]}')], stop_reason: "end_turn" }));
    expect(await reply.provider.complete(request())).toMatchObject({ kind: "reply", text: '{"message":"Hi","claims":[]}', assistant: [text('{"message":'), text('"Hi","claims":[]}')] });

    const refused = provider(() => message({ content: [], stop_reason: "refusal" }));
    expect(await refused.provider.complete(request())).toEqual({ kind: "refused", usage: { input: 11, output: 7, cacheRead: 3, cacheWrite: 2 }, model: "claude-opus-5-5" });

    for (const stop_reason of ["max_tokens", "model_context_window_exceeded"]) {
      const cut = provider(() => message({ content: [text("par")], stop_reason }));
      expect(await cut.provider.complete(request())).toMatchObject({ kind: "truncated" });
    }
  });

  it("reads absent cache counts as 0", async () => {
    const bare = provider(() => message({ content: [text("hi")], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 6 } }));
    expect((await bare.provider.complete(request())).usage).toEqual({ input: 5, output: 6, cacheRead: 0, cacheWrite: 0 });

    const nulls = provider(() =>
      message({ content: [text("hi")], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: null, cache_creation_input_tokens: null } }),
    );
    expect((await nulls.provider.complete(request())).usage).toEqual({ input: 5, output: 6, cacheRead: 0, cacheWrite: 0 });
  });

  it("passes model output back as the API requires after a fallback", async () => {
    const content = [thinking("a"), toolUse("A"), fallback, thinking("b"), toolUse("B")];
    const after = provider(() => message({ content, stop_reason: "tool_use" }));
    const completion = await after.provider.complete(request());
    expect(completion).toMatchObject({ kind: "tools", calls: [{ id: "B", name: "search_availability", input: {} }], assistant: [fallback, thinking("b"), toolUse("B")] });

    const plain = [thinking("a"), toolUse("A")];
    const unchanged = provider(() => message({ content: plain, stop_reason: "tool_use" }));
    expect(await unchanged.provider.complete(request())).toMatchObject({ calls: [{ id: "A" }], assistant: plain });
  });

  it("takes a reply's text from the blocks after the last fallback only", async () => {
    const content = [thinking("a"), text("declined "), fallback, text('{"message":"'), text('Hi","claims":[]}')];
    const after = provider(() => message({ content, stop_reason: "end_turn" }));
    expect(await after.provider.complete(request())).toMatchObject({
      kind: "reply",
      text: '{"message":"Hi","claims":[]}',
      assistant: [text("declined "), fallback, text('{"message":"'), text('Hi","claims":[]}')],
    });
  });

  it("rejects when the model stopped to use a tool and called none after its fallback", async () => {
    const stopped = provider(() => message({ content: [toolUse("A"), fallback, text("hm")], stop_reason: "tool_use" }));
    await expect(stopped.provider.complete(request())).rejects.toThrow(/called none/);
  });

  it("an unexpected stop reason rejects", async () => {
    for (const stop_reason of ["stop_sequence", "pause_turn", "compaction"]) {
      const odd = provider(() => message({ content: [text("hi")], stop_reason }));
      await expect(odd.provider.complete(request())).rejects.toThrow(new RegExp(stop_reason));
    }
    const none = provider(() => message({ content: [text("hi")], stop_reason: null as unknown as string }));
    await expect(none.provider.complete(request())).rejects.toThrow(/null/);
  });

  it("a server error rejects", async () => {
    const failing = provider(() => json({ type: "error", error: { type: "api_error", message: "overloaded" } }, 500));
    await expect(failing.provider.complete(request())).rejects.toThrow();
    expect(failing.sent).toHaveLength(1);
  });

  it("the signal aborts the request", async () => {
    const { fetch: fetchFn, sent } = fakeFetch(() => message({ content: [text("hi")], stop_reason: "end_turn" }));
    const p = createAnthropicProvider({ apiKey: "test-key", model: "claude-opus-5-5", effort: "medium", fetch: fetchFn, maxRetries: 0 });
    const controller = new AbortController();
    controller.abort();
    await expect(p.complete(request({ signal: controller.signal }))).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });
});

describe("echoContent", () => {
  it("keeps only the text and the paired server tool blocks before the last fallback, and everything from it on", () => {
    const content = [
      text("kept"),
      thinking("a"),
      { type: "redacted_thinking", data: "x" },
      toolUse("A"),
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [] },
      { type: "server_tool_use", id: "s2", name: "web_search", input: { query: "unpaired" } },
      { type: "web_search_tool_result", tool_use_id: "s3", content: [] },
      { type: "compaction", content: "c" },
      fallback,
      thinking("b"),
      toolUse("B"),
    ];
    expect(echoContent(content)).toEqual([
      text("kept"),
      { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } },
      { type: "web_search_tool_result", tool_use_id: "s1", content: [] },
      fallback,
      thinking("b"),
      toolUse("B"),
    ]);
  });

  it("works from the last of several fallback blocks and leaves output with none as it is", () => {
    const other = { ...fallback, from: { model: "claude-sonnet-5-5" }, to: { model: "claude-haiku-5-5" } };
    expect(echoContent([thinking("a"), fallback, thinking("b"), toolUse("B"), other, text("c")])).toEqual([other, text("c")]);

    const plain = [thinking("a"), toolUse("A"), text("t")];
    expect(echoContent(plain)).toEqual(plain);
  });
});

import { describe, it, expect } from "vitest";
import type { Completion, LLMProvider, ToolOutput } from "../src/provider.js";
import type { LoadedPrompt } from "../src/prompt.js";
import { REPLY_JSON_SCHEMA, type Reply } from "../src/reply.js";
import { AGENT_TOOLS } from "../src/tools.js";
import { recordingFetch, runProbe, type ResponseRecord } from "../scripts/live.js";
import { USAGE, lastResult, replyWith, scripted, toolCall } from "./fake-provider.js";

const NOW = new Date("2026-11-23T10:00:00.000Z"); // 15:00 on Monday 23 November in Almaty, which keeps +05:00 all year
const UNIT = "0199a000-0000-7000-8000-000000000103";
const RESERVATION = "0199a000-0000-7000-8000-0000000000f1";

const prompt: LoadedPrompt = {
  system: "You book tables.",
  contextTemplate: "Now {{utc}}; {{weekday}} {{local}} {{zone}} UTC{{offset}}, at {{venue}}.",
  hash: "test",
};

const search = { party_size: 2, from: "2026-11-24T00:00:00+05:00", to: "2026-11-24T23:59:00+05:00" };
const hold = { party_size: 2, starts_at: "2026-11-24T19:00:00+05:00", duration_minutes: 90, assignment: { kind: "unit", id: UNIT } };
const get = { reservation_id: RESERVATION };
const cancel = { reservation_id: RESERVATION, reason: "the guest asked" };

const noClaims: Reply = { message: "A table is held until 19:10.", claims: [] };
const another: Reply = { message: "Held until 19:10.", claims: [] };

/** One tools completion that asks for several calls at once, each with its own id. */
const manyCalls = (calls: [string, unknown][]): Completion => ({
  kind: "tools",
  calls: calls.map(([name, input], i) => ({ id: `toolu_${i}`, name, input })),
  assistant: calls.map(([name, input], i) => ({ type: "tool_use", id: `toolu_${i}`, name, input })),
  usage: { ...USAGE },
  model: "fake-model",
});

describe("runProbe", () => {
  it("passes a run that calls a tool, replies, and replies again after the notice", async () => {
    const provider = scripted(toolCall("search_availability", search), replyWith(noClaims), replyWith(another));
    const report = await runProbe(provider, prompt, NOW);

    expect(report).toEqual({
      passed: true,
      requests: [
        { kind: "tools", model: "fake-model", usage: USAGE },
        { kind: "reply", model: "fake-model", usage: USAGE },
        { kind: "reply", model: "fake-model", usage: USAGE },
      ],
    });

    const [first, second, third] = provider.requests;
    expect(first?.system).toBe("You book tables.");
    expect(first?.tools).toEqual(AGENT_TOOLS);
    expect(first?.replySchema).toEqual(REPLY_JSON_SCHEMA);
    expect(first?.messages).toEqual([
      { role: "user", text: "Please hold a table for 2 tomorrow at 19:00." },
      { role: "operator", text: "Now 2026-11-23T10:00:00.000Z; Monday 2026-11-23 15:00 Asia/Almaty UTC+05:00, at Dastarkhan." },
    ]);
    expect(second?.messages.map((m) => m.role)).toEqual(["user", "operator", "provider", "tool_results"]);
    expect(second?.messages[2]).toEqual({ role: "provider", content: toolCall("search_availability", search).assistant });
    expect(second?.messages[3]).toMatchObject({ role: "tool_results", results: [{ id: "toolu_fake", isError: false }] });
    expect(third?.messages.map((m) => m.role)).toEqual(["user", "operator", "provider", "tool_results", "provider", "operator"]);
    expect(third?.messages[4]).toEqual({ role: "provider", content: replyWith(noClaims).assistant });
    expect(third?.messages[5]).toEqual({ role: "operator", text: "Reply again in one sentence." });
  });

  it("answers each call by its id with the tools' own sentence and data: one slot tomorrow at 19:00 at the venue, a hold for ten minutes, the reservation held, and cancelled", async () => {
    const provider = scripted(
      manyCalls([["search_availability", search], ["hold", hold], ["get_reservation", get], ["cancel", cancel]]),
      replyWith(noClaims),
      replyWith(another),
    );
    expect((await runProbe(provider, prompt, NOW)).passed).toBe(true);

    const answered = provider.requests[1]?.messages.at(-1);
    expect(answered?.role).toBe("tool_results");
    const results = (answered as { results: ToolOutput[] }).results;
    expect(results.map((r) => [r.id, r.isError])).toEqual([["toolu_0", false], ["toolu_1", false], ["toolu_2", false], ["toolu_3", false]]);

    const [searched, held, read, cancelled] = results.map((r) => ({ sentence: r.text.split("\n")[0], data: JSON.parse(r.text.slice(r.text.indexOf("\n") + 1)) as Record<string, unknown> }));
    // 19:00 on 24 November at +05:00 is 14:00 UTC
    expect(searched).toEqual({
      sentence: "Found 1 slot.",
      data: { slots: [{ starts_at: "2026-11-24T14:00:00.000Z", duration_minutes: 90, assignment: { kind: "unit", id: UNIT } }], truncated: false },
    });
    expect(held?.sentence).toBe(
      `Held reservation ${RESERVATION} until 2026-11-23T10:10:00.000Z. It is not booked until a person confirms it through the venue; otherwise it expires then.`,
    );
    expect(held?.data).toMatchObject({ receipt: { reservation_id: RESERVATION, status: "held" }, hold_expires_at: "2026-11-23T10:10:00.000Z", replayed: false });
    expect(read?.sentence).toBe(`Reservation ${RESERVATION} is held.`);
    expect(read?.data).toMatchObject({
      id: RESERVATION,
      status: "held",
      starts_at: "2026-11-24T14:00:00.000Z",
      assignment: { kind: "unit", id: UNIT },
      hold_expires_at: "2026-11-23T10:10:00.000Z",
    });
    expect(cancelled?.sentence).toBe(`Cancelled reservation ${RESERVATION}.`);
    expect(cancelled?.data).toMatchObject({ receipt: { reservation_id: RESERVATION, status: "cancelled" } });
  });

  it("gives the date of tomorrow at the venue, not in UTC", async () => {
    // 21:00 on 23 November in UTC is already 02:00 on 24 November in Almaty, so tomorrow there is the 25th
    const late = new Date("2026-11-23T21:00:00.000Z");
    const provider = scripted(toolCall("search_availability", search), replyWith(noClaims), replyWith(another));
    expect((await runProbe(provider, prompt, late)).passed).toBe(true);
    const answered = provider.requests[1];
    if (answered === undefined) throw new Error("the second request was not made");
    expect(lastResult(answered)).toMatchObject({ slots: [{ starts_at: "2026-11-25T14:00:00.000Z" }] });
  });

  it("answers a tool call that comes after the first reply, within the four requests", async () => {
    const provider = scripted(toolCall("search_availability", search), replyWith(noClaims), toolCall("get_reservation", get), replyWith(another));
    const report = await runProbe(provider, prompt, NOW);

    expect(report.passed).toBe(true);
    expect(report.requests.map((r) => r.kind)).toEqual(["tools", "reply", "tools", "reply"]);
    expect(provider.requests[3]?.messages.map((m) => m.role)).toEqual(["user", "operator", "provider", "tool_results", "provider", "operator", "provider", "tool_results"]);
  });

  it("fails a run whose arguments break the schema, whose reply does not parse, or that never calls a tool, saying which", async () => {
    // a search with no `to`
    const missing = scripted(toolCall("search_availability", { party_size: 2, from: "2026-11-24T00:00:00+05:00" }), replyWith(noClaims), replyWith(another));
    const missingReport = await runProbe(missing, prompt, NOW);
    expect(missingReport).toEqual({
      passed: false,
      reason: "a tool call broke its schema: to: is required",
      requests: [{ kind: "tools", model: "fake-model", usage: USAGE }],
    });
    expect(missing.requests).toHaveLength(1);

    // the agent's hold has no external_ref
    const external = await runProbe(scripted(toolCall("hold", { ...hold, external_ref: "table 4" })), prompt, NOW);
    expect(external.reason).toBe("a tool call broke its schema: external_ref: is not allowed");

    // the first bad call among several ends the run, before any is answered
    const several = scripted(manyCalls([["search_availability", search], ["get_reservation", { reservation_id: "r1" }], ["cancel", {}]]));
    const severalReport = await runProbe(several, prompt, NOW);
    expect(severalReport.reason).toBe("a tool call broke its schema: reservation_id: must be a uuid");
    expect(several.requests).toHaveLength(1);

    // a tool that is not one of the four
    const unknown = await runProbe(scripted(toolCall("confirm", { reservation_id: RESERVATION })), prompt, NOW);
    expect(unknown).toMatchObject({ passed: false, reason: "a tool call named an unknown tool: confirm" });

    // a reply that is not the reply's JSON, after a tool call
    const unparsed = await runProbe(scripted(toolCall("search_availability", search), replyWith("Held until 19:10.")), prompt, NOW);
    expect(unparsed).toMatchObject({ passed: false, reason: "the reply did not parse" });
    expect(unparsed.requests).toHaveLength(2);

    // a second reply that is not the reply's JSON
    const unparsedSecond = await runProbe(scripted(toolCall("search_availability", search), replyWith(noClaims), replyWith("{}")), prompt, NOW);
    expect(unparsedSecond).toMatchObject({ passed: false, reason: "the reply did not parse" });
    expect(unparsedSecond.requests).toHaveLength(3);

    // a reply with no tool called before it: the first request has no more to say
    const none = scripted(replyWith(noClaims), replyWith(another));
    const noneReport = await runProbe(none, prompt, NOW);
    expect(noneReport).toEqual({ passed: false, reason: "no tool was called", requests: [{ kind: "reply", model: "fake-model", usage: USAGE }] });
    expect(none.requests).toHaveLength(1);
  });

  it("never passes on a refusal or truncation, on a failed request or with no reply in four requests", async () => {
    const refused: Completion = { kind: "refused", usage: { ...USAGE }, model: "fake-model" };
    const truncated: Completion = { kind: "truncated", usage: { ...USAGE }, model: "fake-model" };

    expect(await runProbe(scripted(refused), prompt, NOW)).toEqual({
      passed: false,
      reason: "the model refused",
      requests: [{ kind: "refused", model: "fake-model", usage: USAGE }],
    });
    expect(await runProbe(scripted(truncated), prompt, NOW)).toMatchObject({ passed: false, reason: "the model's output was cut off at its token limit" });

    // after a tool call, and after the first reply
    expect(await runProbe(scripted(toolCall("search_availability", search), refused), prompt, NOW)).toMatchObject({ passed: false, reason: "the model refused" });
    const later = await runProbe(scripted(toolCall("search_availability", search), replyWith(noClaims), truncated), prompt, NOW);
    expect(later).toMatchObject({ passed: false, reason: "the model's output was cut off at its token limit" });
    expect(later.requests.map((r) => r.kind)).toEqual(["tools", "reply", "truncated"]);

    // a call that rejects ends the run with its message; the calls before it are kept
    const failing: LLMProvider = scripted(toolCall("search_availability", search), () => {
      throw new Error("overloaded");
    });
    const failed = await runProbe(failing, prompt, NOW);
    expect(failed).toEqual({ passed: false, reason: "the request failed: overloaded", requests: [{ kind: "tools", model: "fake-model", usage: USAGE }] });
    const notAnError: LLMProvider = {
      complete: () => Promise.reject("gone"),
    };
    expect(await runProbe(notAnError, prompt, NOW)).toEqual({ passed: false, reason: "the request failed: gone", requests: [] });

    // a model that keeps calling tools never gets to reply
    const calls = scripted(
      toolCall("search_availability", search),
      toolCall("search_availability", search),
      toolCall("search_availability", search),
      toolCall("search_availability", search),
      replyWith(noClaims),
    );
    const capped = await runProbe(calls, prompt, NOW);
    expect(capped).toMatchObject({ passed: false, reason: "no reply within 4 requests" });
    expect(capped.requests).toHaveLength(4);
    expect(calls.requests).toHaveLength(4);
  });
});

describe("recordingFetch", () => {
  it("records each answer's status, model, stop reason, usage and block types, and nothing it was sent", async () => {
    const usage = { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, iterations: [{ type: "message", input_tokens: 11, output_tokens: 7 }] };
    const ok = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [
        { type: "text", text: "a sentence the model wrote" },
        { type: "tool_use", id: "toolu_1", name: "search_availability", input: { party_size: 2 } },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage,
    };
    const rejected = { type: "error", error: { type: "invalid_request_error", message: "the request is not valid" } };

    const sent: { url: string; init: RequestInit | undefined }[] = [];
    const answers = [new Response(JSON.stringify(ok), { status: 200, headers: { "content-type": "application/json" } }), new Response(JSON.stringify(rejected), { status: 400 })];
    const base: typeof fetch = async (input, init) => {
      sent.push({ url: String(input), init });
      const answer = answers.shift();
      if (answer === undefined) throw new Error("no answer left");
      return answer;
    };

    const records: ResponseRecord[] = [];
    const wrapped = recordingFetch(base, records);
    const init = { method: "POST", headers: { "x-api-key": "placeholder-key" }, body: JSON.stringify({ messages: [{ role: "user", content: "a private sentence" }] }) };

    // the caller still reads the whole body, and the base was given what the caller sent, unchanged
    const first = await wrapped("https://api.example.test/v1/messages", init);
    expect(await first.json()).toEqual(ok);
    const second = await wrapped("https://api.example.test/v1/messages", init);
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual(rejected);
    expect(sent).toEqual([
      { url: "https://api.example.test/v1/messages", init },
      { url: "https://api.example.test/v1/messages", init },
    ]);

    expect(records).toEqual([
      { status: 200, model: "claude-opus-5-5", stop_reason: "tool_use", usage, blocks: ["text", "tool_use"] },
      { status: 400, error: { type: "invalid_request_error", message: "the request is not valid" } },
    ]);
    expect(Object.keys(records[0] ?? {}).sort()).toEqual(["blocks", "model", "status", "stop_reason", "usage"]);
    expect(Object.keys(records[1] ?? {}).sort()).toEqual(["error", "status"]);

    // nothing the request carried or the model wrote is in what is kept
    const kept = JSON.stringify(records);
    for (const secret of ["placeholder-key", "x-api-key", "a private sentence", "a sentence the model wrote", "party_size"]) {
      expect(kept).not.toContain(secret);
    }
  });
});

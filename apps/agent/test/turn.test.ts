import { randomBytes, randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { createDastarClient, type DastarClient } from "@dastar/client";
import { createKey } from "@dastar/api/auth";
import { scrubText, type VenueProfile } from "@dastar/db";
import { cloneDatabase, dropDatabase, connect, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedVenue, type Seed } from "../../../packages/db/test/helpers/seed.js";
import { makeApi } from "../../api/test/helpers.js";
import { fallbackReply, type FallbackRead } from "../src/fallback.js";
import { TRUNCATED_NOTICE, UNPARSABLE_NOTICE, violationNotice } from "../src/guardrail.js";
import { loadPrompt } from "../src/prompt.js";
import type { Completion, CompletionRequest, LLMProvider, ToolOutput } from "../src/provider.js";
import type { Reply, ReplyClaim } from "../src/reply.js";
import { runTurn, type AgentDeps, type TurnLimits, type TurnOutcome } from "../src/turn.js";
import { lastResult, replyWith, scripted, toolCall, USAGE } from "./fake-provider.js";

const BASE = "http://dastar.test";

type TurnRow = {
  seq: number; role: string; content: string; claims: unknown[] | null; guardrail_fired: boolean; at: Date | null;
  model: string | null; prompt_hash: string | null; provider_calls: number | null; regenerations: number | null; fell_back: boolean | null;
  input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null; latency_ms: number | null;
};
type CallRow = { tool: string; input: unknown; status: number | null; output: unknown; receipt: unknown };
type HoldCall = { party_size: number; starts_at: string; duration_minutes: number; assignment: { kind: "unit"; id: string } };

describe("one turn against the reference API", () => {
  let conn: Conn; let owner: Client; let seed: Seed; let api: ReturnType<typeof makeApi>;
  let venue: VenueProfile;
  let staff: DastarClient; let anonymous: DastarClient; let demoClient: DastarClient;
  let agentKeyId = ""; let agentKeyValue = ""; let staffKeyId = "";
  const tokenKey = randomBytes(32);
  const prompt = loadPrompt();
  let placed = 0;
  /** While set, the agent's hold requests reach the API and its answer is lost on the way back. */
  let dropHoldAnswers = false;

  beforeAll(async () => {
    conn = await cloneDatabase("agent_turn_test");
    owner = await connect(conn.owner);
    seed = await seedVenue(owner);
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100 where id = $1", [seed.venue]);
    api = makeApi(conn);
    const fetch = async (request: Request): Promise<Response> => api.app.request(request);
    const make = async (label: string, capabilities: string[]): Promise<{ id: string; key: string }> =>
      createKey(api.pool, { label, capabilities, venueIds: [seed.venue] });
    const agentKey = await make("agent", ["read", "hold", "cancel"]);
    const staffKey = await make("staff", ["hold", "confirm", "cancel", "read"]);
    const demoKey = await make("demo", ["read", "confirm"]);
    agentKeyId = agentKey.id;
    agentKeyValue = agentKey.key;
    staffKeyId = staffKey.id;
    staff = createDastarClient({ baseUrl: BASE, key: staffKey.key, fetch });
    anonymous = createDastarClient({ baseUrl: BASE, fetch });
    demoClient = createDastarClient({ baseUrl: BASE, key: demoKey.key, fetch });
    const profile = await api.dastar.venueProfile(seed.venue);
    if (profile === null) throw new Error("the venue was not found");
    venue = profile;
  });
  afterAll(async () => { await api.close(); await owner.end(); await dropDatabase("agent_turn_test"); });

  /** The agent's client for a session: its key and the session header, over the in-process API; no port is opened. */
  const agentClient = (sessionId: string): DastarClient =>
    createDastarClient({
      baseUrl: BASE,
      key: agentKeyValue,
      session: sessionId,
      fetch: async (request: Request): Promise<Response> => {
        const response = await api.app.request(request);
        if (dropHoldAnswers && request.method === "POST" && new URL(request.url).pathname.endsWith("/holds")) throw new TypeError("fetch failed");
        return response;
      },
    });

  const deps = (provider: LLMProvider, limits?: Partial<TurnLimits>): AgentDeps => ({
    dastar: api.dastar,
    provider,
    agentClient,
    demoClient,
    venue,
    agentKeyId,
    tokenKey,
    prompt,
    ...(limits !== undefined ? { limits } : {}),
  });

  /** A hold of two for 90 minutes on a unit, on its own evening of 2064, so no two holds of the file overlap. */
  function holdArgs(): HoldCall {
    placed += 1;
    const startsAt = new Date(Date.UTC(2064, 2, 1, 19) + placed * 86_400_000).toISOString();
    return { party_size: 2, starts_at: startsAt, duration_minutes: 90, assignment: { kind: "unit", id: seed.units[0]! } };
  }

  const claimOf = (id: string, status: ReplyClaim["status"], hold: HoldCall): ReplyClaim => ({
    reservation_id: id, status, starts_at: hold.starts_at, party_size: hold.party_size,
  });
  const reply = (message: string, claims: ReplyClaim[] = []): Reply => ({ message, claims });

  /** The reservation the last tool result of the request is about, whether a hold's or a read's. */
  const idOf = (request: CompletionRequest): string => (lastResult(request)["receipt"] as { reservation_id: string }).reservation_id;

  /** The first result of the tool results a request ends with. */
  function lastOutput(request: CompletionRequest): ToolOutput {
    const message = request.messages.at(-1);
    if (message?.role !== "tool_results") throw new Error("the request does not end in tool results");
    const output = message.results[0];
    if (output === undefined) throw new Error("the tool results are empty");
    return output;
  }

  function okOf(outcome: TurnOutcome): Extract<TurnOutcome, { ok: true }> {
    if (!outcome.ok) throw new Error(`the turn was refused: ${outcome.status} ${outcome.code}: ${outcome.detail}`);
    return outcome;
  }

  async function turnRows(sessionId: string): Promise<TurnRow[]> {
    const r = await owner.query(
      `select seq, role, content, claims, guardrail_fired, at, model, prompt_hash, provider_calls, regenerations, fell_back,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, latency_ms
         from dastar_agent.turn where session_id = $1 order by seq`,
      [sessionId],
    );
    return r.rows as TurnRow[];
  }

  async function callRows(sessionId: string): Promise<CallRow[]> {
    const r = await owner.query("select tool, input, status, output, receipt from dastar_agent.tool_call where session_id = $1 order by id", [sessionId]);
    return r.rows as CallRow[];
  }

  /** What the fallback reads of a reservation, taken from the API's own read of it. */
  async function readsOf(id: string): Promise<FallbackRead[]> {
    const read = await staff.GET("/v1/reservations/{id}", { params: { path: { id } } });
    if (read.data === undefined) throw new Error(`could not read a reservation: HTTP ${read.response.status}`);
    const { status, starts_at: startsAt, party_size: partySize } = read.data;
    return [{ reservationId: id, reservation: { status, starts_at: startsAt, party_size: partySize } }];
  }

  async function openSession(): Promise<string> {
    return (await api.dastar.sessions.openReferenceSession({ venueId: seed.venue, apiKeyId: agentKeyId })).id;
  }

  async function confirmWith(id: string, token: string): Promise<{ status: number; confirmed: string | undefined }> {
    const r = await anonymous.POST("/v1/reservations/{id}/confirm", { params: { path: { id } }, body: { confirm_token: token } });
    return { status: r.response.status, confirmed: r.data?.receipt.status };
  }

  async function cancelAsStaff(id: string): Promise<void> {
    const r = await staff.POST("/v1/reservations/{id}/cancel", { params: { path: { id } }, body: { reason: "plans changed" } });
    expect(r.response.status).toBe(200);
  }

  /** A gate a step waits at until the test opens it. */
  function gate(): { passed: Promise<void>; open: () => void } {
    let open: () => void = () => undefined;
    const passed = new Promise<void>((resolve) => { open = resolve; });
    return { passed, open };
  }

  const usage = (): Completion["usage"] => ({ ...USAGE });

  it("books: holds, replies, and the token confirms with no key; the next turn's confirmed passes", async () => {
    const args = holdArgs();
    let id = "";
    const one = okOf(await runTurn(deps(scripted(
      toolCall("hold", args),
      (req) => { id = idOf(req); return replyWith(reply("Held a table for 2.", [claimOf(id, "held", args)])); },
    )), { message: "a table for two, please" }));

    expect(one.response.reply).toEqual(reply("Held a table for 2.", [claimOf(id, "held", args)]));
    expect(one.response.holds).toEqual([
      { reservation_id: id, party_size: 2, starts_at: expect.any(String), duration_minutes: 90, hold_expires_at: expect.any(String), confirm_token: expect.any(String) },
    ]);
    expect(one.response.guardrail).toEqual({ fired: false, regenerations: 0, fallback: false });
    expect(await confirmWith(id, one.response.holds[0]!.confirm_token)).toEqual({ status: 200, confirmed: "confirmed" });

    const two = okOf(await runTurn(deps(scripted(
      toolCall("get_reservation", { reservation_id: id }),
      () => replyWith(reply("Your table is confirmed.", [claimOf(id, "confirmed", args)])),
    )), { sessionId: one.response.session_id, message: "I confirmed it" }));
    expect(two.response.session_id).toBe(one.response.session_id);
    expect(two.response.guardrail).toEqual({ fired: false, regenerations: 0, fallback: false });
    expect(two.response.holds).toEqual([]);
    expect((await turnRows(one.response.session_id)).map((row) => row.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("a rejected reply is regenerated once and then delivered", async () => {
    const args = holdArgs();
    let id = "";
    const provider = scripted(
      toolCall("hold", args),
      (req) => { id = idOf(req); return replyWith(reply("Booked.", [claimOf(id, "confirmed", args)])); },
      () => replyWith(reply("Held for you.", [claimOf(id, "held", args)])),
    );
    const one = okOf(await runTurn(deps(provider), { message: "a table for two" }));

    expect(provider.requests).toHaveLength(3);
    const retry = provider.requests[2]!.messages;
    expect(retry.at(-1)).toEqual({
      role: "operator",
      text: violationNotice([{ reservation_id: id, claimed: "confirmed", problem: "status_mismatch", current_status: "held" }]),
    });
    expect(retry.at(-2)).toEqual({ role: "provider", content: [{ type: "text", text: JSON.stringify(reply("Booked.", [claimOf(id, "confirmed", args)])) }] });
    expect(one.response.reply.message).toBe("Held for you.");
    expect(one.response.guardrail).toEqual({ fired: true, regenerations: 1, fallback: false });

    const rows = await turnRows(one.response.session_id);
    expect(rows[1]!.guardrail_fired).toBe(true);
    expect(rows[1]!.regenerations).toBe(1);
    expect(rows[1]!.provider_calls).toBe(3);
  });

  it("three rejected replies end in the fallback", async () => {
    const unbacked = (): Completion =>
      replyWith(reply("Your table is held.", [{ reservation_id: randomUUID(), status: "held", starts_at: "2064-03-01T19:00:00Z", party_size: 2 }]));
    const provider = scripted(unbacked, unbacked, unbacked);
    const out = okOf(await runTurn(deps(provider), { message: "is my table held?" }));

    expect(provider.requests).toHaveLength(3);
    expect(out.response.reply).toEqual(fallbackReply([], venue.timezone));
    expect(out.response.guardrail).toEqual({ fired: true, regenerations: 2, fallback: true });
    const rows = await turnRows(out.response.session_id);
    expect(rows[1]!.fell_back).toBe(true);
    expect(rows[1]!.guardrail_fired).toBe(true);
    expect(rows[1]!.provider_calls).toBe(3);
    expect(rows[1]!.regenerations).toBe(2);
  });

  it("an unparsable reply and a truncated one are each rejected and regenerated", async () => {
    const provider = scripted(
      replyWith("not json"),
      { kind: "truncated", usage: usage(), model: "fake-model" },
      replyWith(reply("Hello.")),
    );
    const out = okOf(await runTurn(deps(provider), { message: "hi" }));

    expect(out.response.reply).toEqual(reply("Hello."));
    expect(out.response.guardrail).toEqual({ fired: true, regenerations: 2, fallback: false });
    const second = provider.requests[1]!.messages;
    expect(second.at(-1)).toEqual({ role: "operator", text: UNPARSABLE_NOTICE });
    expect(second.at(-2)).toEqual({ role: "provider", content: [{ type: "text", text: "not json" }] });
    // the truncated completion has no output to pass back: the notice follows the earlier notice
    const third = provider.requests[2]!.messages;
    expect(third.at(-1)).toEqual({ role: "operator", text: TRUNCATED_NOTICE });
    expect(third.slice(-3).map((message) => message.role)).toEqual(["provider", "operator", "operator"]);
  });

  it("a refusal ends the turn in the fallback at once", async () => {
    const provider = scripted({ kind: "refused", usage: usage(), model: "fake-model" });
    const out = okOf(await runTurn(deps(provider), { message: "hi" }));
    expect(provider.requests).toHaveLength(1);
    expect(out.response.guardrail).toEqual({ fired: true, regenerations: 0, fallback: true });
    expect(out.response.reply).toEqual(fallbackReply([], venue.timezone));
  });

  it("the sixth provider call without a reply ends in the fallback", async () => {
    const provider = scripted(...Array.from({ length: 6 }, () => toolCall("get_reservation", { reservation_id: randomUUID() })));
    const out = okOf(await runTurn(deps(provider), { message: "where is my table?" }));

    expect(provider.requests).toHaveLength(6);
    // the sixth response's call is not run
    const reads = (await callRows(out.response.session_id)).filter((call) => call.tool === "get_reservation");
    expect(reads).toHaveLength(5);
    expect(out.response.guardrail).toEqual({ fired: true, regenerations: 0, fallback: true });
    expect(out.response.reply).toEqual(fallbackReply([], venue.timezone));
  });

  it("the deadline ends the turn in the fallback", async () => {
    const hangs = (req: CompletionRequest): Promise<Completion> =>
      new Promise<Completion>((_, reject) => { req.signal.addEventListener("abort", () => { reject(new Error("aborted")); }); });
    const startedAt = Date.now();
    const out = okOf(await runTurn(deps(scripted(hangs), { deadlineMs: 300 }), { message: "hi" }));
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(out.response.guardrail).toEqual({ fired: true, regenerations: 0, fallback: true });
    expect(out.record.providerCalls).toBe(1);
  });

  it("a provider failure ends the turn in the fallback", async () => {
    const out = okOf(await runTurn(deps(scripted(() => Promise.reject(new Error("upstream")))), { message: "hi" }));
    expect(out.response.guardrail).toEqual({ fired: true, regenerations: 0, fallback: true });
    expect(out.record).toMatchObject({ providerCalls: 1, fellBack: true, model: "" });
  });

  it("a reply that a cancel by staff after the read made stale is rejected as not current", async () => {
    const args = holdArgs();
    let id = "";
    const provider = scripted(
      toolCall("hold", args),
      (req) => { id = idOf(req); return toolCall("get_reservation", { reservation_id: id }); },
      async () => { await cancelAsStaff(id); return replyWith(reply("Still held.", [claimOf(id, "held", args)])); },
      () => toolCall("get_reservation", { reservation_id: id }),
      () => replyWith(reply("It is cancelled.", [claimOf(id, "cancelled", args)])),
    );
    const out = okOf(await runTurn(deps(provider), { message: "is it still held?" }));

    expect(provider.requests[3]!.messages.at(-1)).toEqual({
      role: "operator",
      text: violationNotice([{ reservation_id: id, claimed: "held", problem: "not_current", current_status: "cancelled" }]),
    });
    expect(out.response.reply.message).toBe("It is cancelled.");
    expect(out.response.guardrail).toEqual({ fired: true, regenerations: 1, fallback: false });
    expect(out.response.holds).toEqual([]);
  });

  it("a call whose arguments break the schema is answered with an error and not run", async () => {
    const provider = scripted(
      toolCall("hold", { ...holdArgs(), external_ref: "x" }),
      () => replyWith(reply("I could not hold that.")),
    );
    const out = okOf(await runTurn(deps(provider), { message: "a table" }));
    expect(lastOutput(provider.requests[1]!)).toEqual({
      id: "toolu_fake",
      text: "Refused: invalid_arguments (external_ref: is not allowed).",
      isError: true,
    });
    expect(out.response.guardrail.fallback).toBe(false);
    expect((await callRows(out.response.session_id)).filter((call) => call.tool === "hold")).toEqual([]);
  });

  it("a call to a tool that does not exist is answered with an error and not run", async () => {
    const provider = scripted(toolCall("confirm", { reservation_id: randomUUID() }), () => replyWith(reply("I cannot do that.")));
    const out = okOf(await runTurn(deps(provider), { message: "confirm my table" }));
    expect(lastOutput(provider.requests[1]!)).toEqual({ id: "toolu_fake", text: "Refused: invalid_arguments (unknown tool: confirm).", isError: true });
    expect(await callRows(out.response.session_id)).toEqual([]);
  });

  it("cancels in a later turn a hold made in an earlier one", async () => {
    const args = holdArgs();
    let id = "";
    const one = okOf(await runTurn(deps(scripted(
      toolCall("hold", args),
      (req) => { id = idOf(req); return replyWith(reply("Held.", [claimOf(id, "held", args)])); },
    )), { message: "a table" }));

    const cancelOutputs: ToolOutput[] = [];
    const two = okOf(await runTurn(deps(scripted(
      toolCall("cancel", { reservation_id: id, reason: "plans changed" }),
      (req) => { cancelOutputs.push(lastOutput(req)); return replyWith(reply("Cancelled.", [claimOf(id, "cancelled", args)])); },
    )), { sessionId: one.response.session_id, message: "cancel it" }));

    expect(cancelOutputs.map((output) => output.isError)).toEqual([false]);
    expect(two.response.reply.message).toBe("Cancelled.");
    expect(two.response.guardrail).toEqual({ fired: false, regenerations: 0, fallback: false });
    expect(two.response.holds).toEqual([]);
  });

  it("repeats a hold whose answer was lost and gets the same reservation", async () => {
    const args = holdArgs();
    const lostOutputs: ToolOutput[] = [];
    dropHoldAnswers = true;
    const lost = await runTurn(deps(scripted(
      toolCall("hold", args),
      (req) => { lostOutputs.push(lastOutput(req)); return replyWith(reply("I could not tell whether the table was held.")); },
    )), { message: "a table" }).finally(() => { dropHoldAnswers = false; });
    const one = okOf(lost);
    expect(lostOutputs.map((output) => output.isError)).toEqual([true]);
    expect(lostOutputs[0]!.text).toContain("No answer from the venue's API");

    // the API handled the request, and its call is recorded with the reservation
    const holdCalls = (await callRows(one.response.session_id)).filter((call) => call.tool === "hold");
    expect(holdCalls).toHaveLength(1);
    const id = (holdCalls[0]!.receipt as { reservation_id: string }).reservation_id;

    let again: Record<string, unknown> = {};
    const two = okOf(await runTurn(deps(scripted(
      toolCall("hold", args),
      (req) => { again = lastResult(req); return replyWith(reply("The table is held.")); },
    )), { sessionId: one.response.session_id, message: "try again" }));

    expect(again["replayed"]).toBe(true);
    expect((again["receipt"] as { reservation_id: string }).reservation_id).toBe(id);
    expect(two.response.holds.map((hold) => hold.reservation_id)).toEqual([id]);
  });

  it("a second message while the first is answered is 409 and changes nothing", async () => {
    const sessionId = await openSession();
    const reached = gate();
    const release = gate();
    const first = runTurn(deps(scripted(async () => {
      reached.open();
      await release.passed;
      return replyWith(reply("Hello."));
    })), { sessionId, message: "first" });
    await reached.passed;

    const refusedProvider = scripted();
    expect(await runTurn(deps(refusedProvider), { sessionId, message: "second" })).toEqual({
      ok: false, status: 409, code: "turn_in_progress", detail: "the session is still answering its previous message",
    });
    expect(refusedProvider.requests).toHaveLength(0);

    release.open();
    expect(okOf(await first).response.reply.message).toBe("Hello.");
    expect((await turnRows(sessionId)).map((row) => [row.role, row.content])).toEqual([["user", "first"], ["assistant", "Hello."]]);
  });

  it("a user turn left unanswered is closed by the next message after 240 seconds, and is busy before", async () => {
    const sessionId = await openSession();
    const claimed = await api.dastar.sessions.claimTurn({
      sessionId, venueId: seed.venue, apiKeyId: agentKeyId, content: "first", maxUserTurns: 50, staleAfterMs: 240_000,
    });
    expect(claimed.kind).toBe("claimed");

    await owner.query("update dastar_agent.turn set at = at - interval '200 seconds' where session_id = $1 and seq = 0", [sessionId]);
    expect(await runTurn(deps(scripted()), { sessionId, message: "second" })).toEqual({
      ok: false, status: 409, code: "turn_in_progress", detail: "the session is still answering its previous message",
    });
    expect(await turnRows(sessionId)).toHaveLength(1);

    await owner.query("update dastar_agent.turn set at = at - interval '41 seconds' where session_id = $1 and seq = 0", [sessionId]);
    const provider = scripted(() => replyWith(reply("Hello.")));
    const out = okOf(await runTurn(deps(provider), { sessionId, message: "second" }));
    expect(out.response.guardrail).toEqual({ fired: false, regenerations: 0, fallback: false });
    expect(provider.requests[0]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "operator"]);

    const rows = await turnRows(sessionId);
    expect(rows.map((row) => [row.seq, row.role, row.content])).toEqual([
      [0, "user", "first"],
      [1, "assistant", fallbackReply([], venue.timezone).message],
      [2, "user", "second"],
      [3, "assistant", "Hello."],
    ]);
    expect(rows[1]).toMatchObject({ guardrail_fired: true, fell_back: true, provider_calls: 0, regenerations: 0, model: "", prompt_hash: prompt.hash });
    expect(rows[1]!.at).not.toBeNull();
  });

  it("a reply whose user turn was closed meanwhile is not stored and is 409", async () => {
    const sessionId = await openSession();
    const out = await runTurn(deps(scripted(async () => {
      await owner.query(
        "insert into dastar_agent.turn (session_id, venue_id, seq, role, content, at) values ($1, $2, 1, 'assistant', 'closed', now())",
        [sessionId, seed.venue],
      );
      return replyWith(reply("Hello."));
    })), { sessionId, message: "first" });

    expect(out).toEqual({ ok: false, status: 409, code: "turn_in_progress", detail: "the session's previous message was closed after its deadline" });
    expect((await turnRows(sessionId)).map((row) => [row.role, row.content])).toEqual([["user", "first"], ["assistant", "closed"]]);
  });

  it("the 51st message is 422 conversation_full", async () => {
    const sessionId = await openSession();
    await owner.query(
      `insert into dastar_agent.turn (session_id, venue_id, seq, role, content, at)
       select $1, $2, g, case when g % 2 = 0 then 'user' else 'assistant' end, 'm', now() from generate_series(0, 99) g`,
      [sessionId, seed.venue],
    );
    const provider = scripted();
    expect(await runTurn(deps(provider), { sessionId, message: "one more" })).toEqual({
      ok: false, status: 422, code: "conversation_full", detail: "the conversation has reached 50 messages, its limit",
    });
    expect(provider.requests).toHaveLength(0);
    expect(await turnRows(sessionId)).toHaveLength(100);
  });

  it("a session that is not the agent's reference session in this venue is 404", async () => {
    const external = (await api.dastar.sessions.openSession({ venueId: seed.venue, apiKeyId: agentKeyId })).id;
    const staffs = (await owner.query(
      "insert into dastar_agent.session (venue_id, api_key_id, kind) values ($1, $2, 'reference') returning id",
      [seed.venue, staffKeyId],
    )).rows[0].id as string;

    for (const sessionId of [external, staffs, randomUUID()]) {
      const provider = scripted();
      expect(await runTurn(deps(provider), { sessionId, message: "hi" }), sessionId).toEqual({ ok: false, status: 404, code: "not_found", detail: "no such session" });
      expect(provider.requests).toHaveLength(0);
      expect(await turnRows(sessionId)).toEqual([]);
    }
  });

  it("stores the turn's record and scrubbed text, and the person gets the message as written", async () => {
    const provider = scripted(
      toolCall("get_reservation", { reservation_id: randomUUID() }),
      () => replyWith(reply("I will call +49 30 1234567.")),
    );
    const out = okOf(await runTurn(deps(provider), { message: "call me on +49 30 1234567" }));

    expect(out.response.reply.message).toBe("I will call +49 30 1234567.");
    // the model reads this turn's message as written; only what is stored is scrubbed
    expect(provider.requests[0]!.messages.at(-2)).toEqual({ role: "user", text: "call me on +49 30 1234567" });
    const rows = await turnRows(out.response.session_id);
    expect(rows.map((row) => row.content)).toEqual(["call me on [phone]", "I will call [phone]."]);
    expect(rows[0]!.at).not.toBeNull();
    expect(rows[1]!.at).not.toBeNull();
    expect(rows[1]).toMatchObject({
      model: "fake-model",
      prompt_hash: prompt.hash,
      provider_calls: 2,
      regenerations: 0,
      fell_back: false,
      guardrail_fired: false,
      input_tokens: 2 * USAGE.input,
      output_tokens: 2 * USAGE.output,
      cache_read_tokens: 2 * USAGE.cacheRead,
      cache_write_tokens: 2 * USAGE.cacheWrite,
    });
    expect(rows[1]!.latency_ms).toBeGreaterThanOrEqual(0);
    expect(out.record).toMatchObject({ model: "fake-model", promptHash: prompt.hash, providerCalls: 2, regenerations: 0, fellBack: false });
  });

  it("the token never reaches the model, a stored turn or a recorded call", async () => {
    const first = holdArgs();
    const second = holdArgs();
    let firstId = "";
    let secondId = "";
    const providerOne = scripted(
      toolCall("hold", first),
      (req) => { firstId = idOf(req); return replyWith(reply("Held.", [claimOf(firstId, "held", first)])); },
    );
    const one = okOf(await runTurn(deps(providerOne), { message: "a table" }));
    const providerTwo = scripted(
      toolCall("hold", second),
      (req) => { secondId = idOf(req); return replyWith(reply("Held another.", [claimOf(secondId, "held", second)])); },
    );
    const two = okOf(await runTurn(deps(providerTwo), { sessionId: one.response.session_id, message: "and another" }));

    // the first turn's token is reused, the second reservation gets its own
    expect(two.response.holds.map((hold) => hold.reservation_id)).toEqual([firstId, secondId]);
    const tokens = [...one.response.holds, ...two.response.holds].map((hold) => hold.confirm_token);
    expect(new Set(tokens).size).toBe(2);

    const sessionId = one.response.session_id;
    const seen = {
      requests: JSON.stringify([...providerOne.requests, ...providerTwo.requests]),
      turns: JSON.stringify(await turnRows(sessionId)),
      calls: JSON.stringify(await callRows(sessionId)),
    };
    for (const token of tokens) {
      for (const [where, text] of Object.entries(seen)) expect(text.includes(token), `${where} holds a token`).toBe(false);
    }

    // every recorded call was made through the agent's client: the demo client's reads and mints are not among them
    const counts = await owner.query("select tool, count(*)::int as n from dastar_agent.tool_call where session_id = $1 group by tool order by tool", [sessionId]);
    expect(counts.rows).toEqual([{ tool: "hold", n: 2 }]);
  });

  it("the deadline after a hold ends in a fallback that reports the held reservation, and the hold is in the response", async () => {
    let id = "";
    const hangs = (req: CompletionRequest): Promise<Completion> => {
      id = idOf(req);
      return new Promise<Completion>((_, reject) => { req.signal.addEventListener("abort", () => { reject(new Error("aborted")); }); });
    };
    const out = okOf(await runTurn(deps(scripted(toolCall("hold", holdArgs()), hangs), { deadlineMs: 2_000 }), { message: "a table for two" }));

    const reads = await readsOf(id);
    expect(reads[0]!.reservation?.status).toBe("held");
    expect(out.response.reply).toEqual(fallbackReply(reads, venue.timezone));
    expect(out.response.guardrail).toEqual({ fired: true, regenerations: 0, fallback: true });
    expect(out.response.holds.map((hold) => hold.reservation_id)).toEqual([id]);

    const rows = await turnRows(out.response.session_id);
    expect(rows[1]!.fell_back).toBe(true);
    expect(rows[1]!.claims).toEqual(out.response.reply.claims);
    expect(rows[1]!.content).toBe(scrubText(out.response.reply.message));
  });

  it("a user turn left unanswered after a hold is closed with the held reservation", async () => {
    const args = holdArgs();
    let id = "";
    const one = okOf(await runTurn(deps(scripted(
      toolCall("hold", args),
      (req) => { id = idOf(req); return replyWith(reply("Held.", [claimOf(id, "held", args)])); },
    )), { message: "a table" }));
    const sessionId = one.response.session_id;

    const claimed = await api.dastar.sessions.claimTurn({
      sessionId, venueId: seed.venue, apiKeyId: agentKeyId, content: "are you there?", maxUserTurns: 50, staleAfterMs: 240_000,
    });
    expect(claimed.kind).toBe("claimed");
    await owner.query("update dastar_agent.turn set at = at - interval '241 seconds' where session_id = $1 and seq = 2", [sessionId]);

    const three = okOf(await runTurn(deps(scripted(() => replyWith(reply("Hello.")))), { sessionId, message: "hello again" }));
    expect(three.response.guardrail).toEqual({ fired: false, regenerations: 0, fallback: false });

    const closing = fallbackReply(await readsOf(id), venue.timezone);
    const rows = await turnRows(sessionId);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(rows[3]!.content).toBe(scrubText(closing.message));
    expect(rows[3]!.claims).toEqual(closing.claims);
    expect(rows[3]).toMatchObject({ seq: 3, guardrail_fired: true, fell_back: true, provider_calls: 0 });
  });
});

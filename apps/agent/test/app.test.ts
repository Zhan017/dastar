import { randomBytes, randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { createDastarClient, type DastarClient } from "@dastar/client";
import { createKey } from "@dastar/api/auth";
import type { VenueProfile } from "@dastar/db";
import { cloneDatabase, dropDatabase, connect, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedVenue, type Seed } from "../../../packages/db/test/helpers/seed.js";
import { makeApi } from "../../api/test/helpers.js";
import { createAgentApp, type AgentLogEntry } from "../src/app.js";
import { loadPrompt } from "../src/prompt.js";
import type { LLMProvider } from "../src/provider.js";
import type { Reply } from "../src/reply.js";
import type { AgentDeps } from "../src/turn.js";
import { replyWith, scripted } from "./fake-provider.js";

const BASE = "http://dastar.test";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Body = Record<string, unknown>;

describe("POST /demo/chat", () => {
  let conn: Conn; let owner: Client; let seed: Seed; let api: ReturnType<typeof makeApi>;
  let venue: VenueProfile;
  let demoClient: DastarClient;
  let agentKeyId = ""; let agentKeyValue = ""; let staffKeyId = "";
  const tokenKey = randomBytes(32);
  const prompt = loadPrompt();

  beforeAll(async () => {
    conn = await cloneDatabase("agent_app_test");
    owner = await connect(conn.owner);
    seed = await seedVenue(owner);
    api = makeApi(conn);
    const make = async (label: string, capabilities: string[]): Promise<{ id: string; key: string }> =>
      createKey(api.pool, { label, capabilities, venueIds: [seed.venue] });
    const agentKey = await make("agent", ["read", "hold", "cancel"]);
    const staffKey = await make("staff", ["hold", "confirm", "cancel", "read"]);
    const demoKey = await make("demo", ["read", "confirm"]);
    agentKeyId = agentKey.id;
    agentKeyValue = agentKey.key;
    staffKeyId = staffKey.id;
    demoClient = createDastarClient({ baseUrl: BASE, key: demoKey.key, fetch: async (request: Request): Promise<Response> => api.app.request(request) });
    const profile = await api.dastar.venueProfile(seed.venue);
    if (profile === null) throw new Error("the venue was not found");
    venue = profile;
  });
  afterAll(async () => { await api.close(); await owner.end(); await dropDatabase("agent_app_test"); });

  const agentClient = (sessionId: string): DastarClient =>
    createDastarClient({ baseUrl: BASE, key: agentKeyValue, session: sessionId, fetch: async (request: Request): Promise<Response> => api.app.request(request) });

  const quiet = (): void => undefined;

  /** The sinks write nothing unless a test passes its own, so the tests print no request lines and no error lines. */
  const deps = (provider: LLMProvider): AgentDeps => ({
    dastar: api.dastar, provider, agentClient, demoClient, venue, agentKeyId, tokenKey, prompt, logError: quiet,
  });

  const appFor = (
    provider: LLMProvider,
    log: (entry: AgentLogEntry) => void = quiet,
    logError: (msg: string, fields: Record<string, string>) => void = quiet,
  ): ReturnType<typeof createAgentApp> => createAgentApp(deps(provider), { log, logError });

  const post = (app: ReturnType<typeof createAgentApp>, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    Promise.resolve(app.request("/demo/chat", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

  const reply = (message: string): Reply => ({ message, claims: [] });
  const hello = (): ReturnType<typeof replyWith> => replyWith(reply("Hello."));

  /** The Problem Details a refusal answers with: its shape, its trace id (the response's own) and, when given, its detail. */
  async function expectProblem(response: Response, status: number, code: string, detail?: string | RegExp): Promise<Body> {
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json/);
    const traceId = response.headers.get("x-trace-id");
    expect(traceId).toMatch(/\S/);
    const body = (await response.json()) as Body;
    const expected: Body = { type: `https://dastar.dev/errors/${code}`, title: code.replaceAll("_", " "), status, code, trace_id: traceId };
    if (detail !== undefined) expected["detail"] = typeof detail === "string" ? detail : expect.stringMatching(detail);
    expect(body).toEqual(expected);
    return body;
  }

  async function counts(): Promise<{ turns: number; sessions: number }> {
    const turns = await owner.query("select count(*)::int as n from dastar_agent.turn");
    const sessions = await owner.query("select count(*)::int as n from dastar_agent.session");
    return { turns: turns.rows[0].n as number, sessions: sessions.rows[0].n as number };
  }

  /** A gate a step waits at until the test opens it. */
  function gate(): { passed: Promise<void>; open: () => void } {
    let open: () => void = () => undefined;
    const passed = new Promise<void>((resolve) => { open = resolve; });
    return { passed, open };
  }

  async function openReferenceSession(): Promise<string> {
    return (await api.dastar.sessions.openReferenceSession({ venueId: seed.venue, apiKeyId: agentKeyId })).id;
  }

  it("answers a turn with 200 and the turn's body", async () => {
    const provider = scripted(hello, hello);
    const app = appFor(provider);

    const one = await post(app, { message: "a table for two, please" });
    expect(one.status).toBe(200);
    expect(one.headers.get("content-type")).toMatch(/^application\/json/);
    expect(one.headers.get("x-trace-id")).toMatch(/\S/);
    const first = (await one.json()) as Body;
    expect(Object.keys(first).sort()).toEqual(["guardrail", "holds", "reply", "session_id"]);
    expect(first).toEqual({
      session_id: expect.stringMatching(UUID_RE),
      reply: reply("Hello."),
      holds: [],
      guardrail: { fired: false, regenerations: 0, fallback: false },
    });

    // the session id of a later message may be written in capitals, and is answered in lowercase
    const sessionId = first["session_id"] as string;
    const two = await post(app, { session_id: sessionId.toUpperCase(), message: "and a window seat" });
    expect(two.status).toBe(200);
    expect(((await two.json()) as Body)["session_id"]).toBe(sessionId);
    expect(provider.requests).toHaveLength(2);
  });

  it("refuses a malformed request with 400 and stores nothing", async () => {
    const provider = scripted();
    const app = appFor(provider);
    const before = await counts();

    const asJson = (text: string): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: text });
    const notJson = "the request body must be application/json";
    const cases: Array<[string, RequestInit, string | RegExp]> = [
      ["no body", { method: "POST" }, notJson],
      ["text/plain", { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ message: "hi" }) }, notJson],
      ["a media type that only starts like JSON", { method: "POST", headers: { "content-type": "application/jsonp" }, body: JSON.stringify({ message: "hi" }) }, notJson],
      ["malformed JSON", asJson("{"), "the request body is not valid JSON"],
      ["an empty JSON body", asJson(""), "the request body is not valid JSON"],
      ["{}", asJson("{}"), /^message: /],
      ["a body that is not an object", asJson('["hi"]'), /^: /],
      ["an empty message", asJson(JSON.stringify({ message: "" })), "message: must not be empty"],
      ["a message of spaces", asJson(JSON.stringify({ message: "   " })), "message: must not be empty"],
      ["a message with U+0000", asJson(JSON.stringify({ message: "a\u0000b" })), "message: must not contain U+0000"],
      ["a message with a lone surrogate", asJson(JSON.stringify({ message: "\ud800x" })), "message: must be well-formed text"],
      ["a message of 2,001 characters", asJson(JSON.stringify({ message: "a".repeat(2001) })), /^message: /],
      ["a message that is not text", asJson(JSON.stringify({ message: 7 })), /^message: /],
      ["a session_id that is not a uuid", asJson(JSON.stringify({ session_id: "abc", message: "hi" })), /^session_id: /],
      ["an unknown field", asJson(JSON.stringify({ message: "hi", extra: 1 })), /extra/],
      ["a body of 16 KB and a byte", asJson("x".repeat(16 * 1024 + 1)), "request body too large"],
    ];
    for (const [name, init, detail] of cases) {
      const response = await app.request("/demo/chat", init);
      await expectProblem(response, 400, "validation", detail).catch((error: unknown) => { throw new Error(`${name}: ${String(error)}`); });
    }

    expect(provider.requests).toHaveLength(0);
    expect(await counts()).toEqual(before);

    // the bounds themselves are accepted: 2,000 characters, and a body under 16 KB that holds them
    const accepted = appFor(scripted(hello));
    const edge = await post(accepted, { message: "a".repeat(2000) });
    expect(edge.status).toBe(200);
  });

  /** A valid request body of exactly `bytes` bytes: the JSON object, then spaces. */
  const paddedBody = (bytes: number): string => {
    const json = JSON.stringify({ message: "hi" });
    return json + " ".repeat(bytes - json.length);
  };

  it("refuses a request whose content-length is past the bound with 400, and stores nothing", async () => {
    const provider = scripted();
    const app = appFor(provider);
    const before = await counts();

    const body = paddedBody(16 * 1024 + 1);
    expect(Buffer.byteLength(body)).toBe(16385);
    const response = await app.request("/demo/chat", {
      method: "POST", headers: { "content-type": "application/json", "content-length": "16385" }, body,
    });
    await expectProblem(response, 400, "validation", "request body too large");

    expect(provider.requests).toHaveLength(0);
    expect(await counts()).toEqual(before);
  });

  it("does not refuse for its size a valid request of exactly 16 KB, with or without a content-length", async () => {
    const provider = scripted(hello, hello);
    const app = appFor(provider);

    const body = paddedBody(16 * 1024);
    expect(Buffer.byteLength(body)).toBe(16384);
    for (const headers of [{ "content-type": "application/json" }, { "content-type": "application/json", "content-length": "16384" }]) {
      const response = await app.request("/demo/chat", { method: "POST", headers, body });
      expect(response.status).toBe(200);
      expect(((await response.json()) as Body)["reply"]).toEqual(reply("Hello."));
    }
    expect(provider.requests).toHaveLength(2);
  });

  it("a session that is not the agent's is 404, a busy one 409, a full one 422, with the exact texts", async () => {
    const external = (await api.dastar.sessions.openSession({ venueId: seed.venue, apiKeyId: agentKeyId })).id;
    const staffs = (await owner.query(
      "insert into dastar_agent.session (venue_id, api_key_id, kind) values ($1, $2, 'reference') returning id",
      [seed.venue, staffKeyId],
    )).rows[0].id as string;
    const missing = scripted();
    for (const sessionId of [external, staffs, randomUUID()]) {
      await expectProblem(await post(appFor(missing), { session_id: sessionId, message: "hi" }), 404, "not_found", "no such session");
    }
    expect(missing.requests).toHaveLength(0);

    // a message whose answer is still being worked on: the second message is refused while the first finishes
    const busySession = await openReferenceSession();
    const reached = gate();
    const release = gate();
    const slow = scripted(async () => { reached.open(); await release.passed; return hello(); });
    const first = post(appFor(slow), { session_id: busySession, message: "first" });
    try {
      await reached.passed;
      const refused = scripted();
      await expectProblem(await post(appFor(refused), { session_id: busySession.toUpperCase(), message: "second" }), 409, "turn_in_progress", "the session is still answering its previous message");
      expect(refused.requests).toHaveLength(0);
    } finally {
      // a failed assertion above must not leave the first turn waiting at the gate
      release.open();
    }
    expect((await first).status).toBe(200);

    // a conversation at its limit of 50 messages
    const fullSession = await openReferenceSession();
    await owner.query(
      `insert into dastar_agent.turn (session_id, venue_id, seq, role, content, at)
       select $1, $2, g, case when g % 2 = 0 then 'user' else 'assistant' end, 'm', now() from generate_series(0, 99) g`,
      [fullSession, seed.venue],
    );
    const unused = scripted();
    await expectProblem(await post(appFor(unused), { session_id: fullSession, message: "one more" }), 422, "conversation_full", "the conversation has reached 50 messages, its limit");
    expect(unused.requests).toHaveLength(0);
  });

  it("a database failure is 500 without detail", async () => {
    const broken: AgentDeps = {
      ...deps(scripted()),
      dastar: {
        ...api.dastar,
        sessions: { ...api.dastar.sessions, claimTurn: () => Promise.reject(new Error("connection terminated: the secret of the database")) },
      },
    };
    const logged: { msg: string; fields: Record<string, string> }[] = [];
    const app = createAgentApp(broken, { log: quiet, logError: (msg, fields) => { logged.push({ msg, fields }); } });
    const response = await app.request("/demo/chat", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hi" }),
    });
    const text = await response.clone().text();
    const body = await expectProblem(response, 500, "internal");
    expect("detail" in body).toBe(false);
    expect(text).not.toContain("secret");

    // the fault is traced: one line with the response's trace id and the error's message, which the person never sees
    expect(logged).toEqual([{ msg: "request failed", fields: { trace_id: body["trace_id"], error: "connection terminated: the secret of the database" } }]);

    // a refusal is a Problem, and logs nothing
    await expectProblem(await post(app, { message: "" }), 400, "validation", "message: must not be empty");
    expect(logged).toHaveLength(1);
  });

  it("any other path is 404 no such route; GET /demo/chat too", async () => {
    const app = appFor(scripted());
    for (const [method, path] of [["GET", "/"], ["GET", "/nowhere"], ["POST", "/nowhere"], ["GET", "/demo/chat"], ["DELETE", "/demo/chat"], ["POST", "/demo/chat/extra"]] as const) {
      const response = await app.request(path, { method });
      await expectProblem(response, 404, "not_found", "no such route").catch((error: unknown) => { throw new Error(`${method} ${path}: ${String(error)}`); });
    }
  });

  it("keeps a trace id that is well-formed and replaces one that is not, on every response", async () => {
    const app = appFor(scripted());
    const kept = await app.request("/nowhere", { headers: { "x-trace-id": "trace-1.a:b_c" } });
    expect(kept.headers.get("x-trace-id")).toBe("trace-1.a:b_c");
    expect(((await kept.json()) as Body)["trace_id"]).toBe("trace-1.a:b_c");

    for (const given of ["has a space", "x".repeat(101), "café"]) {
      const replaced = await app.request("/nowhere", { headers: { "x-trace-id": given } });
      expect(replaced.headers.get("x-trace-id")).toMatch(UUID_RE);
    }

    const refused = await post(app, { message: "" }, { "x-trace-id": "refused-1" });
    expect(refused.headers.get("x-trace-id")).toBe("refused-1");
    expect(((await refused.json()) as Body)["trace_id"]).toBe("refused-1");
  });

  it("the log line carries no message text", async () => {
    const entries: AgentLogEntry[] = [];
    const message = "needle-message-of-the-person";
    const answer = "needle-reply-of-the-agent";
    const app = appFor(scripted(() => replyWith(reply(answer))), (entry) => { entries.push(entry); });

    const ok = await post(app, { message }, { "x-trace-id": "log-ok" });
    const refused = await post(app, { message: "" }, { "x-trace-id": "log-refused" });
    const lost = await app.request("/nowhere", { headers: { "x-trace-id": "log-lost" } });
    expect([ok.status, refused.status, lost.status]).toEqual([200, 400, 404]);

    expect(entries.map((entry) => [entry.method, entry.path, entry.status, entry.trace_id])).toEqual([
      ["POST", "/demo/chat", 200, "log-ok"],
      ["POST", "/demo/chat", 400, "log-refused"],
      ["GET", "/nowhere", 404, "log-lost"],
    ]);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(["duration_ms", "method", "path", "status", "trace_id", "ts"]);
      expect(entry.duration_ms).toBeGreaterThanOrEqual(0);
      expect(new Date(entry.ts).toISOString()).toBe(entry.ts);
    }
    const logged = JSON.stringify(entries);
    expect(logged).not.toContain(message);
    expect(logged).not.toContain(answer);
    // the answer did reach the person
    expect(JSON.stringify(await ok.json())).toContain(answer);
  });
});

import { randomBytes, randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { createKey } from "@dastar/api/auth";
import { cloneDatabase, dropDatabase, connect, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedVenue, type Seed } from "../../../packages/db/test/helpers/seed.js";
import { makeApi } from "../../api/test/helpers.js";
import type { AgentConfig } from "../src/config.js";
import { checkStartup, type StartupResult } from "../src/startup.js";

const BASE = "http://dastar.test";

type Key = { id: string; key: string };

describe("the start-up checks", () => {
  let conn: Conn; let owner: Client; let seed: Seed; let api: ReturnType<typeof makeApi>;
  let agent: Key; let staff: Key; let admin: Key; let demo: Key; let readOnly: Key;

  beforeAll(async () => {
    conn = await cloneDatabase("agent_startup_test");
    owner = await connect(conn.owner);
    seed = await seedVenue(owner);
    api = makeApi(conn);
    const make = (label: string, capabilities: string[]): Promise<Key> => createKey(api.pool, { label, capabilities, venueIds: [seed.venue] });
    agent = await make("agent", ["read", "hold", "cancel"]);
    staff = await make("staff", ["hold", "confirm", "cancel", "read"]);
    admin = await make("admin", ["read", "admin"]);
    demo = await make("demo", ["read", "confirm"]);
    readOnly = await make("read-only", ["read"]);
  });
  afterAll(async () => { await api.close(); await owner.end(); await dropDatabase("agent_startup_test"); });

  const viaApi = async (request: Request): Promise<Response> => api.app.request(request);

  const configWith = (over: Partial<AgentConfig> = {}): AgentConfig => ({
    databaseUrl: conn.app,
    dastarUrl: BASE,
    venueId: seed.venue,
    agentKey: agent.key,
    agentKeyId: agent.id,
    demoConfirmKey: demo.key,
    tokenKey: randomBytes(32),
    anthropicApiKey: "test-key",
    model: "claude-opus-5-5",
    effort: "medium",
    host: "127.0.0.1",
    port: 0,
    ...over,
  });

  const run = (over: Partial<AgentConfig> = {}): Promise<StartupResult> => checkStartup({ config: configWith(over), dastar: api.dastar, fetch: viaApi });

  /** A fetch that answers every request through the API except the session-open post, which `answer` answers. */
  const except = (answer: (request: Request) => Promise<Response>) => async (request: Request): Promise<Response> =>
    request.method === "POST" && new URL(request.url).pathname === "/v1/sessions" ? answer(request) : api.app.request(request);

  const agentFix = (): string => `pnpm keys:create --label agent --capabilities read,hold,cancel --venues ${seed.venue}`;
  const sessionsOf = async (keyId: string): Promise<number> =>
    (await owner.query("select count(*)::int as n from dastar_agent.session where api_key_id = $1", [keyId])).rows[0].n as number;

  it("passes the agent and demo keys and the agent key's id", async () => {
    const before = await sessionsOf(agent.id);
    expect(await run()).toEqual({ ok: true, venue: { id: seed.venue, name: "Test", timezone: "Europe/Berlin" } });
    // the check opened one session for the agent's key, and nothing for the demo key
    expect(await sessionsOf(agent.id)).toBe(before + 1);
    expect(await sessionsOf(demo.id)).toBe(0);
  });

  it("refuses an agent key that can confirm or administer", async () => {
    expect(await run({ agentKey: staff.key, agentKeyId: staff.id })).toEqual({
      ok: false,
      line: `the key can confirm reservations, and this server takes only keys that cannot; create one with: ${agentFix()}`,
    });
    expect(await run({ agentKey: admin.key, agentKeyId: admin.id })).toEqual({
      ok: false,
      line: `the key has the admin capability, and this server takes only keys without it; create one with: ${agentFix()}`,
    });
  });

  it("refuses a demo key that cannot confirm", async () => {
    expect(await run({ demoConfirmKey: readOnly.key })).toEqual({
      ok: false,
      line: `the key cannot confirm reservations, and DEMO_CONFIRM_KEY must; create one with: pnpm keys:create --label demo --capabilities read,confirm --venues ${seed.venue}`,
    });
  });

  it("refuses an AGENT_KEY_ID that is not the key's", async () => {
    expect(await run({ agentKeyId: demo.id })).toEqual({ ok: false, line: "AGENT_KEY_ID is not the id of AGENT_KEY" });
  });

  it("refuses a venue that does not exist", async () => {
    const venueId = randomUUID();
    expect(await run({ venueId })).toEqual({ ok: false, line: `venue ${venueId} does not exist` });
  });

  it("names a session-open post the API does not answer, cannot be reached for, or answers with another status", async () => {
    const config = configWith();
    const check = (fetch: (request: Request) => Promise<Response>, timeoutMs?: number): Promise<StartupResult> =>
      checkStartup({ config, dastar: api.dastar, fetch, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });

    expect(await check(except(() => Promise.reject(new TypeError("fetch failed"))))).toEqual({ ok: false, line: `could not reach ${BASE}: fetch failed` });
    expect(await check(except(() => Promise.resolve(new Response("down", { status: 503 }))))).toEqual({
      ok: false, line: "checking the key failed: POST /v1/sessions answered HTTP 503",
    });
    expect(await check(except(() => Promise.resolve(new Response(JSON.stringify({ code: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } }))))).toEqual({
      ok: false, line: "checking the key failed: POST /v1/sessions answered HTTP 403 forbidden",
    });

    const hangs = except((request) => new Promise<Response>((_, reject) => { request.signal.addEventListener("abort", () => { reject(new Error("aborted")); }); }));
    expect(await check(hangs, 2_000)).toEqual({ ok: false, line: `no answer from ${BASE} within 2 seconds` });
  });

  it("does not catch a failure of the database", async () => {
    const dastar = { ...api.dastar, sessions: { ...api.dastar.sessions, sessionVenue: () => Promise.reject(new Error("the database is down")) } };
    await expect(checkStartup({ config: configWith(), dastar, fetch: viaApi })).rejects.toThrow("the database is down");
  });
});

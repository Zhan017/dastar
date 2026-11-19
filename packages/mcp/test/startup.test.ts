import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { createDastarClient, type DastarClient } from "@dastar/client";
import { createKey } from "@dastar/api/auth";
import { cloneDatabase, dropDatabase, connect, type Conn } from "../../db/test/helpers/db.js";
import { seedVenue, type Seed } from "../../db/test/helpers/seed.js";
import { makeApi } from "../../../apps/api/test/helpers.js";
import { readConfig } from "../src/config.js";
import { checkCredential, checkSession, keyCommand } from "../src/startup.js";

const VENUE = "0199a000-0000-7000-8000-000000000001";
const SESSION = "0199a000-0000-7000-8000-0000000000aa";

describe("readConfig", () => {
  const good = { DASTAR_URL: "http://127.0.0.1:8080/dastar/", DASTAR_KEY: "dsk_x", DASTAR_VENUE_ID: VENUE.toUpperCase() };

  it("reads the three settings and lowercases the venue", () => {
    expect(readConfig(good)).toEqual({ ok: true, config: { url: "http://127.0.0.1:8080/dastar/", key: "dsk_x", venueId: VENUE } });
  });

  it("names every missing or empty setting", () => {
    expect(readConfig({ DASTAR_URL: " ", DASTAR_VENUE_ID: VENUE }))
      .toEqual({ ok: false, line: "set DASTAR_URL, DASTAR_KEY and DASTAR_VENUE_ID; missing: DASTAR_URL, DASTAR_KEY" });
  });

  it("refuses a URL that is not http or https, a URL with a password, and a venue that is not a uuid", () => {
    expect(readConfig({ ...good, DASTAR_URL: "ftp://127.0.0.1" })).toEqual({ ok: false, line: "DASTAR_URL must be an http or https URL" });
    expect(readConfig({ ...good, DASTAR_URL: "127.0.0.1:8080" })).toEqual({ ok: false, line: "DASTAR_URL must be an http or https URL" });
    const withPassword = readConfig({ ...good, DASTAR_URL: "http://agent:hunter2@127.0.0.1:8080" });
    expect(withPassword).toEqual({ ok: false, line: "DASTAR_URL must not include a user name or password" });
    expect(readConfig({ ...good, DASTAR_VENUE_ID: "venue-1" })).toEqual({ ok: false, line: "DASTAR_VENUE_ID must be a uuid" });
  });

  it("reads an optional session, trimmed and lowercased, and leaves it out when empty or unset", () => {
    expect(readConfig({ ...good, DASTAR_SESSION_ID: ` ${SESSION.toUpperCase()}\n` }))
      .toEqual({ ok: true, config: { url: "http://127.0.0.1:8080/dastar/", key: "dsk_x", venueId: VENUE, sessionId: SESSION } });
    for (const value of [undefined, "", " \n"]) {
      const read = readConfig({ ...good, DASTAR_SESSION_ID: value });
      expect(read.ok).toBe(true);
      if (read.ok) expect("sessionId" in read.config).toBe(false);
    }
  });

  it("refuses a session that is not a uuid, after the venue", () => {
    expect(readConfig({ ...good, DASTAR_SESSION_ID: "abc" })).toEqual({ ok: false, line: "DASTAR_SESSION_ID must be a uuid" });
    expect(readConfig({ ...good, DASTAR_VENUE_ID: "venue-1", DASTAR_SESSION_ID: "abc" })).toEqual({ ok: false, line: "DASTAR_VENUE_ID must be a uuid" });
    expect(readConfig({ DASTAR_URL: good.DASTAR_URL, DASTAR_SESSION_ID: SESSION }))
      .toEqual({ ok: false, line: "set DASTAR_URL, DASTAR_KEY and DASTAR_VENUE_ID; missing: DASTAR_KEY, DASTAR_VENUE_ID" });
  });

  it("trims every setting, and refuses a key that is not visible ASCII without repeating it", () => {
    expect(readConfig({ DASTAR_URL: " http://127.0.0.1:8080 \n", DASTAR_KEY: " dsk_x\n", DASTAR_VENUE_ID: ` ${VENUE}\n` }))
      .toEqual({ ok: true, config: { url: "http://127.0.0.1:8080", key: "dsk_x", venueId: VENUE } });
    for (const key of ["dsk_a b", "dsk_a\nb", "dsk_a\u200bb"]) {
      expect(readConfig({ ...good, DASTAR_KEY: key })).toEqual({ ok: false, line: "DASTAR_KEY must contain only visible ASCII characters" });
    }
  });
});

describe("checkCredential against the reference API", () => {
  const BASE = "http://dastar.test";
  let conn: Conn; let owner: Client; let seed: Seed; let other: Seed; let api: ReturnType<typeof makeApi>;
  let check: (capabilities: string[] | string, venueId?: string) => Promise<string | null>;

  beforeAll(async () => {
    conn = await cloneDatabase("mcp_startup_test");
    owner = await connect(conn.owner);
    seed = await seedVenue(owner);
    other = await seedVenue(owner);
    api = makeApi(conn);
    const fetch = async (request: Request): Promise<Response> => api.app.request(request);
    check = async (capabilities, venueId = seed.venue) => {
      const key = typeof capabilities === "string" ? capabilities : (await createKey(api.pool, { label: "probe", capabilities, venueIds: [seed.venue] })).key;
      return checkCredential(createDastarClient({ baseUrl: BASE, key, fetch }), { url: BASE, venueId });
    };
  });
  afterAll(async () => { await api.close(); await owner.end(); await dropDatabase("mcp_startup_test"); });

  it("accepts a key that can read, hold, and cancel, and one that can only read and hold", async () => {
    expect(await check(["read", "hold", "cancel"])).toBeNull();
    expect(await check(["read", "hold"])).toBeNull();
  });

  it("refuses a key that can confirm", async () => {
    expect(await check(["read", "hold", "cancel", "confirm"]))
      .toBe(`the key can confirm reservations, and this server takes only keys that cannot; create one with: ${keyCommand(seed.venue)}`);
  });

  it("refuses a key with the admin capability", async () => {
    expect(await check(["read", "hold", "cancel", "admin"]))
      .toBe(`the key has the admin capability, and this server takes only keys without it; create one with: ${keyCommand(seed.venue)}`);
  });

  it("refuses a key that cannot read, a venue outside the key's, and an unknown key", async () => {
    expect(await check(["hold", "cancel"])).toBe(`the key lacks the read capability; create one with: ${keyCommand(seed.venue)}`);
    expect(await check(["read", "hold", "cancel"], other.venue))
      .toBe(`venue ${other.venue} is not among the key's venues; create one with: ${keyCommand(other.venue)}`);
    expect(await check("dsk_unknown")).toBe(`the key was not accepted: it is unknown or revoked; create one with: ${keyCommand(seed.venue)}`);
  });

  it("reports an API that does not answer, by origin only", async () => {
    const asked: string[] = [];
    const hang = (request: Request): Promise<Response> => {
      asked.push(request.url);
      return new Promise((_, reject) => { request.signal.addEventListener("abort", () => { reject(request.signal.reason); }); });
    };
    const url = "http://127.0.0.1:9/dastar/";
    expect(await checkCredential(createDastarClient({ baseUrl: url, key: "dsk_x", fetch: hang }), { url, venueId: VENUE }, 50))
      .toBe("no answer from http://127.0.0.1:9 within 0.05 seconds");
    expect(asked).toEqual([`http://127.0.0.1:9/dastar/v1/venues/${VENUE}/holds`]);
  });

  it("reports a refused connection and an unexpected answer", async () => {
    const url = "http://127.0.0.1:9";
    const refuse = async (): Promise<Response> => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }) }); };
    expect(await checkCredential(createDastarClient({ baseUrl: url, key: "dsk_x", fetch: refuse }), { url, venueId: VENUE }))
      .toBe("could not reach http://127.0.0.1:9: fetch failed (ECONNREFUSED)");
    const busy = async (): Promise<Response> => new Response(JSON.stringify({ code: "pool_timeout" }), { status: 503, headers: { "content-type": "application/problem+json" } });
    expect(await checkCredential(createDastarClient({ baseUrl: url, key: "dsk_x", fetch: busy }), { url, venueId: VENUE }))
      .toBe("checking the key failed: GET /v1/venues/{id}/holds answered HTTP 503 pool_timeout");
  });

  it("reports a web page that answers in place of the API", async () => {
    const url = "http://127.0.0.1:9";
    const page = async (): Promise<Response> => new Response("<!doctype html><title>Welcome</title>", { status: 200, headers: { "content-type": "text/html" } });
    expect(await checkCredential(createDastarClient({ baseUrl: url, key: "dsk_x", fetch: page }), { url, venueId: VENUE }))
      .toBe("checking the key failed: GET /v1/venues/{id}/holds answered with a body that is not JSON");
  });
});

describe("checkSession against the reference API", () => {
  const BASE = "http://dastar.test";
  let conn: Conn; let owner: Client; let seed: Seed; let other: Seed; let api: ReturnType<typeof makeApi>;
  let agent: string; let neighbor: string; let both: string;
  let clientFor: (key: string) => DastarClient;
  const refusal = (sessionId: string, venueId: string): string => `session ${sessionId} is not one of the key's sessions for venue ${venueId}`;

  beforeAll(async () => {
    conn = await cloneDatabase("mcp_session_check_test");
    owner = await connect(conn.owner);
    seed = await seedVenue(owner);
    other = await seedVenue(owner);
    api = makeApi(conn);
    const fetch = async (request: Request): Promise<Response> => api.app.request(request);
    clientFor = (key) => createDastarClient({ baseUrl: BASE, key, fetch });
    const make = async (label: string, venueIds: string[]): Promise<string> =>
      (await createKey(api.pool, { label, capabilities: ["read", "hold", "cancel"], venueIds })).key;
    agent = await make("agent", [seed.venue]);
    neighbor = await make("neighbor", [seed.venue]);
    both = await make("both", [seed.venue, other.venue]);
  });
  afterAll(async () => { await api.close(); await owner.end(); await dropDatabase("mcp_session_check_test"); });

  const open = async (key: string, venueId: string): Promise<string> => {
    const opened = await clientFor(key).POST("/v1/sessions", { body: { venue_id: venueId } });
    if (opened.data === undefined) throw new Error(`could not open a session: HTTP ${opened.response.status}`);
    return opened.data.id;
  };
  const check = (key: string, sessionId: string, venueId = seed.venue): Promise<string | null> =>
    checkSession(clientFor(key), { url: BASE, venueId, sessionId });

  it("accepts the key's own session for its venue", async () => {
    expect(await check(agent, await open(agent, seed.venue))).toBeNull();
  });

  it("refuses another key's session, a session that does not exist, and the key's session for another venue", async () => {
    const theirs = await open(neighbor, seed.venue);
    expect(await check(agent, theirs)).toBe(refusal(theirs, seed.venue));
    const absent = randomUUID();
    expect(await check(agent, absent)).toBe(refusal(absent, seed.venue));
    const onOther = await open(both, other.venue);
    expect(await check(both, onOther)).toBe(refusal(onOther, seed.venue));
    expect(await check(both, onOther, other.venue)).toBeNull();
  });

  it("reports an API that does not answer, by origin only", async () => {
    const asked: string[] = [];
    const hang = (request: Request): Promise<Response> => {
      asked.push(request.url);
      return new Promise((_, reject) => { request.signal.addEventListener("abort", () => { reject(request.signal.reason); }); });
    };
    const url = "http://127.0.0.1:9/dastar/";
    expect(await checkSession(createDastarClient({ baseUrl: url, key: "dsk_x", fetch: hang }), { url, venueId: VENUE, sessionId: SESSION }, 50))
      .toBe("no answer from http://127.0.0.1:9 within 0.05 seconds");
    expect(asked).toEqual([`http://127.0.0.1:9/dastar/v1/sessions/${SESSION}`]);
  });

  it("reports a refused connection, an unexpected answer, and a web page that answers in place of the API", async () => {
    const url = "http://127.0.0.1:9";
    const target = { url, venueId: VENUE, sessionId: SESSION };
    const refuse = async (): Promise<Response> => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" }) }); };
    expect(await checkSession(createDastarClient({ baseUrl: url, key: "dsk_x", fetch: refuse }), target))
      .toBe("could not reach http://127.0.0.1:9: fetch failed (ECONNREFUSED)");
    const busy = async (): Promise<Response> => new Response(JSON.stringify({ code: "pool_timeout" }), { status: 503, headers: { "content-type": "application/problem+json" } });
    expect(await checkSession(createDastarClient({ baseUrl: url, key: "dsk_x", fetch: busy }), target))
      .toBe("checking the session failed: GET /v1/sessions/{id} answered HTTP 503 pool_timeout");
    const page = async (): Promise<Response> => new Response("<!doctype html><title>Welcome</title>", { status: 200, headers: { "content-type": "text/html" } });
    expect(await checkSession(createDastarClient({ baseUrl: url, key: "dsk_x", fetch: page }), target))
      .toBe("checking the session failed: GET /v1/sessions/{id} answered with a body that is not JSON");
  });
});

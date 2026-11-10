import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { createDastarClient } from "@dastar/client";
import { createKey } from "@dastar/api/auth";
import { cloneDatabase, dropDatabase, connect, type Conn } from "../../db/test/helpers/db.js";
import { seedVenue, type Seed } from "../../db/test/helpers/seed.js";
import { makeApi } from "../../../apps/api/test/helpers.js";
import { readConfig } from "../src/config.js";
import { checkCredential, keyCommand } from "../src/startup.js";

const VENUE = "0199a000-0000-7000-8000-000000000001";

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
});

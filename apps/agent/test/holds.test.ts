import { randomBytes, randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Client } from "pg";
import { createDastarClient, type DastarClient, type components } from "@dastar/client";
import { createKey } from "@dastar/api/auth";
import type { Dastar, SessionRef } from "@dastar/db";
import { cloneDatabase, dropDatabase, connect, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedVenue, type Seed } from "../../../packages/db/test/helpers/seed.js";
import { makeApi } from "../../api/test/helpers.js";
import { buildHolds, isLiveHold, rangeMinutes, type HoldsDeps } from "../src/holds.js";
import { openToken } from "../src/tokens.js";

describe("rangeMinutes", () => {
  it("reads a stored range in any zone", () => {
    expect(rangeMinutes('["2064-01-07 19:00:00+00","2064-01-07 20:30:00+00")')).toBe(90);
    expect(rangeMinutes('["2064-01-08 00:45:00+05:45","2064-01-08 02:15:00+05:45")')).toBe(90);
    expect(rangeMinutes('["2064-01-07 19:00:00.25+00","2064-01-07 20:30:00.25+00")')).toBe(90);
    expect(rangeMinutes('["2064-01-07 19:00:00.250000+00","2064-01-07 20:30:00.25+00")')).toBe(90);
    expect(rangeMinutes('["2064-01-07 19:00:00+01","2064-01-07 21:00:00+01")')).toBe(120);
    expect(rangeMinutes('["2064-01-07 19:00:00-03:30","2064-01-07 20:00:00-03:30")')).toBe(60);
    // the bounds carry the zone of the session that printed them, and a range may cross midnight
    expect(rangeMinutes('["2064-01-07 23:30:00+00","2064-01-08 01:00:00+00")')).toBe(90);
  });

  it("gives null for an empty range, text that is not a range, and a length that is not a positive whole number of minutes", () => {
    for (const text of ["empty", "x", "(,)", "", '["2064-01-07 19:00:00+00",)', '["2064-01-07 19:00:00","2064-01-07 20:30:00")', '["2064-01-07 19:00:00Z","2064-01-07 20:30:00Z")']) {
      expect(rangeMinutes(text), text).toBeNull();
    }
    expect(rangeMinutes('["2064-01-07 19:00:00+00","2064-01-07 19:00:30+00")')).toBeNull();
    expect(rangeMinutes('["2064-01-07 19:00:00+00","2064-01-07 19:30:00.5+00")')).toBeNull();
    expect(rangeMinutes('["2064-01-07 19:00:00+00","2064-01-07 19:00:00+00")')).toBeNull();
    expect(rangeMinutes('["2064-01-07 20:30:00+00","2064-01-07 19:00:00+00")')).toBeNull();
  });
});

describe("isLiveHold", () => {
  it("is true for a held reservation and false for every other status", () => {
    expect(isLiveHold({ status: "held" })).toBe(true);
    for (const status of ["expired", "confirmed", "cancelled", "seated", "completed"]) expect(isLiveHold({ status }), status).toBe(false);
  });
});

describe("buildHolds against the reference API", () => {
  const BASE = "http://dastar.test";
  type Reservation = components["schemas"]["Reservation"];
  type Mode = "answer" | "refuse-mint" | "hang-mint" | "hang-read";

  let conn: Conn; let owner: Client; let seed: Seed; let other: Seed; let api: ReturnType<typeof makeApi>;
  let agent: DastarClient; let staff: DastarClient; let demoPlain: DastarClient; let anonymous: DastarClient; let demoClient: DastarClient;
  let agentKeyId: string;
  const tokenKey = randomBytes(32);
  /** What the demo client's fetch does with the next requests, and how many mint requests it has been asked for. */
  let mode: Mode = "answer";
  let mints = 0;
  let placed = 0;

  beforeAll(async () => {
    conn = await cloneDatabase("agent_holds_test");
    owner = await connect(conn.owner);
    seed = await seedVenue(owner);
    other = await seedVenue(owner);
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100 where id = $1", [seed.venue]);
    api = makeApi(conn);
    const fetch = async (request: Request): Promise<Response> => api.app.request(request);
    const clientFor = (key?: string): DastarClient => createDastarClient({ baseUrl: BASE, key, fetch });
    const make = async (label: string, capabilities: string[]): Promise<{ id: string; key: string }> =>
      createKey(api.pool, { label, capabilities, venueIds: [seed.venue] });
    const agentKey = await make("agent", ["read", "hold", "cancel"]);
    const staffKey = await make("staff", ["read", "cancel"]);
    const demoKey = await make("demo", ["read", "confirm"]);
    agentKeyId = agentKey.id;
    agent = clientFor(agentKey.key);
    staff = clientFor(staffKey.key);
    demoPlain = clientFor(demoKey.key);
    anonymous = clientFor();

    const problem = { type: "about:blank", title: "Conflict", status: 409, code: "version_conflict", trace_id: "trace-refused-mint" };
    const demoFetch = async (request: Request): Promise<Response> => {
      const isMint = request.method === "POST" && new URL(request.url).pathname.endsWith("/confirm-token");
      if (isMint) mints += 1;
      if ((isMint && mode === "hang-mint") || (request.method === "GET" && mode === "hang-read")) {
        return new Promise<Response>((_, reject) => { request.signal.addEventListener("abort", () => { reject(request.signal.reason); }); });
      }
      if (isMint && mode === "refuse-mint") {
        return new Response(JSON.stringify(problem), { status: 409, headers: { "content-type": "application/problem+json" } });
      }
      return api.app.request(request);
    };
    demoClient = createDastarClient({ baseUrl: BASE, key: demoKey.key, fetch: demoFetch });
  });
  afterAll(async () => { await api.close(); await owner.end(); await dropDatabase("agent_holds_test"); });
  beforeEach(() => { mode = "answer"; mints = 0; });

  /** A hold of two for 90 minutes on its own evening of 2064, placed with the agent's key. */
  async function place(): Promise<string> {
    placed += 1;
    const day = String(placed).padStart(2, "0");
    const held = await agent.POST("/v1/venues/{id}/holds", {
      params: { path: { id: seed.venue }, header: { "idempotency-key": randomUUID() } },
      body: { party_size: 2, starts_at: `2064-02-${day}T19:00:00Z`, duration_minutes: 90, assignment: { kind: "unit", id: seed.units[0]! } },
    });
    if (held.data === undefined) throw new Error(`could not place a hold: HTTP ${held.response.status}`);
    return held.data.receipt.reservation_id;
  }

  async function readOf(id: string): Promise<Reservation> {
    const read = await agent.GET("/v1/reservations/{id}", { params: { path: { id } } });
    if (read.data === undefined) throw new Error(`could not read a reservation: HTTP ${read.response.status}`);
    return read.data;
  }

  async function newSession(): Promise<SessionRef> {
    const opened = await api.dastar.sessions.openReferenceSession({ venueId: seed.venue, apiKeyId: agentKeyId });
    return { sessionId: opened.id, venueId: opened.venueId };
  }

  const deps = (over: Partial<HoldsDeps> = {}): HoldsDeps => ({ dastar: api.dastar, demoClient, tokenKey, ...over });

  async function rowsOf(session: SessionRef): Promise<{ reservation_id: string; confirm_token_enc: Buffer }[]> {
    const r = await owner.query("select reservation_id, confirm_token_enc from dastar_agent.session_hold where session_id = $1 order by created_at", [session.sessionId]);
    return r.rows as { reservation_id: string; confirm_token_enc: Buffer }[];
  }

  async function confirmWith(id: string, token: string): Promise<{ status: number; confirmed: string | undefined }> {
    const r = await anonymous.POST("/v1/reservations/{id}/confirm", { params: { path: { id } }, body: { confirm_token: token } });
    return { status: r.response.status, confirmed: r.data?.receipt.status };
  }

  it("a held reservation gets an entry whose token confirms it with no key", async () => {
    const session = await newSession();
    const id = await place();
    const read = await readOf(id);
    const entries = await buildHolds(deps(), session, [id]);
    expect(entries).toEqual([{
      reservation_id: id, party_size: 2, starts_at: read.starts_at, duration_minutes: 90, hold_expires_at: read.hold_expires_at, confirm_token: expect.any(String),
    }]);
    const token = entries[0]!.confirm_token;
    expect(token).not.toBe("");

    // what is kept for the session opens to the same token, and is not the token
    const rows = await rowsOf(session);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reservation_id).toBe(id);
    expect(openToken(tokenKey, { sessionId: session.sessionId, reservationId: id }, rows[0]!.confirm_token_enc)).toBe(token);
    expect(rows[0]!.confirm_token_enc.includes(Buffer.from(token))).toBe(false);

    expect(await confirmWith(id, token)).toEqual({ status: 200, confirmed: "confirmed" });
  });

  it("a stored token is reused while the reservation is held", async () => {
    const session = await newSession();
    const id = await place();
    const first = await buildHolds(deps(), session, [id]);
    const second = await buildHolds(deps(), session, [id]);
    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(mints).toBe(1);
    expect(await rowsOf(session)).toHaveLength(1);
  });

  it("only a held, unexpired reservation gets an entry", async () => {
    const session = await newSession();
    const held = await place();
    const cancelled = await place();
    const confirmed = await place();
    const cancel = await staff.POST("/v1/reservations/{id}/cancel", { params: { path: { id: cancelled } }, body: { reason: "plans changed" } });
    expect(cancel.response.status).toBe(200);
    const confirm = await demoPlain.POST("/v1/reservations/{id}/confirm", { params: { path: { id: confirmed } }, body: {} });
    expect(confirm.response.status).toBe(200);

    const reads = await Promise.all([held, cancelled, confirmed].map(readOf));
    expect(reads.map((r) => r.status)).toEqual(["held", "cancelled", "confirmed"]);
    expect(reads.map(isLiveHold)).toEqual([true, false, false]);

    const entries = await buildHolds(deps(), session, [held, cancelled, confirmed]);
    expect(entries.map((e) => e.reservation_id)).toEqual([held]);
    expect(mints).toBe(1);
    expect(await rowsOf(session)).toHaveLength(1);
  });

  it("a refused mint leaves the entry out and stores nothing", async () => {
    const session = await newSession();
    const id = await place();
    mode = "refuse-mint";
    expect(await buildHolds(deps(), session, [id])).toEqual([]);
    expect(mints).toBe(1);
    expect(await rowsOf(session)).toHaveLength(0);

    mode = "answer";
    const entries = await buildHolds(deps(), session, [id]);
    expect(entries.map((e) => e.reservation_id)).toEqual([id]);
    expect(await rowsOf(session)).toHaveLength(1);
  });

  it("a stored token that fails to open is minted again and overwritten", async () => {
    const session = await newSession();
    const id = await place();
    const first = (await buildHolds(deps(), session, [id]))[0]!;
    expect(mints).toBe(1);

    const broken = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(40)]);
    await owner.query("update dastar_agent.session_hold set confirm_token_enc = $1 where session_id = $2 and reservation_id = $3", [broken, session.sessionId, id]);

    const again = (await buildHolds(deps(), session, [id]))[0]!;
    expect(mints).toBe(2);
    expect(again.confirm_token).not.toBe(first.confirm_token);
    const rows = await rowsOf(session);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.confirm_token_enc.equals(broken)).toBe(false);
    expect(openToken(tokenKey, { sessionId: session.sessionId, reservationId: id }, rows[0]!.confirm_token_enc)).toBe(again.confirm_token);
    expect(await confirmWith(id, again.confirm_token)).toEqual({ status: 200, confirmed: "confirmed" });
  });

  it("a stored token sealed under another key is minted again", async () => {
    const session = await newSession();
    const id = await place();
    await buildHolds(deps({ tokenKey: randomBytes(32) }), session, [id]);
    const entries = await buildHolds(deps(), session, [id]);
    expect(mints).toBe(2);
    expect(entries).toHaveLength(1);
    expect(await confirmWith(id, entries[0]!.confirm_token)).toEqual({ status: 200, confirmed: "confirmed" });
  });

  it("a reservation that cannot be read is left out", async () => {
    const session = await newSession();
    expect(await buildHolds(deps(), session, [randomUUID()])).toEqual([]);
    expect(mints).toBe(0);
    expect(await rowsOf(session)).toHaveLength(0);
  });

  it("a reservation of another venue than the session's is left out", async () => {
    const id = await place();
    const elsewhere: SessionRef = { sessionId: randomUUID(), venueId: other.venue };
    expect(await buildHolds(deps(), elsewhere, [id])).toEqual([]);
    expect(mints).toBe(0);
  });

  it("entries follow the order of created, and a reservation named twice is minted once", async () => {
    const session = await newSession();
    const [a, b, c] = [await place(), await place(), await place()] as [string, string, string];
    const entries = await buildHolds(deps(), session, [c, a, b, a]);
    expect(entries.map((e) => e.reservation_id)).toEqual([c, a, b]);
    expect(mints).toBe(3);
    expect(await rowsOf(session)).toHaveLength(3);
  });

  it("a read or a mint that does not answer leaves the entry out", async () => {
    const session = await newSession();
    const id = await place();
    mode = "hang-read";
    expect(await buildHolds(deps({ timeoutMs: 50 }), session, [id])).toEqual([]);
    expect(mints).toBe(0);

    mode = "hang-mint";
    expect(await buildHolds(deps({ timeoutMs: 50 }), session, [id])).toEqual([]);
    expect(mints).toBe(1);
    expect(await rowsOf(session)).toHaveLength(0);
  });

  it("a token that could not be kept leaves the entry out", async () => {
    const session = await newSession();
    const id = await place();
    const failing: Dastar = {
      ...api.dastar,
      sessions: { ...api.dastar.sessions, putSessionHold: async () => { throw new Error("the database is down"); } },
    };
    expect(await buildHolds(deps({ dastar: failing }), session, [id])).toEqual([]);
    expect(await rowsOf(session)).toHaveLength(0);
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { DastarError, type Dastar } from "@dastar/db";
import { cloneDatabase, dropDatabase, connect, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedVenue, type Seed } from "../../../packages/db/test/helpers/seed.js";
import { createApp } from "../src/app.js";
import { createKey } from "../src/auth.js";
import { openApiDocument } from "../src/openapi.js";
import { makeApi, bearer, jsonInit, MIGRATIONS } from "./helpers.js";

type Key = { id: string; key: string };
type Json = Record<string, unknown>;
type Receipt = { reservation_id: string; status: string; version: number; audit_id: number; trace_id: string };
type HoldOut = { receipt: Receipt; hold_expires_at: string; replayed: boolean };
type Row = { tool: string; input: Json; status: number | null; output: Json | null; receipt: Json | null };

const NIL = "00000000-0000-0000-0000-000000000000";
const MISMATCH = "the call's venue is not the session's";

describe("the recorder on the v1 routes", () => {
  let conn: Conn; let owner: Client; let api: ReturnType<typeof makeApi>;
  let A: Seed; let B: Seed;
  let agent: Key; let wide: Key; let staff: Key; let rival: Key;
  let n = 0;

  beforeAll(async () => {
    conn = await cloneDatabase("api_recorder_test");
    owner = await connect(conn.owner);
    A = await seedVenue(owner);
    B = await seedVenue(owner);
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100 where id = any($1::uuid[])", [[A.venue, B.venue]]);
    api = makeApi(conn);
    agent = await createKey(api.pool, { label: "agent", capabilities: ["read", "hold", "cancel", "seat"], venueIds: [A.venue] });
    wide = await createKey(api.pool, { label: "wide", capabilities: ["read", "hold", "cancel"], venueIds: [A.venue, B.venue] });
    staff = await createKey(api.pool, { label: "staff", capabilities: ["hold", "confirm", "cancel", "read"], venueIds: [A.venue] });
    rival = await createKey(api.pool, { label: "rival", capabilities: ["read", "hold", "cancel"], venueIds: [A.venue] });
  });
  afterAll(async () => { await api.close(); await owner.end(); await dropDatabase("api_recorder_test"); });

  const json = async <T = Json>(r: Response): Promise<T> => await r.json() as T;

  /** An app whose handle is the test's, with some methods replaced, as ops.test builds its apps. */
  const withHandle = (patch: Partial<Dastar>): ReturnType<typeof createApp> =>
    createApp({ dastar: { ...api.dastar, ...patch }, pool: api.pool, migrationsDir: MIGRATIONS, log: () => undefined });

  type Opts = { app?: ReturnType<typeof createApp>; key?: Key; session?: string; body?: unknown; headers?: Record<string, string> };
  function send(method: string, path: string, opts: Opts = {}): Promise<Response> {
    const headers = { ...(opts.key ? bearer(opts.key.key) : {}), ...(opts.session !== undefined ? { "dastar-session": opts.session } : {}), ...opts.headers };
    return Promise.resolve((opts.app ?? api.app).request(path, opts.body === undefined ? { method, headers } : jsonInit(method, opts.body, headers)));
  }

  /** A hold body at a start time no other body of this file shares, so no two holds meet on a unit. */
  function holdBody(seed: Seed, over: Json = {}, unit = 0): Json {
    n += 1;
    const start = new Date(Date.UTC(2046, 5, 1 + Math.floor(n / 8), 8 + (n % 8)));
    return { party_size: 2, starts_at: start.toISOString(), duration_minutes: 60, assignment: { kind: "unit", id: seed.units[unit]! }, ...over };
  }
  async function placeHold(key: Key, seed: Seed, opts: { session?: string; app?: ReturnType<typeof createApp>; over?: Json; unit?: number } = {}) {
    const sent = holdBody(seed, opts.over, opts.unit);
    const idem = `rec-${n}`;
    const res = await send("POST", `/v1/venues/${seed.venue}/holds`, {
      key, body: sent, headers: { "idempotency-key": idem },
      ...(opts.session !== undefined ? { session: opts.session } : {}), ...(opts.app !== undefined ? { app: opts.app } : {}),
    });
    return { res, sent, idem };
  }
  /** A held reservation, placed without the header, so nothing is recorded. */
  async function heldBy(key: Key, seed: Seed): Promise<string> {
    const h = await placeHold(key, seed);
    expect(h.res.status).toBe(201);
    return (await json<HoldOut>(h.res)).receipt.reservation_id;
  }
  async function mint(key: Key, id: string): Promise<string> {
    const r = await send("POST", `/v1/reservations/${id}/confirm-token`, { key, body: {} });
    expect(r.status).toBe(201);
    return (await json<{ confirm_token: string }>(r)).confirm_token;
  }
  async function openSession(key: Key, venue: string): Promise<string> {
    const r = await send("POST", "/v1/sessions", { key, body: { venue_id: venue } });
    expect(r.status).toBe(201);
    return (await json<{ id: string }>(r)).id;
  }
  const reservationStatus = async (id: string, key: Key): Promise<string> =>
    (await json<{ status: string }>(await send("GET", `/v1/reservations/${id}`, { key }))).status;
  const reservationCount = async (venue: string): Promise<number> =>
    (await owner.query("select count(*)::int as n from dastar.reservation where venue_id = $1", [venue])).rows[0].n as number;
  const rows = async (session: string): Promise<Row[]> =>
    (await owner.query("select tool, input, status, output, receipt from dastar_agent.tool_call where session_id = $1 order by id", [session])).rows as Row[];

  it("records each of the nine routes under its tool name with exactly the stored fields, and no free text", async () => {
    const S = await openSession(agent, A.venue);
    // the API refuses a session for a key that can confirm, so the owner inserts one
    const T = (await owner.query("insert into dastar_agent.session (venue_id, api_key_id, kind) values ($1, $2, 'external') returning id", [A.venue, staff.id])).rows[0].id as string;
    const from = "2046-06-01T08:00:00.000Z";
    const to = "2046-06-01T10:00:00.000Z";

    const search = await send("POST", `/v1/venues/${A.venue}/availability`, { key: agent, session: S, body: { party_size: 2, from, to, limit: 3 } });
    expect(search.status).toBe(200);
    const offered = await json<{ slots: unknown[]; truncated: boolean }>(search);

    const h1 = await placeHold(agent, A, { session: S, over: { external_ref: "Jane Doe +49 30 1234567" } });
    expect(h1.res.status).toBe(201);
    const held = await json<HoldOut>(h1.res);
    const id1 = held.receipt.reservation_id;

    const list = await send("GET", `/v1/venues/${A.venue}/holds`, { key: agent, session: S });
    expect(list.status).toBe(200);
    const listed = (await json<{ holds: { id: string; starts_at: string; party_size: number; hold_expires_at: string }[] }>(list)).holds;
    const listedFields = listed.map((h) => ({ id: h.id, starts_at: h.starts_at, party_size: h.party_size, hold_expires_at: h.hold_expires_at }));
    expect(listedFields).toContainEqual(expect.objectContaining({ id: id1, starts_at: h1.sent.starts_at, party_size: 2 }));

    const got = await send("GET", `/v1/reservations/${id1}`, { key: agent, session: S });
    expect(got.status).toBe(200);
    const view = await json<{ starts_at: string; hold_expires_at: string }>(got);
    expect(view.starts_at).toBe(h1.sent.starts_at);

    const id2 = await heldBy(agent, A);
    const cancel = await send("POST", `/v1/reservations/${id2}/cancel`, { key: agent, session: S, body: { reason: "guest Jane called", expected_version: 1 } });
    expect(cancel.status).toBe(200);
    const cancelled = await json<{ receipt: Receipt }>(cancel);

    const id3 = await heldBy(agent, A);
    expect((await send("POST", `/v1/reservations/${id3}/confirm`, { key: staff, body: {} })).status).toBe(200);
    const seat = await send("POST", `/v1/reservations/${id3}/seat`, { key: agent, session: S, body: { expected_version: 2 } });
    expect(seat.status).toBe(200);
    const seated = await json<{ receipt: Receipt }>(seat);
    const complete = await send("POST", `/v1/reservations/${id3}/complete`, { key: agent, session: S, body: {} });
    expect(complete.status).toBe(200);
    const completed = await json<{ receipt: Receipt }>(complete);

    const id4 = await heldBy(agent, A);
    const token4 = await mint(staff, id4);
    const confirm = await send("POST", `/v1/reservations/${id4}/confirm`, { key: agent, session: S, body: { confirm_token: token4 } });
    expect(confirm.status).toBe(200);
    const confirmed = await json<{ receipt: Receipt }>(confirm);

    const id5 = await heldBy(agent, A);
    const refused = await send("POST", `/v1/reservations/${id5}/confirm`, { key: agent, session: S, body: {} });
    expect(refused.status).toBe(403);

    const minted = await send("POST", `/v1/reservations/${id5}/confirm-token`, { key: staff, session: T, body: { expected_version: 1 } });
    expect(minted.status).toBe(201);
    const token5 = await json<{ confirm_token: string; version: number }>(minted);

    const agentRows = await rows(S);
    expect(agentRows).toEqual([
      { tool: "search_availability", input: { party_size: 2, from, to }, status: 200, output: { slots: offered.slots.length, truncated: offered.truncated }, receipt: null },
      {
        tool: "hold",
        input: { party_size: 2, starts_at: h1.sent.starts_at, duration_minutes: 60, assignment: { kind: "unit", id: A.units[0] }, idempotency_key: h1.idem },
        status: 201, output: { hold_expires_at: held.hold_expires_at, replayed: false }, receipt: held.receipt,
      },
      { tool: "list_holds", input: {}, status: 200, output: { holds: listedFields }, receipt: null },
      {
        tool: "get_reservation", input: { reservation_id: id1 }, status: 200,
        output: { id: id1, status: "held", starts_at: view.starts_at, party_size: 2, hold_expires_at: view.hold_expires_at, version: 1 }, receipt: null,
      },
      { tool: "cancel", input: { reservation_id: id2, expected_version: 1 }, status: 200, output: {}, receipt: cancelled.receipt },
      { tool: "seat", input: { reservation_id: id3, expected_version: 2 }, status: 200, output: {}, receipt: seated.receipt },
      { tool: "complete", input: { reservation_id: id3 }, status: 200, output: {}, receipt: completed.receipt },
      { tool: "confirm", input: { reservation_id: id4 }, status: 200, output: {}, receipt: confirmed.receipt },
      { tool: "confirm", input: { reservation_id: id5 }, status: 403, output: { code: "forbidden" }, receipt: null },
    ]);
    const staffRows = await rows(T);
    expect(staffRows).toEqual([
      { tool: "confirm_token", input: { reservation_id: id5, expected_version: 1 }, status: 201, output: { version: token5.version }, receipt: null },
    ]);

    const text = JSON.stringify([...agentRows, ...staffRows]);
    for (const secret of ["Bearer", agent.key, staff.key, token4, token5.confirm_token, "Jane", "guest Jane called", "1234567", "the key lacks"]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it("a request without the header is not recorded, and other routes ignore it", async () => {
    const S = await openSession(agent, A.venue);
    const plain = await placeHold(agent, A);
    expect(plain.res.status).toBe(201);
    const admin = await createKey(api.pool, { label: "admin", capabilities: ["admin", "read"], venueIds: [A.venue] });
    expect((await send("GET", `/admin/venues/${A.venue}/units`, { key: admin, session: S })).status).toBe(200);
    const s = await send("GET", `/v1/sessions/${S}`, { key: agent, session: S });
    expect(s.status).toBe(200);
    expect(await json(s)).toMatchObject({ id: S, calls: 0 });
    expect(await rows(S)).toEqual([]);
  });

  it("the header without a bearer key is 400 and confirms nothing", async () => {
    const S = await openSession(agent, A.venue);
    const id = await heldBy(agent, A);
    const token = await mint(staff, id);
    const r = await send("POST", `/v1/reservations/${id}/confirm`, { session: S, body: { confirm_token: token } });
    expect(r.status).toBe(400);
    expect(await json(r)).toMatchObject({ code: "validation", detail: "Dastar-Session needs a bearer key" });
    expect(await reservationStatus(id, agent)).toBe("held");
    expect(await rows(S)).toEqual([]);
  });

  it("a session that is not the key's is 404 before any engine work", async () => {
    const mine = await heldBy(agent, A);
    const theirs = await openSession(rival, A.venue);
    const counts = { hold: 0, cancel: 0, findReservationVenue: 0 };
    const counting = withHandle({
      hold: (input, hooks) => { counts.hold += 1; return api.dastar.hold(input, hooks); },
      cancel: (input, hooks) => { counts.cancel += 1; return api.dastar.cancel(input, hooks); },
      findReservationVenue: (id) => { counts.findReservationVenue += 1; return api.dastar.findReservationVenue(id); },
    });
    const before = await reservationCount(A.venue);
    for (const session of [theirs, randomUUID()]) {
      const h = await send("POST", `/v1/venues/${A.venue}/holds`, { app: counting, key: agent, session, body: holdBody(A), headers: { "idempotency-key": `foreign-${session}` } });
      expect(h.status).toBe(404);
      expect(await json(h)).toMatchObject({ code: "not_found", detail: "no such session" });
      const c = await send("POST", `/v1/reservations/${mine}/cancel`, { app: counting, key: agent, session, body: { reason: "x" } });
      expect(c.status).toBe(404);
      expect(await json(c)).toMatchObject({ code: "not_found", detail: "no such session" });
    }
    expect(counts).toEqual({ hold: 0, cancel: 0, findReservationVenue: 0 });
    expect(await reservationCount(A.venue)).toBe(before);
    expect(await rows(theirs)).toEqual([]);
    expect(await reservationStatus(mine, agent)).toBe("held");
  });

  it("a call for another venue is 422 session_venue_mismatch before the command; a venue outside the key's is 404", async () => {
    const S = await openSession(wide, A.venue);
    const before = await reservationCount(B.venue);
    const h = await placeHold(wide, B, { session: S });
    expect(h.res.status).toBe(422);
    expect(await json(h.res)).toMatchObject({ code: "session_venue_mismatch", detail: MISMATCH });
    expect(await reservationCount(B.venue)).toBe(before);

    const inB = await heldBy(wide, B);
    const c = await send("POST", `/v1/reservations/${inB}/cancel`, { key: wide, session: S, body: { reason: "x" } });
    expect(c.status).toBe(422);
    expect(await json(c)).toMatchObject({ code: "session_venue_mismatch", detail: MISMATCH });
    expect(await reservationStatus(inB, wide)).toBe("held");

    const SA = await openSession(agent, A.venue);
    const outside = await placeHold(agent, B, { session: SA });
    expect(outside.res.status).toBe(404);
    expect(await json(outside.res)).toMatchObject({ code: "not_found", detail: "no such venue" });
    expect(await rows(S)).toEqual([]);
    expect(await rows(SA)).toEqual([]);
  });

  it("a reservation that does not exist is recorded as the 404 it answers", async () => {
    const S = await openSession(agent, A.venue);
    const r = await send("GET", `/v1/reservations/${NIL}`, { key: agent, session: S });
    expect(r.status).toBe(404);
    expect(await rows(S)).toEqual([
      { tool: "get_reservation", input: { reservation_id: NIL }, status: 404, output: { code: "not_found" }, receipt: null },
    ]);
  });

  it("a full session is 422 session_full before the command", async () => {
    const S = await openSession(agent, A.venue);
    await owner.query("update dastar_agent.session set call_count = 10000 where id = $1", [S]);
    const before = await reservationCount(A.venue);
    const h = await placeHold(agent, A, { session: S });
    expect(h.res.status).toBe(422);
    expect(await json(h.res)).toMatchObject({ code: "session_full", detail: "the session has recorded 10000 calls, its limit" });
    expect(await reservationCount(A.venue)).toBe(before);
    expect((await owner.query("select call_count from dastar_agent.session where id = $1", [S])).rows[0].call_count).toBe(10000);
    expect(await rows(S)).toEqual([]);
  });

  it("a request refused by validation is not recorded, and a malformed header is 400", async () => {
    const S = await openSession(agent, A.venue);
    const bad = await placeHold(agent, A, { session: S, over: { party_size: 0 } });
    expect(bad.res.status).toBe(400);
    expect(await json(bad.res)).toMatchObject({ code: "validation" });
    expect(await rows(S)).toEqual([]);
    const malformed = await placeHold(agent, A, { session: "abc" });
    expect(malformed.res.status).toBe(400);
    expect(await json(malformed.res)).toMatchObject({ code: "validation" });
  });

  it("an upper-case session id names the same session", async () => {
    const S = await openSession(agent, A.venue);
    const h = await placeHold(agent, A, { session: S.toUpperCase() });
    expect(h.res.status).toBe(201);
    const stored = await rows(S);
    expect(stored.map((r) => r.tool)).toEqual(["hold"]);
    expect(stored[0]!.status).toBe(201);
  });

  it("a completion that fails leaves the response as it was and the call pending", async () => {
    const S = await openSession(agent, A.venue);
    const app = withHandle({ sessions: { ...api.dastar.sessions, completeCall: () => Promise.reject(new Error("the database went away")) } });
    const h = await placeHold(agent, A, { session: S, app });
    expect(h.res.status).toBe(201);
    expect(await json(h.res)).toMatchObject({ receipt: { status: "held", version: 1 }, replayed: false });
    const stored = (await owner.query("select tool, status, completed_at from dastar_agent.tool_call where session_id = $1 order by id", [S])).rows;
    expect(stored).toEqual([{ tool: "hold", status: null, completed_at: null }]);
  });

  it("a recording that cannot start fails the request with 503 and does nothing", async () => {
    const S = await openSession(agent, A.venue);
    const app = withHandle({ sessions: { ...api.dastar.sessions, beginCall: () => Promise.reject(new DastarError("timeout", "x", undefined, true)) } });
    const before = await reservationCount(A.venue);
    const h = await placeHold(agent, A, { session: S, app });
    expect(h.res.status).toBe(503);
    expect(await json(h.res)).toMatchObject({ code: "timeout" });
    expect(await reservationCount(A.venue)).toBe(before);
    expect(await rows(S)).toEqual([]);
  });

  it("two holds sent at once in one session are both recorded", async () => {
    const S = await openSession(agent, A.venue);
    const [a, b] = await Promise.all([placeHold(agent, A, { session: S, unit: 2 }), placeHold(agent, A, { session: S, unit: 3 })]);
    expect(a.res.status).toBe(201);
    expect(b.res.status).toBe(201);
    const stored = await rows(S);
    expect(stored.map((r) => [r.tool, r.status])).toEqual([["hold", 201], ["hold", 201]]);
    expect(stored.map((r) => (r.input as { idempotency_key: string }).idempotency_key).sort()).toEqual([a.idem, b.idem].sort());
    const s = await send("GET", `/v1/sessions/${S}`, { key: agent });
    expect(await json(s)).toMatchObject({ calls: 2 });
  });

  it("the document declares the optional dastar-session header, a uuid, on the nine routes and on no other operation", () => {
    type Param = { name: string; in: string; required?: boolean; schema?: unknown };
    const doc = openApiDocument() as unknown as { paths: Record<string, Record<string, { parameters?: Param[] }>> };
    const nine = [
      "post /v1/venues/{id}/holds", "get /v1/venues/{id}/holds", "post /v1/venues/{id}/availability", "get /v1/reservations/{id}",
      "post /v1/reservations/{id}/cancel", "post /v1/reservations/{id}/seat", "post /v1/reservations/{id}/complete",
      "post /v1/reservations/{id}/confirm", "post /v1/reservations/{id}/confirm-token",
    ];
    const carrying: string[] = [];
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        const found = (op.parameters ?? []).filter((p) => p.name === "dastar-session");
        if (found.length > 0) carrying.push(`${method} ${path}`);
        if (nine.includes(`${method} ${path}`)) {
          expect(found, `${method} ${path}`).toHaveLength(1);
          expect(found[0], `${method} ${path}`).toMatchObject({ name: "dastar-session", in: "header", required: false, schema: { type: "string", format: "uuid" } });
        }
      }
    }
    expect(carrying.sort()).toEqual([...nine].sort());
  });
});

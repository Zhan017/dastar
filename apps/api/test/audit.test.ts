import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedVenue, type Seed } from "../../../packages/db/test/helpers/seed.js";
import { createApp } from "../src/app.js";
import { createKey } from "../src/auth.js";
import type { Dastar, FailedResult, JudgedResult } from "@dastar/db";
import { makeApi, bearer, jsonInit, MIGRATIONS } from "./helpers.js";

type Key = { id: string; key: string };
type Json = Record<string, unknown>;
type Receipt = { reservation_id: string; status: string; version: number; audit_id: number; trace_id: string };
type HoldOut = { receipt: Receipt; hold_expires_at: string; replayed: boolean };
type Result = {
  session_id: string; audited_at: string; mode: string; claims: Json; results: Json[]; receipts: { recorded: number; verified: number; unverified: Json[] };
  unknown_outcomes: number; confirmations: number; undeclared: unknown;
};
type Claim = { reservation_id: string; status: string; starts_at?: string; party_size?: number; quote?: string };
type Turn = { role: "user" | "assistant"; text: string; at?: string; claims?: Claim[] };

const TOO_LARGE = "request body too large";

describe("transcript intake and the audit", () => {
  let conn: Conn; let owner: Client; let api: ReturnType<typeof makeApi>;
  let A: Seed;
  let agent: Key; let staff: Key; let rival: Key;
  let n = 0;

  beforeAll(async () => {
    conn = await cloneDatabase("api_audit_test");
    owner = await connect(conn.owner);
    A = await seedVenue(owner);
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100 where id = $1", [A.venue]);
    api = makeApi(conn);
    agent = await createKey(api.pool, { label: "agent", capabilities: ["read", "hold", "cancel"], venueIds: [A.venue] });
    staff = await createKey(api.pool, { label: "staff", capabilities: ["hold", "confirm", "cancel", "read"], venueIds: [A.venue] });
    rival = await createKey(api.pool, { label: "rival", capabilities: ["read"], venueIds: [A.venue] });
  });
  afterAll(async () => { await api.close(); await owner.end(); await dropDatabase("api_audit_test"); });

  const json = async <T = Json>(r: Response): Promise<T> => await r.json() as T;

  /** An app whose handle is the test's, with some methods replaced, as recorder.test builds its apps. */
  const withHandle = (patch: Partial<Dastar>): ReturnType<typeof createApp> =>
    createApp({ dastar: { ...api.dastar, ...patch }, pool: api.pool, migrationsDir: MIGRATIONS, log: () => undefined });

  type Opts = { app?: ReturnType<typeof createApp>; key?: Key; session?: string; body?: unknown; headers?: Record<string, string> };
  function send(method: string, path: string, opts: Opts = {}): Promise<Response> {
    const headers = { ...(opts.key ? bearer(opts.key.key) : {}), ...(opts.session !== undefined ? { "dastar-session": opts.session } : {}), ...opts.headers };
    return Promise.resolve((opts.app ?? api.app).request(path, opts.body === undefined ? { method, headers } : jsonInit(method, opts.body, headers)));
  }
  const post = (id: string, body: unknown, key: Key | null = agent): Promise<Response> => send("POST", `/v1/sessions/${id}/audit`, { ...(key !== null ? { key } : {}), body });
  const read = (id: string, key: Key | null = agent): Promise<Response> => send("GET", `/v1/sessions/${id}/audit`, key !== null ? { key } : {});
  /** A body sent as it is, without being encoded as JSON here. */
  const postRaw = (id: string, text: string, key: Key | null = agent): Promise<Response> =>
    Promise.resolve(api.app.request(`/v1/sessions/${id}/audit`, { method: "POST", headers: { "content-type": "application/json", ...(key !== null ? bearer(key.key) : {}) }, body: text }));

  /** A hold body at a start time in 2064 that no other body of this file shares, so no two holds meet on a unit. */
  function holdBody(): Json {
    n += 1;
    const start = new Date(Date.UTC(2064, 0, 1 + Math.floor(n / 8), 8 + (n % 8)));
    return { party_size: 2, starts_at: start.toISOString(), duration_minutes: 60, assignment: { kind: "unit", id: A.units[0] } };
  }
  async function placeHold(key: Key, opts: { session?: string; app?: ReturnType<typeof createApp> } = {}) {
    const sent = holdBody();
    const res = await send("POST", `/v1/venues/${A.venue}/holds`, {
      key, body: sent, headers: { "idempotency-key": `audit-${n}` },
      ...(opts.session !== undefined ? { session: opts.session } : {}), ...(opts.app !== undefined ? { app: opts.app } : {}),
    });
    return { res, sent };
  }
  async function openSession(key: Key = agent): Promise<string> {
    const r = await send("POST", "/v1/sessions", { key, body: { venue_id: A.venue } });
    expect(r.status).toBe(201);
    return (await json<{ id: string }>(r)).id;
  }
  const turnCount = async (id: string): Promise<number> =>
    (await owner.query("select count(*)::int as n from dastar_agent.turn where session_id = $1", [id])).rows[0].n as number;
  const auditedAt = async (id: string): Promise<unknown> =>
    (await owner.query("select audited_at from dastar_agent.session where id = $1", [id])).rows[0].audited_at as unknown;
  const claimTurns = (ids: string[]): Turn[] => {
    const turns: Turn[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      turns.push({ role: "assistant", text: "held", claims: ids.slice(i, i + 50).map((reservation_id) => ({ reservation_id, status: "held" })) });
    }
    return turns;
  };
  const claimOf = (id: string): Claim => ({ reservation_id: id, status: "held" });

  it("audits a session end to end", async () => {
    const S = await openSession();
    const search = await send("POST", `/v1/venues/${A.venue}/availability`, {
      key: agent, session: S, body: { party_size: 2, from: "2064-01-01T08:00:00.000Z", to: "2064-01-01T10:00:00.000Z" },
    });
    expect(search.status).toBe(200);
    const heldA = await placeHold(agent, { session: S });
    expect(heldA.res.status).toBe(201);
    const idA = (await json<HoldOut>(heldA.res)).receipt.reservation_id;
    expect((await send("GET", `/v1/reservations/${idA}`, { key: agent, session: S })).status).toBe(200);
    const heldB = await placeHold(agent, { session: S });
    expect(heldB.res.status).toBe(201);
    const idB = (await json<HoldOut>(heldB.res)).receipt.reservation_id;
    expect((await send("POST", `/v1/reservations/${idB}/cancel`, { key: agent, session: S, body: { reason: "changed plans" } })).status).toBe(200);
    // the staff key confirms A without the header, so the session's log never sees it
    expect((await send("POST", `/v1/reservations/${idA}/confirm`, { key: staff, body: {} })).status).toBe(200);

    const at = new Date(Date.now() + 1000).toISOString();
    const absent = randomUUID();
    const claimA: Claim = { reservation_id: idA, status: "held", starts_at: heldA.sent.starts_at as string, party_size: 2 };
    const turns: Turn[] = [
      { role: "user", text: "Book me a table", at },
      { role: "assistant", text: "Table A is held and B is cancelled.", at, claims: [claimA, { reservation_id: idB, status: "cancelled" }] },
      { role: "assistant", text: "A is confirmed, and another is held.", at, claims: [{ reservation_id: idA, status: "confirmed" }, { reservation_id: absent, status: "held" }] },
    ];
    const r = await post(S, { turns });
    expect(r.status).toBe(200);
    const result = await json<Result>(r);
    expect(result).toMatchObject({
      session_id: S, mode: "timed", claims: { total: 4, backed: 2, unbacked: 2 },
      receipts: { recorded: 3, verified: 3, unverified: [] }, unknown_outcomes: 0, confirmations: 0, undeclared: "not checked",
    });
    expect(result.results).toHaveLength(4);
    expect(result.results[0]).toMatchObject({ turn: 1, claim: claimA, verdict: "backed", current_status: "confirmed", current_differs: true });
    expect(result.results[1]).toMatchObject({ turn: 1, claim: { reservation_id: idB, status: "cancelled" }, verdict: "backed", current_status: "cancelled", current_differs: false });
    expect(result.results[2]).toMatchObject({ turn: 2, verdict: "unbacked", reason: "status_mismatch" });
    expect(result.results[3]).toMatchObject({ turn: 2, claim: { reservation_id: absent }, verdict: "unbacked", reason: "no_observation", current_status: "unknown" });

    const again = await read(S);
    expect(again.status).toBe(200);
    expect(await json(again)).toEqual(result);
    const session = await json<{ audited_at: string | null; calls: number }>(await send("GET", `/v1/sessions/${S}`, { key: agent }));
    expect(session.audited_at).toBe(result.audited_at);
    expect(session.calls).toBe(5);
  });

  it("scrubs text and quotes before storing them, and keeps the claim's fields", async () => {
    const S = await openSession();
    const id = randomUUID();
    const startsAt = "2064-02-03T19:00:00+02:00";
    const turns: Turn[] = [{
      role: "assistant", text: "Booked for jane@example.com, call +49 30 1234567",
      claims: [{ reservation_id: id, status: "held", starts_at: startsAt, quote: "held for jane@example.com" }],
    }];
    const r = await post(S, { turns });
    expect(r.status).toBe(200);
    const result = await json<Result>(r);
    expect(result.results[0]).toMatchObject({ claim: { reservation_id: id, status: "held", starts_at: startsAt, quote: "held for [email]" } });

    const stored = (await owner.query("select seq, role, content, claims, at from dastar_agent.turn where session_id = $1 order by seq", [S])).rows;
    expect(stored).toEqual([{
      seq: 0, role: "assistant", content: "Booked for [email], call [phone]",
      claims: [{ reservation_id: id, status: "held", starts_at: startsAt, quote: "held for [email]" }], at: null,
    }]);
    expect(JSON.stringify(stored)).not.toContain("jane");
    expect(JSON.stringify(result)).not.toContain("jane");
  });

  it("stores a claim's reservation id in lower case", async () => {
    const S = await openSession();
    const id = randomUUID();
    const r = await post(S, { turns: [{ role: "assistant", text: "held", claims: [{ reservation_id: id.toUpperCase(), status: "held" }] }] });
    expect(r.status).toBe(200);
    expect((await json<Result>(r)).results[0]).toMatchObject({ claim: { reservation_id: id } });
    const stored = (await owner.query("select claims from dastar_agent.turn where session_id = $1", [S])).rows;
    expect(stored).toEqual([{ claims: [{ reservation_id: id, status: "held" }] }]);
  });

  it("a second post replaces the turns and the result", async () => {
    const S = await openSession();
    const first = await post(S, { turns: [
      { role: "user", text: "one" }, { role: "assistant", text: "two", claims: [claimOf(randomUUID())] }, { role: "user", text: "three" },
    ] });
    expect(first.status).toBe(200);
    expect((await json<Result>(first)).claims).toEqual({ total: 1, backed: 0, unbacked: 1 });
    expect(await turnCount(S)).toBe(3);

    const second = await post(S, { turns: [{ role: "user", text: "four" }, { role: "assistant", text: "five" }] });
    expect(second.status).toBe(200);
    const result = await json<Result>(second);
    expect(result.claims).toEqual({ total: 0, backed: 0, unbacked: 0 });
    expect(await turnCount(S)).toBe(2);
    const stored = (await owner.query("select seq, content from dastar_agent.turn where session_id = $1 order by seq", [S])).rows;
    expect(stored).toEqual([{ seq: 0, content: "four" }, { seq: 1, content: "five" }]);
    expect(await json(await read(S))).toEqual(result);
  });

  it("refuses a transcript that breaks the rules with 400, and stores nothing", async () => {
    const S = await openSession();
    const at = "2064-01-07T19:00:00+02:00";
    const longClaims = Array.from({ length: 51 }, () => claimOf(randomUUID()));
    const cases: { name: string; body: unknown; detail?: string }[] = [
      { name: "claims on a user turn", body: { turns: [{ role: "user", text: "hi", claims: [claimOf(randomUUID())] }] }, detail: "claims are allowed on assistant turns only" },
      { name: "at on one turn of two", body: { turns: [{ role: "user", text: "hi", at }, { role: "assistant", text: "hello" }] }, detail: "either every turn has at or none does" },
      { name: "no turns", body: { turns: [] } },
      { name: "501 turns", body: { turns: Array.from({ length: 501 }, () => ({ role: "user", text: "x" })) } },
      { name: "a text of 20001 characters", body: { turns: [{ role: "user", text: "x".repeat(20_001) }] } },
      { name: "51 claims on one turn", body: { turns: [{ role: "assistant", text: "held", claims: longClaims }] } },
      { name: "party_size 1000", body: { turns: [{ role: "assistant", text: "held", claims: [{ ...claimOf(randomUUID()), party_size: 1000 }] }] } },
      { name: "a quote of 501 characters", body: { turns: [{ role: "assistant", text: "held", claims: [{ ...claimOf(randomUUID()), quote: "q".repeat(501) }] }] } },
      { name: "status pending", body: { turns: [{ role: "assistant", text: "held", claims: [{ reservation_id: randomUUID(), status: "pending" }] }] } },
      { name: "an at without an offset", body: { turns: [{ role: "user", text: "hi", at: "2064-01-07T19:00:00" }] } },
      {
        name: "1001 distinct reservations over 21 turns", body: { turns: claimTurns(Array.from({ length: 1001 }, () => randomUUID())) },
        detail: "a transcript may claim at most 1000 distinct reservations",
      },
    ];
    for (const c of cases) {
      const r = await post(S, c.body);
      expect(r.status, c.name).toBe(400);
      const problem = await json<{ code: string; detail: string }>(r);
      expect(problem.code, c.name).toBe("validation");
      if (c.detail !== undefined) expect(problem.detail, c.name).toContain(c.detail);
    }
    expect(await turnCount(S)).toBe(0);
    expect(await auditedAt(S)).toBeNull();

    const edge = await post(S, { turns: claimTurns(Array.from({ length: 1000 }, () => randomUUID())) });
    expect(edge.status).toBe(200);
    expect((await json<Result>(edge)).claims).toEqual({ total: 1000, backed: 0, unbacked: 1000 });
  });

  it("counts the distinct reservations after lowercasing", async () => {
    const S = await openSession();
    const ids = Array.from({ length: 1000 }, () => randomUUID());
    const turns = claimTurns(ids);
    // the same 1000 reservations again in upper case are not 1000 more
    turns.push({ role: "assistant", text: "again", claims: ids.slice(0, 50).map((id) => ({ reservation_id: id.toUpperCase(), status: "held" })) });
    expect((await post(S, { turns })).status).toBe(200);
  });

  it("the audit route takes up to 1 MiB and every other route 64 KB", async () => {
    const S = await openSession();
    // 45 turns of 20000 characters: 900000 characters, under 1 MiB with the JSON around them
    const big = { turns: Array.from({ length: 45 }, () => ({ role: "user", text: "a".repeat(20_000) })) };
    const ok = await post(S, big);
    expect(ok.status).toBe(200);
    expect(await turnCount(S)).toBe(45);

    const over = await postRaw(S, "x".repeat(1024 * 1024 + 1));
    expect(over.status).toBe(400);
    expect(await json(over)).toMatchObject({ code: "validation", detail: TOO_LARGE });

    const hold = await send("POST", `/v1/venues/${A.venue}/holds`, {
      key: agent, headers: { "idempotency-key": "audit-big" }, body: { ...holdBody(), external_ref: "x".repeat(70_000) },
    });
    expect(hold.status).toBe(400);
    expect(await json(hold)).toMatchObject({ code: "validation", detail: TOO_LARGE });

    const sessions = async (): Promise<number> =>
      (await owner.query("select count(*)::int as n from dastar_agent.session")).rows[0].n as number;
    const before = await sessions();
    const opened = await send("POST", "/v1/sessions", { key: agent, body: { venue_id: A.venue, pad: "x".repeat(70_000) } });
    expect(opened.status).toBe(400);
    expect(await json(opened)).toMatchObject({ code: "validation", detail: TOO_LARGE });
    expect(await sessions()).toBe(before);

    // the key is checked before the body is read, so a large post without one is refused for that
    const keyless = await postRaw(S, JSON.stringify({ turns: [{ role: "user", text: "x".repeat(70_000) }] }), null);
    expect(keyless.status).toBe(401);
  });

  it("only the owning key may post or read the audit, and there is none before the first post", async () => {
    const S = await openSession();
    const turns = [{ role: "user", text: "hi" }];
    const posted = await post(S, { turns }, rival);
    expect(posted.status).toBe(404);
    expect(await json(posted)).toMatchObject({ code: "not_found", detail: "no such session" });
    const peeked = await read(S, rival);
    expect(peeked.status).toBe(404);
    expect(await json(peeked)).toMatchObject({ code: "not_found", detail: "no such session" });
    expect(await turnCount(S)).toBe(0);

    const none = await read(S, agent);
    expect(none.status).toBe(404);
    expect(await json(none)).toMatchObject({ code: "not_found", detail: "the session has no audit yet" });

    expect((await post(S, { turns }, null)).status).toBe(401);
    expect((await read(S, null)).status).toBe(401);
  });

  it("a reference session of the key is 404 no such session, and its turns stay", async () => {
    const S = (await owner.query(
      "insert into dastar_agent.session (venue_id, api_key_id, kind) values ($1, $2, 'reference') returning id", [A.venue, agent.id],
    )).rows[0].id as string;
    await owner.query("insert into dastar_agent.turn (session_id, venue_id, seq, role, content) values ($1, $2, 0, 'user', 'hi')", [S, A.venue]);

    const posted = await post(S, { turns: [{ role: "user", text: "hello" }] });
    expect(posted.status).toBe(404);
    expect(await json(posted)).toMatchObject({ code: "not_found", detail: "no such session" });
    expect(await turnCount(S)).toBe(1);
    expect(await auditedAt(S)).toBeNull();

    const got = await send("GET", `/v1/sessions/${S}`, { key: agent });
    expect(got.status).toBe(200);
    expect(await json(got)).toMatchObject({ id: S, kind: "reference" });
  });

  it("a session that is not live when the post reads it is 404 no such session", async () => {
    const S = await openSession();
    const app = withHandle({ sessions: { ...api.dastar.sessions, getSession: () => Promise.resolve(null) } });
    const r = await send("POST", `/v1/sessions/${S}/audit`, { app, key: agent, body: { turns: [{ role: "user", text: "hi" }] } });
    expect(r.status).toBe(404);
    expect(await json(r)).toMatchObject({ code: "not_found", detail: "no such session" });
    expect(await turnCount(S)).toBe(0);
    expect(await auditedAt(S)).toBeNull();
  });

  it("a receipt altered after it was recorded is listed unverified", async () => {
    const S = await openSession();
    const first = await placeHold(agent, { session: S });
    expect(first.res.status).toBe(201);
    const second = await placeHold(agent, { session: S });
    expect(second.res.status).toBe(201);
    const idB = (await json<HoldOut>(second.res)).receipt.reservation_id;
    expect((await send("POST", `/v1/reservations/${idB}/cancel`, { key: agent, session: S, body: { reason: "changed plans" } })).status).toBe(200);

    const row = (await owner.query("select id from dastar_agent.tool_call where session_id = $1 and tool = 'hold' order by id limit 1", [S])).rows[0] as { id: string };
    const altered = (await owner.query(
      "update dastar_agent.tool_call set receipt = jsonb_set(receipt, '{status}', '\"confirmed\"') where id = $1 returning receipt", [row.id],
    )).rows[0].receipt as Json;
    expect(altered).toMatchObject({ status: "confirmed" });

    const r = await post(S, { turns: [{ role: "assistant", text: "done" }] });
    expect(r.status).toBe(200);
    const result = await json<Result>(r);
    expect(result.receipts).toEqual({ recorded: 3, verified: 2, unverified: [{ call: Number(row.id), receipt: altered }] });
  });

  it("a token confirm made with the session key counts as a confirmation and backs a confirmed claim", async () => {
    const S = await openSession();
    const held = await placeHold(agent);
    expect(held.res.status).toBe(201);
    const id = (await json<HoldOut>(held.res)).receipt.reservation_id;
    const minted = await send("POST", `/v1/reservations/${id}/confirm-token`, { key: staff, body: {} });
    expect(minted.status).toBe(201);
    const token = (await json<{ confirm_token: string }>(minted)).confirm_token;
    const confirmed = await send("POST", `/v1/reservations/${id}/confirm`, { key: agent, session: S, body: { confirm_token: token } });
    expect(confirmed.status).toBe(200);

    const r = await post(S, { turns: [{ role: "assistant", text: "it is confirmed", claims: [{ reservation_id: id, status: "confirmed" }] }] });
    expect(r.status).toBe(200);
    const result = await json<Result>(r);
    expect(result.confirmations).toBe(1);
    expect(result.claims).toEqual({ total: 1, backed: 1, unbacked: 0 });
    expect(result.results[0]).toMatchObject({ verdict: "backed", current_status: "confirmed", current_differs: false });
  });

  it("a call that never completed counts as an unknown outcome", async () => {
    const S = await openSession();
    const app = withHandle({ sessions: { ...api.dastar.sessions, completeCall: () => Promise.reject(new Error("the database went away")) } });
    const held = await placeHold(agent, { session: S, app });
    expect(held.res.status).toBe(201);
    const id = (await json<HoldOut>(held.res)).receipt.reservation_id;

    const at = new Date(Date.now() + 1000).toISOString();
    const r = await post(S, { turns: [{ role: "assistant", text: "it is held", at, claims: [{ reservation_id: id, status: "held" }] }] });
    expect(r.status).toBe(200);
    const result = await json<Result>(r);
    expect(result.unknown_outcomes).toBe(1);
    expect(result.results[0]).toMatchObject({ verdict: "unbacked", reason: "no_observation" });
  });

  const JUDGED_AT = "2064-05-01T00:00:00.000Z";
  /** A judged turn with one declared statement and one undeclared statement that no observation backs. */
  function judged(quote: string, reservationId: string): JudgedResult {
    const claim = { reservation_id: reservationId, status: "held" as const };
    return {
      outcome: "judged", judged_at: JUDGED_AT, model: "judge-model", effort: "high", prompt_hash: "hash-1", mode: "coarse",
      statements: [{ quote: "declared", claim, declared: true }, { quote, claim, declared: false }], dropped: 0,
      results: [{ quote, claim, verdict: "unbacked", reason: "no_observation", current_status: "unknown", current_differs: false }],
      accuracy: null, usage: { input: 10, output: 5, cache_read: 0, cache_write: 0 },
    };
  }
  const failedResult: FailedResult = { outcome: "failed", judged_at: JUDGED_AT, prompt_hash: "hash-1", reason: "refused" };
  /** What the judge does for a turn: its result written by the owner, as the judge's role writes it. */
  const writeResult = (session: string, seq: number, result: unknown) =>
    owner.query("update dastar_agent.turn set judge_result = $3::jsonb where session_id = $1 and seq = $2", [session, seq, JSON.stringify(result)]);
  const judgeRequested = async (id: string): Promise<boolean> =>
    (await owner.query("select judge_requested from dastar_agent.session where id = $1", [id])).rows[0].judge_requested as boolean;
  const storedResults = async (id: string): Promise<unknown[]> =>
    (await owner.query("select judge_result from dastar_agent.turn where session_id = $1 order by seq", [id])).rows.map((r) => r.judge_result as unknown);
  const judgeTurns: Turn[] = [
    { role: "user", text: "Book me a table" }, { role: "assistant", text: "It is held." },
    { role: "user", text: "And the other?" }, { role: "assistant", text: "That one is held too." },
  ];

  it("a post without judge answers and stores undeclared 'not checked'", async () => {
    const S = await openSession();
    const r = await post(S, { turns: judgeTurns });
    expect(r.status).toBe(200);
    const result = await json<Result>(r);
    expect(result.undeclared).toBe("not checked");
    expect(await judgeRequested(S)).toBe(false);
    expect(await json(await read(S))).toEqual(result);

    const explicit = await post(S, { turns: judgeTurns, judge: false });
    expect(explicit.status).toBe(200);
    expect((await json<Result>(explicit)).undeclared).toBe("not checked");
    expect(await judgeRequested(S)).toBe(false);
    expect((await json<Result>(await read(S))).undeclared).toBe("not checked");
  });

  it("a post with judge: true answers 'pending' and the read stays pending until every assistant turn has a result", async () => {
    const S = await openSession();
    const r = await post(S, { turns: judgeTurns, judge: true });
    expect(r.status).toBe(200);
    const result = await json<Result>(r);
    expect(result.undeclared).toBe("pending");
    expect(await judgeRequested(S)).toBe(true);
    expect(await json(await read(S))).toEqual(result);

    const first = judged("it is held", randomUUID());
    const second = judged("that one is held too", randomUUID());
    await writeResult(S, 1, first);
    expect(await json(await read(S))).toEqual(result);

    await writeResult(S, 3, second);
    const done = await read(S);
    expect(done.status).toBe(200);
    expect(await json(done)).toEqual({
      ...result,
      undeclared: {
        checked_turns: 2, failed_turns: 0, statements: 4, declared: 2,
        undeclared: { total: 2, backed: 0, unbacked: 2, unresolved: 0 },
        results: [{ ...first.results[0], turn: 1 }, { ...second.results[0], turn: 3 }],
        judges: [{ model: "judge-model", effort: "high", prompt_hash: "hash-1", accuracy: null }],
      },
    });
  });

  it("a failed turn counts in failed_turns", async () => {
    const S = await openSession();
    const r = await post(S, { turns: judgeTurns, judge: true });
    expect(r.status).toBe(200);
    const first = judged("it is held", randomUUID());
    await writeResult(S, 1, first);
    await writeResult(S, 3, failedResult);
    expect((await json<Result>(await read(S))).undeclared).toEqual({
      checked_turns: 1, failed_turns: 1, statements: 2, declared: 1,
      undeclared: { total: 1, backed: 0, unbacked: 1, unresolved: 0 },
      results: [{ ...first.results[0], turn: 1 }],
      judges: [{ model: "judge-model", effort: "high", prompt_hash: "hash-1", accuracy: null }],
    });

    const T = await openSession();
    expect((await post(T, { turns: judgeTurns.slice(0, 2), judge: true })).status).toBe(200);
    await writeResult(T, 1, failedResult);
    expect((await json<Result>(await read(T))).undeclared).toEqual({
      checked_turns: 0, failed_turns: 1, statements: 0, declared: 0,
      undeclared: { total: 0, backed: 0, unbacked: 0, unresolved: 0 }, results: [], judges: [],
    });
  });

  it("a post with judge: true and no assistant turn answers the zero summary, as the next read does", async () => {
    const S = await openSession();
    const r = await post(S, { turns: [{ role: "user", text: "Book me a table" }, { role: "user", text: "Are you there?" }], judge: true });
    expect(r.status).toBe(200);
    const result = await json<Result>(r);
    expect(result.undeclared).toEqual({
      checked_turns: 0, failed_turns: 0, statements: 0, declared: 0,
      undeclared: { total: 0, backed: 0, unbacked: 0, unresolved: 0 }, results: [], judges: [],
    });
    expect(await judgeRequested(S)).toBe(true);
    expect(await json(await read(S))).toEqual(result);
  });

  it("a later post without judge reads 'not checked' and its turns have no result", async () => {
    const S = await openSession();
    expect((await post(S, { turns: judgeTurns, judge: true })).status).toBe(200);
    await writeResult(S, 1, judged("it is held", randomUUID()));
    await writeResult(S, 3, judged("that one is held too", randomUUID()));
    expect(typeof (await json<Result>(await read(S))).undeclared).toBe("object");

    const later = await post(S, { turns: judgeTurns });
    expect(later.status).toBe(200);
    const result = await json<Result>(later);
    expect(result.undeclared).toBe("not checked");
    expect(await judgeRequested(S)).toBe(false);
    expect(await storedResults(S)).toEqual([null, null, null, null]);
    expect(await json(await read(S))).toEqual(result);
  });

  it("judge must be a boolean", async () => {
    const S = await openSession();
    for (const judge of ["true", 1, null]) {
      const r = await post(S, { turns: judgeTurns, judge });
      expect(r.status, JSON.stringify(judge)).toBe(400);
      expect(await json(r), JSON.stringify(judge)).toMatchObject({ code: "validation" });
    }
    expect(await turnCount(S)).toBe(0);
    expect(await auditedAt(S)).toBeNull();
  });

  it("an audit stored before this change reads as stored", async () => {
    const source = await openSession();
    const stored = await json<Result>(await post(source, { turns: judgeTurns }));
    const S = await openSession();
    await owner.query("update dastar_agent.session set audit = $2::jsonb, audited_at = now() where id = $1", [S, JSON.stringify(stored)]);
    expect(await judgeRequested(S)).toBe(false);
    const r = await read(S);
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual(stored);
  });
});

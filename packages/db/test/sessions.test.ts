import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool, type Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { setClock } from "./helpers/clock.js";
import { seedVenue, seedKey, type Seed } from "./helpers/seed.js";
import { connectAs, waitForBackend, pause, outcome, deadlockCount, type Outcome } from "./helpers/wait.js";
import { createDastar, type Dastar } from "../src/handle.js";
import { hold, type HoldInput, type Receipt } from "../src/commands/hold.js";
import { confirm } from "../src/commands/confirm.js";
import { currentStatuses } from "../src/commands/get.js";
import {
  MAX_SESSION_CALLS, beginCall, completeCall, auditInputs, storeAudit,
  type SessionHooks, type SessionView, type StoredTurn, type BeginCallOutcome,
} from "../src/commands/sessions.js";

describe("agent sessions", () => {
  let conn: Conn; let owner: Client; let app: Client; let lockA: Client; let lockB: Client;
  let pool: Pool; let d: Dastar;
  let A: Seed; let B: Seed;
  let key: string; let otherKey: string;
  let n = 0;
  const ABSENT = "00000000-0000-7000-8000-000000000000";
  const LOCK_B = "sess-lock-B";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  beforeAll(async () => {
    conn = await cloneDatabase("sessions_test");
    owner = await connect(conn.owner);
    app = await connect(conn.app);
    lockA = await connectAs(conn.app, "sess-lock-A");
    lockB = await connectAs(conn.app, LOCK_B);
    pool = new Pool({ connectionString: conn.app, max: 4, application_name: "sess-pool" });
    pool.on("error", () => undefined);
    d = createDastar({ pool });
    A = await seedVenue(owner);
    B = await seedVenue(owner);
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100 where id = any($1::uuid[])", [[A.venue, B.venue]]);
    key = await seedKey(owner);
    otherKey = await seedKey(owner);
  });
  afterAll(async () => {
    await d.close();
    await pool.end();
    await lockB.end(); await lockA.end(); await app.end(); await owner.end();
    await dropDatabase("sessions_test");
  });

  const open = (seed: Seed = A, apiKeyId: string = key): Promise<SessionView> => d.sessions.openSession({ venueId: seed.venue, apiKeyId });
  const begin = (s: { id: string }, seed: Seed = A, input: Record<string, unknown> = {}): Promise<BeginCallOutcome> =>
    d.sessions.beginCall({ sessionId: s.id, venueId: seed.venue, tool: "hold", input });
  /** A call begun in the session; a refusal fails the test. */
  async function begun(s: { id: string }, input: Record<string, unknown> = {}): Promise<number> {
    const out = await begin(s, A, input);
    if (!out.ok) throw new Error(`beginCall refused: ${out.reason}`);
    return out.callId;
  }
  const callRow = async (id: number) => (await owner.query("select * from dastar_agent.tool_call where id = $1", [id])).rows[0];
  const sessionRow = async (id: string) =>
    (await owner.query("select call_count, last_seen_at::text as last_seen_at, audit, audited_at from dastar_agent.session where id = $1", [id])).rows[0];
  const callCount = async (id: string): Promise<number> => (await sessionRow(id)).call_count as number;
  const callRows = async (id: string): Promise<number> =>
    (await owner.query("select count(*)::int as n from dastar_agent.tool_call where session_id = $1", [id])).rows[0].n as number;
  const turnRows = async (id: string) =>
    (await owner.query("select seq, role, content, claims, at from dastar_agent.turn where session_id = $1 order by seq", [id])).rows;
  /** The session as if it was last seen `hours` ago. */
  const ageSession = (id: string, hours: number) =>
    owner.query("update dastar_agent.session set last_seen_at = now() - make_interval(hours => $2::int) where id = $1", [id, hours]);
  const turns = (count: number): StoredTurn[] =>
    Array.from({ length: count }, (_, i) => ({ seq: i, role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i}`, claims: null, at: null }));
  const snake = (r: Receipt) => ({ reservation_id: r.reservationId, status: r.status, version: r.version, audit_id: r.auditId, trace_id: r.traceId });

  /** One hold through the engine; every call gets its own day, so no overlap is in the way. */
  async function place(seed: Seed): Promise<{ id: string; receipt: Receipt }> {
    n += 1;
    const input: HoldInput = {
      venueId: seed.venue, actor: "key:sess", traceId: `sess-trace-${n}`, idempotencyKey: `sess-k${n}`,
      partySize: 2, startsAt: new Date(Date.UTC(2050, 0, 1 + n, 19)).toISOString(), durationMinutes: 90,
      assignment: { kind: "unit", id: seed.units[0]! },
    };
    const out = await hold(app, input);
    if (!out.ok) throw new Error(out.error.code);
    return { id: out.receipt.reservationId, receipt: out.receipt };
  }

  /**
   * Two commands race for one session's row lock. `first` runs on connection A and stops right before its commit, holding
   * the row; `second` starts only once A is there, on connection B, and A is released only when B's backend is observed
   * waiting on a lock. The order is observed, never assumed.
   */
  async function raceForSession<T, U>(first: (hooks: SessionHooks) => Promise<T>, second: () => Promise<U>): Promise<{ first: Outcome<T>; second: Outcome<U> }> {
    const p = pause();
    const a = outcome(first({ beforeCommit: p.hook }));
    try {
      await p.reached;
      const b = outcome(second());
      await waitForBackend(owner, LOCK_B, { type: "Lock" });
      p.release();
      return { first: await a, second: await b };
    } finally {
      p.release();
    }
  }
  /** The value of a settled command; a command that failed rethrows its error. */
  function value<T>(o: Outcome<T>): T {
    if (!o.ok) throw o.error instanceof Error ? o.error : new Error(String(o.error));
    return o.value;
  }

  it("opens an external session with no calls and no audit", async () => {
    const v = await open();
    expect(v).toEqual({
      id: expect.stringMatching(UUID), venueId: A.venue, kind: "external", startedAt: expect.any(String), lastSeenAt: expect.any(String),
      calls: 0, auditedAt: null,
    });
    expect(v.startedAt).toBe(v.lastSeenAt);
    expect(new Date(v.startedAt).toISOString()).toBe(v.startedAt);
    const row = (await owner.query("select api_key_id, kind::text as kind, call_count, audit from dastar_agent.session where id = $1", [v.id])).rows[0];
    expect(row).toEqual({ api_key_id: key, kind: "external", call_count: 0, audit: null });
  });

  it("a venue that does not exist is not_found", async () => {
    await expect(d.sessions.openSession({ venueId: ABSENT, apiKeyId: key })).rejects.toMatchObject({ name: "DastarError", code: "not_found" });
  });

  it("sessionVenue answers the owning key only", async () => {
    const s = await open(A, key);
    expect(await d.sessions.sessionVenue({ sessionId: s.id, apiKeyId: key })).toBe(A.venue);
    expect(await d.sessions.sessionVenue({ sessionId: s.id, apiKeyId: otherKey })).toBeNull();
    expect(await d.sessions.sessionVenue({ sessionId: ABSENT, apiKeyId: key })).toBeNull();
  });

  it("getSession reads a session in its own venue only", async () => {
    const s = await open();
    expect(await d.sessions.getSession({ sessionId: s.id, venueId: A.venue })).toEqual(s);
    expect(await d.sessions.getSession({ sessionId: s.id, venueId: B.venue })).toBeNull();
    expect(await d.sessions.getSession({ sessionId: ABSENT, venueId: A.venue })).toBeNull();
  });

  it("beginCall records a pending call, counts it, and touches last_seen_at", async () => {
    const s = await open();
    await owner.query("update dastar_agent.session set last_seen_at = now() - interval '1 day' where id = $1", [s.id]);
    const out = await begin(s, A, { party_size: 2 });
    expect(out).toEqual({ ok: true, callId: expect.any(Number) });
    const id = (out as { callId: number }).callId;
    expect(await callRow(id)).toMatchObject({
      session_id: s.id, venue_id: A.venue, tool: "hold", input: { party_size: 2 }, status: null, output: null, receipt: null, completed_at: null,
    });
    const row = (await owner.query("select call_count, now() - last_seen_at < interval '1 minute' as fresh from dastar_agent.session where id = $1", [s.id])).rows[0];
    expect(row).toEqual({ call_count: 1, fresh: true });
  });

  it("beginCall at MAX_SESSION_CALLS is full and records nothing", async () => {
    const s = await open();
    await owner.query("update dastar_agent.session set call_count = $2 where id = $1", [s.id, MAX_SESSION_CALLS - 1]);
    expect(await begin(s)).toEqual({ ok: true, callId: expect.any(Number) });
    expect(await begin(s)).toEqual({ ok: false, reason: "full" });
    expect(await callCount(s.id)).toBe(MAX_SESSION_CALLS);
    expect(await callRows(s.id)).toBe(1);
  });

  it("beginCall on a session that is gone, in another venue, or no longer live is missing", async () => {
    expect(await begin({ id: ABSENT })).toEqual({ ok: false, reason: "missing" });

    const inA = await open(A);
    const inB = await open(B);
    expect(await begin(inB, A)).toEqual({ ok: false, reason: "missing" });
    expect(await begin(inA, B)).toEqual({ ok: false, reason: "missing" });

    const stale = await open();
    await ageSession(stale.id, 721);
    const before = await sessionRow(stale.id);
    expect(await begin(stale)).toEqual({ ok: false, reason: "missing" });
    await owner.query("update dastar_agent.session set call_count = $2 where id = $1", [stale.id, MAX_SESSION_CALLS]);
    const full = await sessionRow(stale.id);
    expect(await begin(stale)).toEqual({ ok: false, reason: "missing" });
    expect(await sessionRow(stale.id)).toEqual(full);
    expect(before.call_count).toBe(0);
    expect(full.call_count).toBe(MAX_SESSION_CALLS);
    expect(full.last_seen_at).toBe(before.last_seen_at);

    for (const s of [inA, inB, stale]) expect(await callRows(s.id)).toBe(0);
    expect(await callCount(inA.id)).toBe(0);
    expect(await callCount(inB.id)).toBe(0);
  });

  it("storeAudit on a session that is no longer live is not_found and stores nothing", async () => {
    const s = await open();
    await ageSession(s.id, 721);
    await expect(d.sessions.storeAudit({ sessionId: s.id, venueId: A.venue, turns: turns(2), result: { n: 1 }, auditedAt: new Date().toISOString() }))
      .rejects.toMatchObject({ name: "DastarError", code: "not_found" });
    expect(await turnRows(s.id)).toEqual([]);
    const row = await sessionRow(s.id);
    expect(row.audit).toBeNull();
    expect(row.audited_at).toBeNull();
  });

  it("storeAudit on a session of another venue or one that is gone is not_found", async () => {
    const s = await open(A);
    const input = { turns: turns(1), result: { n: 1 }, auditedAt: new Date().toISOString() };
    await expect(d.sessions.storeAudit({ sessionId: s.id, venueId: B.venue, ...input })).rejects.toMatchObject({ code: "not_found" });
    await expect(d.sessions.storeAudit({ sessionId: ABSENT, venueId: A.venue, ...input })).rejects.toMatchObject({ code: "not_found" });
    expect(await turnRows(s.id)).toEqual([]);
    expect((await sessionRow(s.id)).audit).toBeNull();
  });

  it("storeAudit refuses a reference session and leaves its turns", async () => {
    const id = (await owner.query(
      "insert into dastar_agent.session (venue_id, api_key_id, kind) values ($1, $2, 'reference') returning id", [A.venue, key],
    )).rows[0].id as string;
    await owner.query("insert into dastar_agent.turn (session_id, venue_id, seq, role, content) values ($1, $2, 0, 'user', 'hi')", [id, A.venue]);
    await expect(d.sessions.storeAudit({ sessionId: id, venueId: A.venue, turns: turns(2), result: { n: 1 }, auditedAt: new Date().toISOString() }))
      .rejects.toMatchObject({ name: "DastarError", code: "not_found" });
    expect(await turnRows(id)).toMatchObject([{ seq: 0, role: "user", content: "hi" }]);
    const row = await sessionRow(id);
    expect(row.audit).toBeNull();
    expect(row.audited_at).toBeNull();
  });

  it("completeCall stores the outcome once and never overwrites it", async () => {
    const s = await open();
    const id = await begun(s);
    await d.sessions.completeCall({ sessionId: s.id, venueId: A.venue, callId: id, status: 201, output: { a: 1 }, receipt: { b: 2 } });
    const first = await callRow(id);
    expect(first).toMatchObject({ status: 201, output: { a: 1 }, receipt: { b: 2 } });
    expect(first.completed_at).toBeInstanceOf(Date);

    await d.sessions.completeCall({ sessionId: s.id, venueId: A.venue, callId: id, status: 500, output: { z: 9 }, receipt: null });
    expect(await callRow(id)).toEqual(first);
    // a call of another session is not touched either
    const other = await open();
    const otherId = await begun(other);
    await d.sessions.completeCall({ sessionId: s.id, venueId: A.venue, callId: otherId, status: 200, output: {}, receipt: null });
    expect((await callRow(otherId)).completed_at).toBeNull();
  });

  it("auditInputs returns every call in id order, each receipt checked against the audit log", async () => {
    const s = await open();
    const bystander = await open();
    const r1 = await place(A);
    const r2 = await place(A);
    const rec = snake(r1.receipt);
    expect(rec.trace_id).toMatch(/^sess-trace-/);
    const withoutTrace = Object.fromEntries(Object.entries(rec).filter(([k]) => k !== "trace_id"));
    const cases: [string, Record<string, unknown> | null, boolean | null][] = [
      ["as issued", rec, true],
      ["another status", { ...rec, status: "confirmed" }, false],
      ["another version", { ...rec, version: rec.version + 1 }, false],
      ["another trace", { ...rec, trace_id: "sess-other-trace" }, false],
      ["the audit row of another reservation", { ...rec, audit_id: r2.receipt.auditId }, false],
      ["an audit id that is not a number", { ...rec, audit_id: "x" }, false],
      ["an audit id of twenty digits", { ...rec, audit_id: "99999999999999999999" }, false],
      ["an audit id of nothing", { ...rec, audit_id: null }, false],
      ["a reservation id that is not a uuid", { ...rec, reservation_id: "r" }, false],
      ["a trace id missing", withoutTrace, false],
      ["no keys at all", {}, false],
      ["a refusal with no receipt", null, null],
    ];
    const ids: number[] = [];
    const expected: (boolean | null)[] = [];
    for (const [, receipt, verified] of cases) {
      const id = await begun(s, { party_size: 2 });
      await d.sessions.completeCall({ sessionId: s.id, venueId: A.venue, callId: id, status: receipt === null ? 409 : 200, output: { ok: receipt !== null }, receipt });
      ids.push(id);
      expected.push(verified);
    }
    // receipts the API never writes, put in by hand: a control that verifies, and values that are not objects or carry a number written 1.0
    const raw: [string, string, boolean][] = [
      ["the receipt as issued, written by hand", JSON.stringify(rec), true],
      ["an array", "[1]", false],
      ["a string", "\"x\"", false],
      ["a json null", "null", false],
      ["a version written 1.0", JSON.stringify(rec).replace("\"version\":1,", "\"version\":1.0,"), false],
    ];
    for (const [, text, verified] of raw) {
      const id = await begun(s);
      await d.sessions.completeCall({ sessionId: s.id, venueId: A.venue, callId: id, status: 200, output: {}, receipt: {} });
      await owner.query("update dastar_agent.tool_call set receipt = $2::jsonb where id = $1", [id, text]);
      ids.push(id);
      expected.push(verified);
    }
    // a pending call, and a call of another session that is not in the answer
    ids.push(await begun(s));
    expected.push(null);
    await begun(bystander);

    const got = await d.sessions.auditInputs({ sessionId: s.id, venueId: A.venue, reservationIds: [r1.id] });
    expect(got.calls.map((c) => c.id)).toEqual(ids);
    expect(got.calls.map((c) => c.receiptVerified)).toEqual(expected);
    expect(got.calls[0]).toEqual({
      id: ids[0], tool: "hold", input: { party_size: 2 }, status: 200, output: { ok: true }, receipt: rec, receiptVerified: true,
      startedAt: expect.any(String), completedAt: expect.any(String),
    });
    expect(new Date(got.calls[0]!.startedAt).toISOString()).toBe(got.calls[0]!.startedAt);
    expect(new Date(got.calls[0]!.completedAt!).toISOString()).toBe(got.calls[0]!.completedAt);
    expect(got.calls[cases.length - 1]).toMatchObject({ status: 409, output: { ok: false }, receipt: null, receiptVerified: null, completedAt: expect.any(String) });
    expect(got.calls[got.calls.length - 1]).toMatchObject({ status: null, output: null, receipt: null, receiptVerified: null, completedAt: null });
    expect(new Date(got.readAt).toISOString()).toBe(got.readAt);
    expect(Math.abs(Date.now() - new Date(got.readAt).getTime())).toBeLessThan(60_000);
    expect(got.current).toEqual({ [r1.id]: "held" });
  });

  it("currentStatuses and auditInputs read effective status in the venue", async () => {
    const stillHeld = await place(A);
    const confirmed = await place(A);
    await confirm(app, { reservationId: confirmed.id, actor: "key:sess", traceId: `sess-confirm-${++n}`, venueId: A.venue });
    const inB = await place(B);
    const s = await open();
    const ids = [stillHeld.id, confirmed.id, inB.id, ABSENT];
    const later = new Date(Date.now() + 3_600_000).toISOString();

    await setClock(app, later);
    try {
      // the hold is past its expiry on this clock, and the sweeper has not run
      expect(await currentStatuses(app, { venueId: A.venue, reservationIds: ids })).toEqual({ [stillHeld.id]: "expired", [confirmed.id]: "confirmed" });
      const got = await auditInputs(app, { sessionId: s.id, venueId: A.venue, reservationIds: ids });
      expect(got.current).toEqual({ [stillHeld.id]: "expired", [confirmed.id]: "confirmed" });
      expect(got.readAt).toBe(later);
    } finally {
      await setClock(app, null);
    }
    expect((await owner.query("select status::text as status from dastar.reservation where id = $1", [stillHeld.id])).rows[0].status).toBe("held");
    expect(await currentStatuses(app, { venueId: A.venue, reservationIds: ids })).toEqual({ [stillHeld.id]: "held", [confirmed.id]: "confirmed" });
    expect(await d.currentStatuses({ venueId: B.venue, reservationIds: ids })).toEqual({ [inB.id]: "held" });
    expect(await d.currentStatuses({ venueId: A.venue, reservationIds: [] })).toEqual({});
  });

  it("storeAudit replaces the turns and stores the result", async () => {
    const s = await open();
    await d.sessions.storeAudit({ sessionId: s.id, venueId: A.venue, turns: turns(3), result: { n: 1 }, auditedAt: new Date(Date.now() - 5_000).toISOString() });
    expect(await turnRows(s.id)).toHaveLength(3);
    expect(await d.sessions.getAudit({ sessionId: s.id, venueId: A.venue })).toEqual({ n: 1 });

    const claims = [{ reservation_id: ABSENT, status: "held", party_size: 2 }];
    const second: StoredTurn[] = [
      { seq: 0, role: "user", content: "a table for two?", claims: null, at: "2050-03-01T18:00:00.000Z" },
      { seq: 1, role: "assistant", content: "it is held", claims, at: "2050-03-01T18:00:05.000Z" },
    ];
    const auditedAt = new Date().toISOString();
    await d.sessions.storeAudit({ sessionId: s.id, venueId: A.venue, turns: second, result: { n: 2 }, auditedAt });
    const rows = await turnRows(s.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => ({ seq: r.seq, role: r.role, content: r.content, claims: r.claims, at: r.at === null ? null : (r.at as Date).toISOString() }))).toEqual(second);
    expect(await d.sessions.getAudit({ sessionId: s.id, venueId: A.venue })).toEqual({ n: 2 });
    expect((await d.sessions.getSession({ sessionId: s.id, venueId: A.venue }))?.auditedAt).toBe(auditedAt);
  });

  it("getAudit is null before the first audit", async () => {
    const s = await open();
    expect(await d.sessions.getAudit({ sessionId: s.id, venueId: A.venue })).toBeNull();
    expect(await d.sessions.getAudit({ sessionId: ABSENT, venueId: A.venue })).toBeNull();
  });

  it("getAudit reads a session in its own venue only", async () => {
    const s = await open();
    await d.sessions.storeAudit({ sessionId: s.id, venueId: A.venue, turns: [], result: { n: 1 }, auditedAt: new Date().toISOString() });
    expect(await d.sessions.getAudit({ sessionId: s.id, venueId: A.venue })).toEqual({ n: 1 });
    expect(await d.sessions.getAudit({ sessionId: s.id, venueId: B.venue })).toBeNull();
  });

  it("getSession and getAudit of a session no longer live are null", async () => {
    const s = await open();
    await d.sessions.storeAudit({ sessionId: s.id, venueId: A.venue, turns: turns(1), result: { n: 1 }, auditedAt: new Date().toISOString() });
    await ageSession(s.id, 721);
    expect(await d.sessions.getSession({ sessionId: s.id, venueId: A.venue })).toBeNull();
    expect(await d.sessions.getAudit({ sessionId: s.id, venueId: A.venue })).toBeNull();
    await owner.query("update dastar_agent.session set last_seen_at = now() where id = $1", [s.id]);
    expect(await d.sessions.getSession({ sessionId: s.id, venueId: A.venue })).toMatchObject({ id: s.id, venueId: A.venue });
    expect(await d.sessions.getAudit({ sessionId: s.id, venueId: A.venue })).toEqual({ n: 1 });
  });

  it("a call begun while an audit is being stored waits for it, then both finish", async () => {
    const s = await open();
    const deadlocks = await deadlockCount(owner);
    const r = await raceForSession(
      (hooks) => storeAudit(lockA, { sessionId: s.id, venueId: A.venue, turns: turns(2), result: { n: 1 }, auditedAt: new Date().toISOString() }, hooks),
      () => beginCall(lockB, { sessionId: s.id, venueId: A.venue, tool: "hold", input: {} }),
    );
    expect(r.first.ok).toBe(true);
    expect(value(r.second)).toEqual({ ok: true, callId: expect.any(Number) });
    expect(await callCount(s.id)).toBe(1);
    expect(await callRows(s.id)).toBe(1);
    expect((await sessionRow(s.id)).audit).toEqual({ n: 1 });
    expect(await turnRows(s.id)).toHaveLength(2);
    expect(await deadlockCount(owner)).toBe(deadlocks);
  });

  it("an audit stored while a call is being begun waits for it, then both finish", async () => {
    const s = await open();
    const deadlocks = await deadlockCount(owner);
    const r = await raceForSession(
      (hooks) => beginCall(lockA, { sessionId: s.id, venueId: A.venue, tool: "hold", input: {} }, hooks),
      () => storeAudit(lockB, { sessionId: s.id, venueId: A.venue, turns: turns(2), result: { n: 1 }, auditedAt: new Date().toISOString() }),
    );
    expect(value(r.first)).toEqual({ ok: true, callId: expect.any(Number) });
    expect(r.second.ok).toBe(true);
    expect(await callCount(s.id)).toBe(1);
    expect(await callRows(s.id)).toBe(1);
    expect((await sessionRow(s.id)).audit).toEqual({ n: 1 });
    expect(await turnRows(s.id)).toHaveLength(2);
    expect(await deadlockCount(owner)).toBe(deadlocks);
  });

  it("a call completes while an audit holds the session", async () => {
    const s = await open();
    const id = await begun(s);
    const p = pause();
    const audit = outcome(storeAudit(lockA, { sessionId: s.id, venueId: A.venue, turns: turns(1), result: { n: 1 }, auditedAt: new Date().toISOString() }, { beforeCommit: p.hook }));
    try {
      await p.reached;
      const blocked = Symbol("blocked");
      let timer: NodeJS.Timeout | undefined;
      const done = await Promise.race([
        outcome(completeCall(lockB, { sessionId: s.id, venueId: A.venue, callId: id, status: 200, output: { a: 1 }, receipt: null })),
        new Promise<typeof blocked>((res) => { timer = setTimeout(() => res(blocked), 5_000); }),
      ]);
      clearTimeout(timer);
      // the audit has not committed: it still holds the session's row
      expect(done).toEqual({ ok: true, value: undefined });
      expect((await callRow(id)).completed_at).toBeInstanceOf(Date);
      expect((await sessionRow(s.id)).audit).toBeNull();
    } finally {
      p.release();
    }
    expect((await audit).ok).toBe(true);
    expect((await sessionRow(s.id)).audit).toEqual({ n: 1 });
  });

  it("two calls begun at once both record", async () => {
    const s = await open();
    const r = await raceForSession(
      (hooks) => beginCall(lockA, { sessionId: s.id, venueId: A.venue, tool: "hold", input: { which: "a" } }, hooks),
      () => beginCall(lockB, { sessionId: s.id, venueId: A.venue, tool: "hold", input: { which: "b" } }),
    );
    const a = value(r.first); const b = value(r.second);
    expect(a).toEqual({ ok: true, callId: expect.any(Number) });
    expect(b).toEqual({ ok: true, callId: expect.any(Number) });
    expect((a as { callId: number }).callId).not.toBe((b as { callId: number }).callId);
    expect(await callCount(s.id)).toBe(2);
    expect(await callRows(s.id)).toBe(2);
  });

  it("at the cap, of two calls begun at once one records and one is full", async () => {
    const s = await open();
    await owner.query("update dastar_agent.session set call_count = $2 where id = $1", [s.id, MAX_SESSION_CALLS - 1]);
    const r = await raceForSession(
      (hooks) => beginCall(lockA, { sessionId: s.id, venueId: A.venue, tool: "hold", input: {} }, hooks),
      () => beginCall(lockB, { sessionId: s.id, venueId: A.venue, tool: "hold", input: {} }),
    );
    expect(value(r.first)).toEqual({ ok: true, callId: expect.any(Number) });
    expect(value(r.second)).toEqual({ ok: false, reason: "full" });
    expect(await callCount(s.id)).toBe(MAX_SESSION_CALLS);
    expect(await callRows(s.id)).toBe(1);
  });
});

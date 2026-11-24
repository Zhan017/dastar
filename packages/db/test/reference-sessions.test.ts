import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool, type Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { seedVenue, seedKey, type Seed } from "./helpers/seed.js";
import { connectAs, waitForBackend, pause, outcome, deadlockCount, type Outcome } from "./helpers/wait.js";
import { createDastar, type Dastar } from "../src/handle.js";
import { claimTurn, type ClaimTurnInput, type ClaimTurnOutcome, type TurnRecord } from "../src/commands/reference.js";
import type { SessionHooks, SessionView } from "../src/commands/sessions.js";

describe("reference sessions", () => {
  let conn: Conn; let owner: Client; let lockA: Client; let lockB: Client;
  let pool: Pool; let d: Dastar;
  let A: Seed; let B: Seed;
  let key: string; let other: string;
  const ABSENT = "00000000-0000-7000-8000-000000000000";
  const R1 = "00000000-0000-7000-8000-0000000000a1";
  const R2 = "00000000-0000-7000-8000-0000000000a2";
  const LOCK_B = "ref-lock-B";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const RECORD: TurnRecord = {
    model: "claude-opus-5-5", promptHash: "9f2c41d7a0b3", providerCalls: 3, regenerations: 1, fellBack: false,
    inputTokens: 1200, outputTokens: 340, cacheReadTokens: 900, cacheWriteTokens: 50, latencyMs: 4210,
  };
  const CLAIMS = [{ reservation_id: ABSENT, status: "held", party_size: 2 }];

  beforeAll(async () => {
    conn = await cloneDatabase("reference_sessions_test");
    owner = await connect(conn.owner);
    lockA = await connectAs(conn.app, "ref-lock-A");
    lockB = await connectAs(conn.app, LOCK_B);
    pool = new Pool({ connectionString: conn.app, max: 4, application_name: "ref-pool" });
    pool.on("error", () => undefined);
    d = createDastar({ pool });
    A = await seedVenue(owner);
    B = await seedVenue(owner);
    key = await seedKey(owner);
    other = await seedKey(owner);
  });
  afterAll(async () => {
    await d.close();
    await pool.end();
    await lockB.end(); await lockA.end(); await owner.end();
    await dropDatabase("reference_sessions_test");
  });

  const open = (seed: Seed = A, apiKeyId: string = key): Promise<SessionView> => d.sessions.openReferenceSession({ venueId: seed.venue, apiKeyId });
  const claimInput = (sessionId: string, over: Partial<ClaimTurnInput> = {}): ClaimTurnInput =>
    ({ sessionId, venueId: A.venue, apiKeyId: key, content: "hi", maxUserTurns: 3, staleAfterMs: 240_000, ...over });
  const claim = (sessionId: string, over: Partial<ClaimTurnInput> = {}): Promise<ClaimTurnOutcome> => d.sessions.claimTurn(claimInput(sessionId, over));
  const reply = (sessionId: string, seq: number, over: Record<string, unknown> = {}): Promise<boolean> =>
    d.sessions.storeReply({
      sessionId, venueId: A.venue, seq, content: "it is held", claims: CLAIMS, guardrailFired: false, at: "2064-03-01T18:00:05.000Z", record: RECORD, ...over,
    });
  /** The session's turn rows as the owner reads them, in seq order. */
  const turnRows = async (id: string) =>
    (await owner.query(
      `select seq, role, content, claims, guardrail_fired, at, model, prompt_hash, provider_calls, regenerations, fell_back,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, latency_ms
         from dastar_agent.turn where session_id = $1 order by seq`,
      [id],
    )).rows;
  const holdRows = async (id: string) =>
    (await owner.query("select reservation_id, confirm_token_enc from dastar_agent.session_hold where session_id = $1 order by reservation_id", [id])).rows;
  /** A claim that succeeded; any other outcome fails the test. */
  async function claimed(sessionId: string, over: Partial<ClaimTurnInput> = {}): Promise<{ seq: number; at: string }> {
    const out = await claim(sessionId, over);
    if (out.kind !== "claimed") throw new Error(`claimTurn answered ${out.kind}`);
    return { seq: out.seq, at: out.at };
  }

  /**
   * Two claims race for one session's row lock. `first` runs on connection A and stops right before its commit, holding
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

  it("opens a reference session for the key", async () => {
    const v = await open();
    expect(v).toMatchObject({ id: expect.stringMatching(UUID), kind: "reference", venueId: A.venue, calls: 0, auditedAt: null });
    expect(new Date(v.startedAt).toISOString()).toBe(v.startedAt);
    const row = (await owner.query("select api_key_id, kind::text as kind, call_count, audit from dastar_agent.session where id = $1", [v.id])).rows[0];
    expect(row).toEqual({ api_key_id: key, kind: "reference", call_count: 0, audit: null });
  });

  it("claims the first turn at seq 0 at the database's time, then refuses another while it is unanswered", async () => {
    const s = await open();
    const out = await claim(s.id);
    expect(out).toEqual({ kind: "claimed", seq: 0, at: expect.any(String) });
    const at = (out as { at: string }).at;
    const now = (await owner.query("select now() as now")).rows[0].now as Date;
    expect(new Date(at).toISOString()).toBe(at);
    expect(Math.abs(now.getTime() - new Date(at).getTime())).toBeLessThan(60_000);
    const rows = await turnRows(s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seq: 0, role: "user", content: "hi", claims: null, model: null, provider_calls: null });
    expect((rows[0].at as Date).toISOString()).toBe(at);

    expect(await claim(s.id, { content: "again" })).toEqual({ kind: "busy" });
    expect(await turnRows(s.id)).toHaveLength(1);
  });

  it("after the reply is stored the next claim takes the following seq", async () => {
    const s = await open();
    await claimed(s.id);
    expect(await reply(s.id, 1)).toBe(true);
    expect(await claim(s.id, { content: "and then?" })).toEqual({ kind: "claimed", seq: 2, at: expect.any(String) });
    expect((await turnRows(s.id)).map((r) => [r.seq, r.role])).toEqual([[0, "user"], [1, "assistant"], [2, "user"]]);
  });

  it("a session that is not this key's live reference session in this venue is missing", async () => {
    const external = (await owner.query(
      "insert into dastar_agent.session (venue_id, api_key_id, kind) values ($1, $2, 'external') returning id", [A.venue, key],
    )).rows[0].id as string;
    const others = await open(A, other);
    const inA = await open(A, key);
    const cases: [string, Promise<ClaimTurnOutcome>][] = [
      ["a random id", claim(ABSENT)],
      ["an external session of the key", claim(external)],
      ["a reference session of another key", claim(others.id)],
      ["the key's session in another venue", claim(inA.id, { venueId: B.venue })],
    ];
    for (const [, out] of cases) expect(await out).toEqual({ kind: "missing" });
    for (const id of [ABSENT, external, others.id, inA.id]) expect(await turnRows(id)).toEqual([]);
  });

  it("a trailing user turn older than staleAfterMs is stale, younger is busy, and nothing is inserted", async () => {
    const s = await open();
    await claimed(s.id);
    const age = async (seconds: number): Promise<string> =>
      ((await owner.query("update dastar_agent.turn set at = now() - make_interval(secs => $2::int) where session_id = $1 and seq = 0 returning at", [s.id, seconds]))
        .rows[0].at as Date).toISOString();

    const old = await age(241);
    expect(await claim(s.id)).toEqual({ kind: "stale", seq: 0, at: old });
    expect(await turnRows(s.id)).toHaveLength(1);

    await age(235);
    expect(await claim(s.id)).toEqual({ kind: "busy" });
    expect(await turnRows(s.id)).toHaveLength(1);
  });

  it("maxUserTurns user turns make the session full", async () => {
    const s = await open();
    for (let i = 0; i < 2; i++) {
      const c = await claimed(s.id, { maxUserTurns: 2 });
      expect(await reply(s.id, c.seq + 1)).toBe(true);
    }
    expect(await claim(s.id, { maxUserTurns: 2 })).toEqual({ kind: "full" });
    expect(await turnRows(s.id)).toHaveLength(4);

    // an unanswered user turn is busy, even at the limit
    const t = await open();
    await claimed(t.id, { maxUserTurns: 1 });
    expect(await claim(t.id, { maxUserTurns: 1 })).toEqual({ kind: "busy" });
    expect(await turnRows(t.id)).toHaveLength(1);
  });

  it("two claims at once: one claims and the other is busy", async () => {
    const s = await open();
    const deadlocks = await deadlockCount(owner);
    const r = await raceForSession(
      (hooks) => claimTurn(lockA, claimInput(s.id, { content: "first" }), hooks),
      () => claimTurn(lockB, claimInput(s.id, { content: "second" })),
    );
    expect(value(r.first)).toEqual({ kind: "claimed", seq: 0, at: expect.any(String) });
    expect(value(r.second)).toEqual({ kind: "busy" });
    const rows = await turnRows(s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seq: 0, role: "user", content: "first" });
    expect(await deadlockCount(owner)).toBe(deadlocks);
  });

  it("storeReply stores the assistant turn with its record once", async () => {
    const s = await open();
    await claimed(s.id);
    expect(await reply(s.id, 1)).toBe(true);
    const rows = await turnRows(s.id);
    expect(rows).toHaveLength(2);
    const stored = rows[1];
    expect(stored).toMatchObject({
      seq: 1, role: "assistant", content: "it is held", claims: CLAIMS, guardrail_fired: false,
      model: RECORD.model, prompt_hash: RECORD.promptHash, provider_calls: RECORD.providerCalls, regenerations: RECORD.regenerations,
      fell_back: RECORD.fellBack, input_tokens: RECORD.inputTokens, output_tokens: RECORD.outputTokens,
      cache_read_tokens: RECORD.cacheReadTokens, cache_write_tokens: RECORD.cacheWriteTokens, latency_ms: RECORD.latencyMs,
    });
    expect((stored.at as Date).toISOString()).toBe("2064-03-01T18:00:05.000Z");

    expect(await reply(s.id, 1, { content: "another answer", guardrailFired: true })).toBe(false);
    expect((await turnRows(s.id))[1]).toEqual(stored);

    // no time given: the database's
    const t = await open();
    await claimed(t.id);
    expect(await reply(t.id, 1, { at: null, guardrailFired: true })).toBe(true);
    const row = (await turnRows(t.id))[1];
    expect(row.guardrail_fired).toBe(true);
    const now = (await owner.query("select now() as now")).rows[0].now as Date;
    expect(Math.abs(now.getTime() - (row.at as Date).getTime())).toBeLessThan(60_000);
  });

  it("storeReply refuses a seq whose previous turn is not a user turn", async () => {
    const s = await open();
    await claimed(s.id);
    expect(await reply(s.id, 1)).toBe(true);
    expect(await reply(s.id, 2)).toBe(false);
    expect((await turnRows(s.id)).map((r) => r.seq)).toEqual([0, 1]);
    // nor one with no turn before it, nor one in a session of another venue
    expect(await reply(s.id, 5)).toBe(false);
    const t = await open();
    await claimed(t.id);
    expect(await d.sessions.storeReply({ sessionId: t.id, venueId: B.venue, seq: 1, content: "x", claims: [], guardrailFired: false, at: null, record: RECORD })).toBe(false);
    expect(await turnRows(t.id)).toHaveLength(1);
  });

  it("readTurns returns the session's turns in seq order", async () => {
    const s = await open();
    const c = await claimed(s.id);
    expect(await reply(s.id, 1)).toBe(true);
    expect(await d.sessions.readTurns({ sessionId: s.id, venueId: A.venue })).toEqual([
      { seq: 0, role: "user", content: "hi", claims: null, at: c.at },
      { seq: 1, role: "assistant", content: "it is held", claims: CLAIMS, at: "2064-03-01T18:00:05.000Z" },
    ]);
    expect(await d.sessions.readTurns({ sessionId: s.id, venueId: B.venue })).toEqual([]);
  });

  it("putSessionHold inserts and then replaces a token; listSessionHolds reads the session's rows only", async () => {
    const s = await open();
    const t = await open();
    const ref = { sessionId: s.id, venueId: A.venue };
    await d.sessions.putSessionHold({ ...ref, reservationId: R1, tokenEnc: Buffer.from([1, 2, 3]) });
    await d.sessions.putSessionHold({ ...ref, reservationId: R1, tokenEnc: Buffer.from([4]) });
    const rows = await holdRows(s.id);
    expect(rows).toHaveLength(1);
    expect((rows[0].confirm_token_enc as Buffer).equals(Buffer.from([4]))).toBe(true);

    await d.sessions.putSessionHold({ ...ref, reservationId: R2, tokenEnc: Buffer.from([5, 6]) });
    await d.sessions.putSessionHold({ sessionId: t.id, venueId: A.venue, reservationId: R1, tokenEnc: Buffer.from([9]) });

    const listed = (await d.sessions.listSessionHolds(ref)).sort((a, b) => a.reservationId.localeCompare(b.reservationId));
    expect(listed.map((h) => h.reservationId)).toEqual([R1, R2]);
    expect(listed[0]!.tokenEnc.equals(Buffer.from([4]))).toBe(true);
    expect(listed[1]!.tokenEnc.equals(Buffer.from([5, 6]))).toBe(true);
    expect(Buffer.isBuffer(listed[0]!.tokenEnc)).toBe(true);
    expect(await d.sessions.listSessionHolds({ sessionId: s.id, venueId: B.venue })).toEqual([]);
    expect(await holdRows(t.id)).toHaveLength(1);
  });

  it("venueProfile reads the venue's name and time zone", async () => {
    expect(await d.venueProfile(A.venue)).toEqual({ id: A.venue, name: "Test", timezone: "Europe/Berlin" });
    expect(await d.venueProfile(ABSENT)).toBeNull();
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool, type Client } from "pg";
import { createDastar, type Dastar, type DueTurn, type FailedResult, type JudgedResult, type Rates } from "@dastar/db";
import { cloneDatabase, dropDatabase, connect, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedKey, seedVenue, type Seed } from "../../../packages/db/test/helpers/seed.js";
import type { AccuracyEntry } from "../src/judge/accuracy.js";
import { loadJudgePrompt, renderJudgeMessage, JUDGE_REPLY_SCHEMA } from "../src/judge/prompt.js";
import {
  CALL_TIMEOUT_MS, MAX_TEXT_CHARS, PAUSE_MAX_MS, REJECTION_LIMIT, TRANSIENT_LIMIT, classifyProviderError, describeProviderError, judgeOne, newPace, pauseAfter, tooLong,
  type JudgeDeps,
} from "../src/judge/turn.js";
import type { Completion, LLMProvider } from "../src/provider.js";
import { replyWith, scripted, toolCall, USAGE, type Step } from "./fake-provider.js";

type Seeded = { session: string; turnId: number; due: DueTurn };

const withStatus = (status: number): Error => Object.assign(new Error("x"), { status });
/** An error as the SDK's APIError carries it: the status, and the API's parsed body on `error`. */
const withBody = (status: number, body: unknown): Error => Object.assign(new Error("x"), { status, error: body });
/** The body the API sends for an error: its type and message, and the details when there are any. */
const apiBody = (type: string, details?: unknown): unknown => ({ type: "error", error: { type, message: "m", ...(details === undefined ? {} : { details }) } });
const SPEND = { error_code: "enforced_spend_limit_reached" };
/** A step whose call fails: with an error carrying the status, or with none. */
const failing = (status?: number): Step => () => {
  throw status === undefined ? new Error("connection reset") : withStatus(status);
};

describe("classifyProviderError", () => {
  it("sorts a status into the account or key being refused, a failure that may pass, and a request that is refused", () => {
    for (const status of [401, 402, 403, 404]) expect(classifyProviderError(withStatus(status)), String(status)).toBe("config");
    for (const status of [408, 409, 429, 500, 502, 503, 529, 599]) expect(classifyProviderError(withStatus(status)), String(status)).toBe("transient");
    for (const status of [400, 413, 422, 418]) expect(classifyProviderError(withStatus(status)), String(status)).toBe("rejected");
  });

  it("takes a 429 that is the account's spend cap as the account refused, wherever the body keeps its details, and any other 429 as one that may pass", () => {
    // the SDK keeps the parsed body on `.error`; the code is read at error.error.details and at error.error.error.details
    expect(classifyProviderError(withBody(429, apiBody("rate_limit_error", SPEND)))).toBe("config");
    expect(classifyProviderError(withBody(429, { details: SPEND }))).toBe("config");
    expect(classifyProviderError(withBody(429, { type: "error", error: { type: "rate_limit_error", details: SPEND } }))).toBe("config");
    expect(classifyProviderError(withBody(429, apiBody("rate_limit_error")))).toBe("transient");
    expect(classifyProviderError(withBody(429, apiBody("rate_limit_error", { error_code: "something_else" })))).toBe("transient");
    expect(classifyProviderError(withBody(429, apiBody("rate_limit_error", "enforced_spend_limit_reached")))).toBe("transient");
    expect(classifyProviderError(withBody(429, "enforced_spend_limit_reached"))).toBe("transient");
    expect(classifyProviderError(withBody(429, null))).toBe("transient");
    expect(classifyProviderError(withStatus(429))).toBe("transient");
    // the code belongs to a 429: on another status it changes nothing
    expect(classifyProviderError(withBody(500, apiBody("api_error", SPEND)))).toBe("transient");
    expect(classifyProviderError(withBody(400, apiBody("invalid_request_error", SPEND)))).toBe("rejected");
  });

  it("describes a failure by its status and the API's error type, and by nothing else of the answer", () => {
    expect(describeProviderError(withStatus(401))).toBe("HTTP 401");
    expect(describeProviderError(withBody(402, apiBody("billing_error")))).toBe("HTTP 402, billing_error");
    expect(describeProviderError(withBody(404, apiBody("not_found_error")))).toBe("HTTP 404, not_found_error");
    expect(describeProviderError(withBody(429, apiBody("rate_limit_error", SPEND)))).toBe("HTTP 429, rate_limit_error, enforced_spend_limit_reached");
    // a type that is not a plain identifier is left out, so no text of the answer's own gets into a line
    expect(describeProviderError(withBody(402, { type: "error", error: { type: "Bill me at sk-ant-1234" } }))).toBe("HTTP 402");
    expect(describeProviderError(withBody(402, { type: "error", error: { message: "sk-ant-1234 over the limit" } }))).toBe("HTTP 402");
    expect(describeProviderError(new Error("sk-ant-1234"))).toBe("no HTTP status");
  });

  it("paces failures that may pass: 30 s, doubling, at most 10 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50, 5_000].map(pauseAfter)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, PAUSE_MAX_MS, PAUSE_MAX_MS, PAUSE_MAX_MS, PAUSE_MAX_MS]);
    expect(PAUSE_MAX_MS).toBe(600_000);
  });

  it("counts a text's characters as whole code points", () => {
    expect(tooLong("x".repeat(MAX_TEXT_CHARS))).toBe(false);
    expect(tooLong("x".repeat(MAX_TEXT_CHARS + 1))).toBe(true);
    expect(tooLong("\u{1F37D}".repeat(5_000))).toBe(false);
  });

  it("takes an error with no numeric status as one that may pass", () => {
    for (const error of [new Error("x"), "a string", null, undefined, {}, { status: "401" }, { status: undefined }, Object.assign(new Error("x"), { status: null })]) {
      expect(classifyProviderError(error), String(error)).toBe("transient");
    }
  });
});

describe("judging one turn", () => {
  let conn: Conn; let owner: Client; let pool: Pool; let j: Dastar;
  let A: Seed; let key: string;
  let slot = 0;
  const prompt = loadJudgePrompt();
  const DAY = 86_400_000;
  const TEXT = "Your table for 2 is confirmed.";
  const USER_TEXT = "Can you book a table for two?";

  beforeAll(async () => {
    conn = await cloneDatabase("agent_judge_turn_test");
    owner = await connect(conn.owner);
    await owner.query("select set_config('dastar.actor', 'judge-turn-test', false)");
    pool = new Pool({ connectionString: conn.judge, max: 4, application_name: "judge-turn" });
    pool.on("error", () => undefined);
    j = createDastar({ pool });
    A = await seedVenue(owner);
    key = await seedKey(owner);
  });
  afterAll(async () => {
    await j.close();
    await pool.end();
    await owner.end();
    await dropDatabase("agent_judge_turn_test");
  });

  /** The deps of a judgment: the judge's own handle, a model that is not the one that answers, and no accuracy entries. */
  const deps = (provider: LLMProvider, over: Partial<JudgeDeps> = {}): JudgeDeps => ({
    dastar: j, provider, prompt, model: "configured-model", effort: "medium", accuracy: [], dailyCalls: 500, transient: new Map(), pace: newPace(), ...over,
  });

  /** A reservation of the venue held for a day, written by the owner (a reservation is written held with its unit row); returns its id. */
  async function addHeldReservation(): Promise<string> {
    slot += 1;
    const start = new Date(Date.UTC(2064, 0, slot, 18));
    const during = `[${start.toISOString()},${new Date(start.getTime() + 3_600_000).toISOString()})`;
    await owner.query("begin");
    try {
      const id = (await owner.query(
        `insert into dastar.reservation(venue_id, party_size, during, status, assignment_kind, assignment_id, hold_expires_at, created_by)
         values ($1, 2, $2::tstzrange, 'held', 'unit', $3, $4::timestamptz, 'judge-turn-test') returning id`,
        [A.venue, during, A.units[0], new Date(Date.now() + DAY).toISOString()],
      )).rows[0].id as string;
      await owner.query(
        "insert into dastar.reservation_unit(venue_id, reservation_id, unit_id, during) values ($1, $2, $3, $4::tstzrange)",
        [A.venue, id, A.units[0], during],
      );
      await owner.query("commit");
      return id;
    } catch (e) {
      await owner.query("rollback");
      throw e;
    }
  }

  async function addTurn(session: string, seq: number, role: "user" | "assistant", content: string, over: { claims?: unknown[]; at?: string } = {}): Promise<number> {
    const r = await owner.query(
      `insert into dastar_agent.turn(session_id, venue_id, seq, role, content, claims, at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz) returning id::text as id`,
      [session, A.venue, seq, role, content, over.claims === undefined ? null : JSON.stringify(over.claims), over.at ?? null],
    );
    return Number(r.rows[0].id);
  }

  /**
   * A reference session with a user turn and, after it, an assistant turn of the text, all with times; when `hold` is
   * given, the session's one call is a hold of that reservation that completed before the assistant turn.
   */
  async function seedTurn(text: string, opts: { claims?: unknown[]; hold?: string } = {}): Promise<Seeded> {
    const now = Date.now();
    const ago = (seconds: number): string => new Date(now - seconds * 1000).toISOString();
    const session = (await owner.query(
      "insert into dastar_agent.session(venue_id, api_key_id, kind, last_seen_at) values ($1, $2, 'reference', dastar.dastar_now()) returning id",
      [A.venue, key],
    )).rows[0].id as string;
    await addTurn(session, 0, "user", USER_TEXT, { at: ago(180) });
    if (opts.hold !== undefined) {
      await owner.query(
        `insert into dastar_agent.tool_call(session_id, venue_id, tool, input, status, output, receipt, started_at, completed_at)
         values ($1, $2, 'hold', $3::jsonb, 201, $4::jsonb, $5::jsonb, $6::timestamptz, $7::timestamptz)`,
        [
          session, A.venue, JSON.stringify({ party_size: 2 }), JSON.stringify({ hold_expires_at: new Date(now + DAY).toISOString() }),
          JSON.stringify({ reservation_id: opts.hold, status: "held", version: 1, audit_id: 1, trace_id: "trace-1" }), ago(125), ago(120),
        ],
      );
    }
    const turnId = await addTurn(session, 1, "assistant", text, { at: ago(60), ...(opts.claims !== undefined ? { claims: opts.claims } : {}) });
    return { session, turnId, due: { turnId, sessionId: session, venueId: A.venue, seq: 1 } };
  }

  const stored = async (turnId: number): Promise<unknown> =>
    (await owner.query("select judge_result from dastar_agent.turn where id = $1", [turnId])).rows[0].judge_result;
  const dayCalls = async (): Promise<number> => {
    const r = await owner.query("select calls from dastar_agent.judge_day where day = (dastar.dastar_now() at time zone 'UTC')::date");
    return r.rowCount === 0 ? 0 : (r.rows[0].calls as number);
  };
  /** A time the database wrote just now. */
  const justNow = (iso: string): boolean => new Date(iso).toISOString() === iso && Math.abs(Date.parse(iso) - Date.now()) < 120_000;

  const statement = (quote: string, id: string | null, status: string) => ({ quote, reservation_id: id, status, starts_at: null, party_size: null });
  const statementsReply = (...statements: unknown[]): Completion => replyWith(JSON.stringify({ statements }));

  it("judges a reference turn", async () => {
    const r1 = await addHeldReservation();
    const { turnId, due } = await seedTurn(TEXT, { hold: r1 });
    const provider = scripted(statementsReply(statement(TEXT, r1, "confirmed")));
    const before = await dayCalls();

    expect(await judgeOne(deps(provider), due)).toEqual({ kind: "judged", usage: USAGE });

    const result = (await stored(turnId)) as JudgedResult;
    expect(result).toMatchObject({
      outcome: "judged", model: "fake-model", effort: "medium", prompt_hash: prompt.hash, mode: "timed", dropped: 0, accuracy: null,
      usage: { input: 100, output: 20, cache_read: 10, cache_write: 5 },
    });
    expect(justNow(result.judged_at)).toBe(true);
    expect(result.statements).toEqual([{ quote: TEXT, claim: { reservation_id: r1, status: "confirmed" }, declared: false }]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      quote: TEXT, claim: { reservation_id: r1, status: "confirmed" }, verdict: "unbacked", reason: "status_mismatch", current_status: "held", current_differs: false,
    });
    expect(await dayCalls()).toBe(before + 1);

    // the call: no tools, the system prompt, one message of the template filled from the turn, and the reply's schema
    expect(provider.requests).toHaveLength(1);
    const request = provider.requests[0]!;
    expect(request.tools).toEqual([]);
    expect(request.system).toBe(prompt.system);
    expect(request.replySchema).toEqual(JUDGE_REPLY_SCHEMA);
    expect(request.messages).toEqual([{
      role: "user",
      text: renderJudgeMessage(prompt.template, { reservations: [{ id: r1, starts_at: null, party_size: 2 }], user_text: USER_TEXT, assistant_text: TEXT, claims: [] }),
    }]);
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it("a declared statement is listed and not judged", async () => {
    const r1 = await addHeldReservation();
    const text = "Your table for 2 is confirmed. Your table is held until 19:00.";
    const { turnId, due } = await seedTurn(text, { hold: r1, claims: [{ reservation_id: r1, status: "confirmed" }] });
    const provider = scripted(statementsReply(
      statement("Your table for 2 is confirmed.", r1, "confirmed"),
      statement("Your table is held until 19:00.", r1, "held"),
    ));

    expect(await judgeOne(deps(provider), due)).toEqual({ kind: "judged", usage: USAGE });

    const result = (await stored(turnId)) as JudgedResult;
    expect(result.statements.map((s) => [s.claim.status, s.declared])).toEqual([["confirmed", true], ["held", false]]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ quote: "Your table is held until 19:00.", verdict: "backed", current_status: "held" });
  });

  it("stamps the matching accuracy entry", async () => {
    const rate = { value: 0.9, low: 0.8, high: 0.95, k: 9, n: 10 };
    const rates: Rates = { precision: rate, recall: rate };
    const entry = (over: Partial<AccuracyEntry>): AccuracyEntry => ({
      run: "run-a", labeled_set: "set-a", undeclared: rates, all: rates, model: "fake-model", effort: "medium", prompt_hash: prompt.hash, measured_at: "2064-02-01T10:00:00Z", items: 20, ...over,
    });
    // the entry of the configured model is not the one for the model that answered
    const entries = [
      entry({ model: "configured-model", run: "run-configured" }),
      entry({ effort: "high", run: "run-high" }),
      entry({ prompt_hash: "00000000", run: "run-old-prompt" }),
      entry({ run: "run-match" }),
    ];

    const r1 = await addHeldReservation();
    const { turnId, due } = await seedTurn(TEXT, { hold: r1 });
    await judgeOne(deps(scripted(statementsReply(statement(TEXT, r1, "confirmed"))), { accuracy: entries }), due);
    expect(((await stored(turnId)) as JudgedResult).accuracy).toEqual({ run: "run-match", labeled_set: "set-a", undeclared: rates, all: rates });

    // an empty turn is judged by the configured model, and stamped as that model
    const blank = await seedTurn("  ");
    await judgeOne(deps(scripted(), { accuracy: entries }), blank.due);
    expect(((await stored(blank.turnId)) as JudgedResult).accuracy?.run).toBe("run-configured");
  });

  it("a text over 8,000 characters is failed too_long with no call; exactly 8,000 is sent", async () => {
    expect(MAX_TEXT_CHARS).toBe(8_000);
    const before = await dayCalls();

    const long = await seedTurn("x".repeat(MAX_TEXT_CHARS + 1));
    const none = scripted();
    expect(await judgeOne(deps(none), long.due)).toEqual({ kind: "failed", usage: null });
    expect(await stored(long.turnId)).toEqual({ outcome: "failed", judged_at: expect.any(String), prompt_hash: prompt.hash, reason: "too_long" });
    expect(justNow(((await stored(long.turnId)) as FailedResult).judged_at)).toBe(true);
    expect(none.requests).toHaveLength(0);
    expect(await dayCalls()).toBe(before);

    const exact = await seedTurn("y".repeat(MAX_TEXT_CHARS));
    const sent = scripted(statementsReply());
    expect(await judgeOne(deps(sent), exact.due)).toEqual({ kind: "judged", usage: USAGE });
    expect(sent.requests).toHaveLength(1);
    expect(((await stored(exact.turnId)) as JudgedResult).outcome).toBe("judged");

    // a character is a whole code point: 5,000 of two UTF-16 units each are within the limit
    const wide = await seedTurn("\u{1F37D}".repeat(5_000));
    const wideProvider = scripted(statementsReply());
    expect(await judgeOne(deps(wideProvider), wide.due)).toEqual({ kind: "judged", usage: USAGE });
    expect(wideProvider.requests).toHaveLength(1);
    expect(await dayCalls()).toBe(before + 2);
  });

  it("an empty or blank text is judged with no statements and no call", async () => {
    for (const text of ["", "   \n\t "]) {
      const before = await dayCalls();
      const { turnId, due } = await seedTurn(text);
      const provider = scripted();
      expect(await judgeOne(deps(provider), due), JSON.stringify(text)).toEqual({ kind: "judged", usage: null });
      const result = (await stored(turnId)) as JudgedResult;
      expect(result).toMatchObject({
        outcome: "judged", model: "configured-model", effort: "medium", prompt_hash: prompt.hash, statements: [], dropped: 0, results: [], accuracy: null,
        usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      });
      expect(justNow(result.judged_at)).toBe(true);
      expect(provider.requests).toHaveLength(0);
      expect(await dayCalls()).toBe(before);
    }
  });

  it("a refusal, a truncation and an unparsable reply are stored as failed with that reason and the answering model", async () => {
    const cases: [string, Completion][] = [
      ["refused", { kind: "refused", usage: { ...USAGE }, model: "fake-model" }],
      ["truncated", { kind: "truncated", usage: { ...USAGE }, model: "fake-model" }],
      ["unparsable", replyWith("not json")],
      ["unparsable", replyWith(JSON.stringify({ statements: [{ quote: "x" }] }))],
      ["unparsable", toolCall("hold", {})],
    ];
    for (const [reason, completion] of cases) {
      const { turnId, due } = await seedTurn(TEXT);
      expect(await judgeOne(deps(scripted(completion)), due), reason).toEqual({ kind: "failed", usage: USAGE });
      expect(await stored(turnId), reason).toEqual({ outcome: "failed", judged_at: expect.any(String), model: "fake-model", prompt_hash: prompt.hash, reason });
    }
  });

  it("401, 402, 403 and 404 are fatal and leave the row null", async () => {
    for (const status of [401, 402, 403, 404]) {
      const { turnId, due } = await seedTurn(TEXT);
      const before = await dayCalls();
      const transient = new Map<number, number>();
      const d = deps(scripted(failing(status)), { transient });
      expect(await judgeOne(d, due)).toEqual({ kind: "fatal", line: `the model provider refused the judge's requests (HTTP ${status})` });
      expect(await stored(turnId)).toBeNull();
      expect(transient.size).toBe(0);
      expect(d.pace).toEqual({ failures: 0, rejections: 0, pauseMs: 0 });
      expect(await dayCalls()).toBe(before + 1);
    }
  });

  it("a fatal line names the status and the API's error type, and carries nothing else of the answer", async () => {
    const cases: [Error, string][] = [
      [withBody(402, apiBody("billing_error")), "HTTP 402, billing_error"],
      [withBody(404, apiBody("not_found_error")), "HTTP 404, not_found_error"],
      [withBody(429, apiBody("rate_limit_error", SPEND)), "HTTP 429, rate_limit_error, enforced_spend_limit_reached"],
    ];
    for (const [error, said] of cases) {
      const { turnId, due } = await seedTurn(TEXT);
      const verdict = await judgeOne(deps(scripted(() => { throw Object.assign(error, { message: `sk-ant-secret ${TEXT}` }); })), due);
      expect(verdict, said).toEqual({ kind: "fatal", line: `the model provider refused the judge's requests (${said})` });
      expect(JSON.stringify(verdict)).not.toContain("sk-ant-secret");
      expect(JSON.stringify(verdict)).not.toContain(TEXT);
      expect(await stored(turnId)).toBeNull();
    }
  });

  it("a 429 that is the spend cap is fatal, and any other 429 leaves the row null for a later call", async () => {
    const capped = await seedTurn(TEXT);
    const spend = deps(scripted(() => { throw withBody(429, apiBody("rate_limit_error", SPEND)); }));
    expect(await judgeOne(spend, capped.due)).toMatchObject({ kind: "fatal" });
    expect(await stored(capped.turnId)).toBeNull();
    expect(spend.pace).toEqual({ failures: 0, rejections: 0, pauseMs: 0 });

    const busy = await seedTurn(TEXT);
    const plain = deps(scripted(() => { throw withBody(429, apiBody("rate_limit_error")); }));
    expect(await judgeOne(plain, busy.due)).toEqual({ kind: "retry" });
    expect(await stored(busy.turnId)).toBeNull();
  });

  it("a failure that may pass sets the pause the process owes, doubling with each in a row, and an answered call clears it", async () => {
    const d = deps(scripted(failing(503), failing(), failing(429), statementsReply(), failing(500)));
    const turns = await Promise.all([seedTurn(TEXT), seedTurn(TEXT), seedTurn(TEXT), seedTurn(TEXT), seedTurn(TEXT)]);
    const paces: unknown[] = [];
    for (const t of turns) {
      await judgeOne(d, t.due);
      paces.push({ ...d.pace });
    }
    expect(paces).toEqual([
      { failures: 1, rejections: 0, pauseMs: 30_000 },
      { failures: 2, rejections: 0, pauseMs: 60_000 },
      { failures: 3, rejections: 0, pauseMs: 120_000 },
      { failures: 0, rejections: 0, pauseMs: 0 },
      { failures: 1, rejections: 0, pauseMs: 30_000 },
    ]);
  });

  it("three turns in a row stored as rejected end the process, and a call answered between them does not count them together", async () => {
    expect(REJECTION_LIMIT).toBe(3);
    const rejected = { outcome: "failed", judged_at: expect.any(String), prompt_hash: prompt.hash, reason: "provider_rejected" };
    const bad = withBody(400, apiBody("invalid_request_error"));
    const reject = (): never => { throw bad; };

    // three in a row: each is stored, and the third carries the line that ends the process
    const a = await seedTurn(TEXT); const b = await seedTurn(TEXT); const c = await seedTurn(TEXT); const after = await seedTurn(TEXT);
    const run = deps(scripted(reject, reject, reject, statementsReply()));
    expect(await judgeOne(run, a.due)).toEqual({ kind: "failed", usage: null });
    expect(await judgeOne(run, b.due)).toEqual({ kind: "failed", usage: null });
    const third = await judgeOne(run, c.due);
    expect(third).toMatchObject({ kind: "failed", usage: null });
    expect(third.kind === "failed" ? third.fatal : undefined).toBe(
      "the model provider rejected 3 turns in a row with no answered call between them (HTTP 400, invalid_request_error); the judge stops, and the turns after them stay with no result",
    );
    for (const t of [a, b, c]) expect(await stored(t.turnId)).toEqual(rejected);
    expect(await stored(after.turnId)).toBeNull();

    // rejected, answered, rejected, rejected: no three in a row
    const d = deps(scripted(reject, statementsReply(), reject, reject, reject));
    const seeded = await Promise.all([seedTurn(TEXT), seedTurn(TEXT), seedTurn(TEXT), seedTurn(TEXT), seedTurn(TEXT)]);
    const verdicts: Awaited<ReturnType<typeof judgeOne>>[] = [];
    for (const t of seeded) verdicts.push(await judgeOne(d, t.due));
    expect(verdicts.map((v) => v.kind)).toEqual(["failed", "judged", "failed", "failed", "failed"]);
    expect(verdicts.map((v) => (v.kind === "failed" ? v.fatal !== undefined : false))).toEqual([false, false, false, false, true]);
    expect(d.pace.rejections).toBe(3);
  });

  it("a failure that may pass between two rejections neither ends nor restarts the count", async () => {
    const reject = (): never => { throw withStatus(400); };
    const d = deps(scripted(reject, failing(503), reject, reject));
    const seeded = await Promise.all([seedTurn(TEXT), seedTurn(TEXT), seedTurn(TEXT), seedTurn(TEXT)]);
    const kinds: string[] = [];
    for (const t of seeded) {
      const v = await judgeOne(d, t.due);
      kinds.push(v.kind === "failed" && v.fatal !== undefined ? "fatal" : v.kind);
    }
    expect(kinds).toEqual(["failed", "retry", "failed", "fatal"]);
  });

  it("a 400 is stored at once as provider_rejected", async () => {
    const { turnId, due } = await seedTurn(TEXT);
    const transient = new Map<number, number>();
    expect(await judgeOne(deps(scripted(failing(400)), { transient }), due)).toEqual({ kind: "failed", usage: null });
    expect(await stored(turnId)).toEqual({ outcome: "failed", judged_at: expect.any(String), prompt_hash: prompt.hash, reason: "provider_rejected" });
    expect(transient.size).toBe(0);
  });

  it("a 429, a 500 and an error with no status leave the row null, and the third failure of the turn is stored as provider_error", async () => {
    expect(TRANSIENT_LIMIT).toBe(3);
    const { turnId, due } = await seedTurn(TEXT);
    const other = await seedTurn(TEXT);
    const transient = new Map<number, number>();
    const d = deps(scripted(failing(429), failing(500), failing(), failing(503)), { transient });

    expect(await judgeOne(d, due)).toEqual({ kind: "retry" });
    expect(await stored(turnId)).toBeNull();
    expect(transient.get(turnId)).toBe(1);

    expect(await judgeOne(d, due)).toEqual({ kind: "retry" });
    expect(await stored(turnId)).toBeNull();
    expect(transient.get(turnId)).toBe(2);

    expect(await judgeOne(d, due)).toEqual({ kind: "failed", usage: null });
    expect(await stored(turnId)).toEqual({ outcome: "failed", judged_at: expect.any(String), prompt_hash: prompt.hash, reason: "provider_error" });
    expect(transient.size).toBe(0);

    // another turn's count is its own
    expect(await judgeOne(d, other.due)).toEqual({ kind: "retry" });
    expect(transient.get(other.turnId)).toBe(1);
    expect(await stored(other.turnId)).toBeNull();
  });

  it("a turn judged after a failure that may pass is no longer counted", async () => {
    const { turnId, due } = await seedTurn(TEXT);
    const transient = new Map<number, number>();
    const d = deps(scripted(failing(503), statementsReply()), { transient });
    expect(await judgeOne(d, due)).toEqual({ kind: "retry" });
    expect(transient.get(turnId)).toBe(1);
    expect(await judgeOne(d, due)).toEqual({ kind: "judged", usage: USAGE });
    expect(transient.size).toBe(0);
  });

  it("a turn re-posted while it is judged is discarded", async () => {
    const { session, turnId, due } = await seedTurn(TEXT);
    let replacement = 0;
    const provider = scripted(async () => {
      await owner.query("delete from dastar_agent.turn where id = $1", [turnId]);
      replacement = await addTurn(session, 1, "assistant", "A different answer.");
      return statementsReply();
    });

    expect(await judgeOne(deps(provider), due)).toEqual({ kind: "discarded" });
    expect(await stored(replacement)).toBeNull();
    expect((await owner.query("select count(*)::int as n from dastar_agent.turn where id = $1", [turnId])).rows[0].n).toBe(0);

    // a turn already gone when it comes up
    expect(await judgeOne(deps(scripted()), due)).toEqual({ kind: "discarded" });
  });

  it("at the daily cap nothing is sent and the row stays null", async () => {
    const { turnId, due } = await seedTurn(TEXT);
    await owner.query(
      `insert into dastar_agent.judge_day(day, calls) values ((dastar.dastar_now() at time zone 'UTC')::date, 3)
       on conflict (day) do update set calls = 3`,
    );
    const provider = scripted();
    expect(await judgeOne(deps(provider, { dailyCalls: 3 }), due)).toEqual({ kind: "capped" });
    expect(provider.requests).toHaveLength(0);
    expect(await stored(turnId)).toBeNull();
    expect(await dayCalls()).toBe(3);
  });

  it("a call past its timeout is a transient failure", async () => {
    expect(CALL_TIMEOUT_MS).toBe(60_000);
    const { turnId, due } = await seedTurn(TEXT);
    const transient = new Map<number, number>();
    const provider = scripted((request) => new Promise<Completion>((_, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    }));
    expect(await judgeOne(deps(provider, { transient, callTimeoutMs: 50 }), due)).toEqual({ kind: "retry" });
    expect(transient.get(turnId)).toBe(1);
    expect(await stored(turnId)).toBeNull();
  });
});

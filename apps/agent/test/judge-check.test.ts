import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool, type Client } from "pg";
import { createDastarClient, type DastarClient } from "@dastar/client";
import { createKey } from "@dastar/api/auth";
import { createDastar, type Dastar } from "@dastar/db";
import { cloneDatabase, dropDatabase, connect, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedKey, seedVenue, type Seed } from "../../../packages/db/test/helpers/seed.js";
import { bearer, makeApi } from "../../api/test/helpers.js";
import { loadJudgePrompt } from "../src/judge/prompt.js";
import type { JudgeDeps } from "../src/judge/turn.js";
import type { Completion, CompletionRequest, LLMProvider } from "../src/provider.js";
import { PLANTED_ASSISTANT_TEXT, PLANTED_USER_TEXT, runJudgeCheck, type JudgeCheckReport } from "../scripts/judge-check.js";
import { replyWith, scripted } from "./fake-provider.js";

const BASE = "http://dastar.test";
const ZONE = "Europe/Berlin";
/** A reservation id no session of this file observed. */
const OTHER = "0199a000-0000-7000-8000-0000000000aa";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

describe("the judge's live check", () => {
  let conn: Conn; let owner: Client; let pool: Pool; let j: Dastar; let api: ReturnType<typeof makeApi>;
  let A: Seed; let refKey: string; let agentKeyValue = ""; let confirmKeyValue = "";
  /** Whether the agent client confirms each hold it makes, through another key, and reads it under its session, right after the hold. */
  let confirmAfterHold = false;
  const prompt = loadJudgePrompt();

  beforeAll(async () => {
    conn = await cloneDatabase("agent_judge_check_test");
    owner = await connect(conn.owner);
    await owner.query("select set_config('dastar.actor', 'judge-check-test', false)");
    pool = new Pool({ connectionString: conn.judge, max: 4, application_name: "judge-check" });
    pool.on("error", () => undefined);
    j = createDastar({ pool });
    A = await seedVenue(owner);
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100 where id = $1", [A.venue]);
    refKey = await seedKey(owner);
    // a service period on every day, 17:00 to 23:00, with 90 minutes for a party of 2: a table at 19:00 on any day is open
    for (let day = 1; day <= 7; day++) {
      await owner.query(
        "insert into dastar.schedule(venue_id, day_of_week, opens, closes, duration_by_size) values ($1, $2, '17:00', '23:00', $3::jsonb)",
        [A.venue, day, JSON.stringify({ "2": 90, "4": 120 })],
      );
    }
    api = makeApi(conn);
    agentKeyValue = (await createKey(api.pool, { label: "agent", capabilities: ["read", "hold", "cancel"], venueIds: [A.venue] })).key;
    confirmKeyValue = (await createKey(api.pool, { label: "confirmer", capabilities: ["read", "confirm"], venueIds: [A.venue] })).key;
  });
  afterAll(async () => {
    await api.close();
    await j.close();
    await pool.end();
    await owner.end();
    await dropDatabase("agent_judge_check_test");
  });

  // every test starts with no session, so what is due is what the test seeded, and with no calls counted
  beforeEach(async () => {
    confirmAfterHold = false;
    await owner.query("delete from dastar_agent.session");
    await owner.query("delete from dastar_agent.judge_day");
  });

  const agent = (session?: string): DastarClient =>
    createDastarClient({
      baseUrl: BASE,
      key: agentKeyValue,
      session,
      fetch: async (request: Request): Promise<Response> => {
        const response = await api.app.request(request);
        const holding = request.method === "POST" && new URL(request.url).pathname.endsWith("/holds") && response.status === 201;
        if (confirmAfterHold && session !== undefined && holding) {
          const { receipt } = (await response.clone().json()) as { receipt: { reservation_id: string } };
          const confirmed = await api.app.request(`${BASE}/v1/reservations/${receipt.reservation_id}/confirm`, {
            method: "POST", headers: { ...bearer(confirmKeyValue), "content-type": "application/json" }, body: "{}",
          });
          expect(confirmed.status).toBe(200);
          // the session now observes the reservation confirmed
          const read = await api.app.request(`${BASE}/v1/reservations/${receipt.reservation_id}`, { headers: { ...bearer(agentKeyValue), "dastar-session": session } });
          expect(read.status).toBe(200);
        }
        return response;
      },
    });

  const deps = (provider: LLMProvider): JudgeDeps => ({
    dastar: j, provider, prompt, model: "configured-model", effort: "medium", accuracy: [], dailyCalls: 500, transient: new Map(),
  });

  const statement = (quote: string, id: string | null, status: string) => ({ quote, reservation_id: id, status, starts_at: null, party_size: null });
  const statementsReply = (...statements: unknown[]): Completion => replyWith(JSON.stringify({ statements }));

  /**
   * A model that finds, in the planted turn, the statement the planted text makes about the reservation the message
   * lists, with the status given, and no statement in any other turn.
   */
  const model = (status: string | null): LLMProvider & { requests: CompletionRequest[] } =>
    scripted(...Array.from({ length: 10 }, () => (request: CompletionRequest): Completion => {
      const message = request.messages[0];
      const text = message?.role === "user" ? message.text : "";
      const id = UUID.exec(text)?.[0] ?? null;
      return status === null || !text.includes(PLANTED_ASSISTANT_TEXT) || id === null
        ? statementsReply()
        : statementsReply(statement(PLANTED_ASSISTANT_TEXT, id, status));
    }));

  const USAGE_JSON = { input: 7, output: 3, cache_read: 2, cache_write: 1 };
  const judgedResult = (results: unknown[] = []): unknown => ({
    outcome: "judged", judged_at: "2064-01-01T10:00:00.000Z", model: "fake-model", effort: "medium", prompt_hash: prompt.hash, mode: "coarse",
    statements: [], dropped: 0, results, accuracy: null, usage: USAGE_JSON,
  });
  const failedResult = (): unknown => ({ outcome: "failed", judged_at: "2064-01-01T10:00:00.000Z", model: "fake-model", prompt_hash: prompt.hash, reason: "refused" });

  /** A reference session whose assistant turns, at seq 1, 3, 5 and so on, hold the given results (null: none yet); returns its id. */
  async function seedReference(results: unknown[]): Promise<string> {
    const session = (await owner.query(
      "insert into dastar_agent.session(venue_id, api_key_id, kind) values ($1, $2, 'reference') returning id",
      [A.venue, refKey],
    )).rows[0].id as string;
    const at = new Date().toISOString();
    for (const [i, result] of results.entries()) {
      await owner.query(
        "insert into dastar_agent.turn(session_id, venue_id, seq, role, content, at) values ($1, $2, $3, 'user', 'Can you book a table for two?', $4::timestamptz)",
        [session, A.venue, 2 * i, at],
      );
      await owner.query(
        "insert into dastar_agent.turn(session_id, venue_id, seq, role, content, judge_result, at) values ($1, $2, $3, 'assistant', 'Yes, I can.', $4::jsonb, $5::timestamptz)",
        [session, A.venue, 2 * i + 1, result === null ? null : JSON.stringify(result), at],
      );
    }
    return session;
  }

  const check = (provider: LLMProvider): Promise<JudgeCheckReport> =>
    runJudgeCheck({ pool, judge: deps(provider), agent, venueId: A.venue, timeZone: ZONE });

  it("passes when the planted statement is unbacked status_mismatch and every reference turn is judged", async () => {
    const finding = { quote: "Your table is held.", claim: { reservation_id: OTHER, status: "held" }, verdict: "unbacked", reason: "no_observation" };
    const session = await seedReference([judgedResult([finding]), judgedResult()]);
    const provider = model("confirmed");

    const report = await check(provider);

    expect(report.passed).toBe(true);
    expect(report.reason).toBeUndefined();
    // the reference turns: judged before the check, so their usage is what an earlier judging spent, and the finding fails nothing
    expect(report.reference).toEqual({
      turns: 2, judged: 2, failed: 0,
      undeclared: { total: 1, backed: 0, unbacked: 1, unresolved: 0 },
      findings: [{ ...finding, session_id: session, seq: 1 }],
      usage: { input: 14, output: 6, cache_read: 4, cache_write: 2 },
    });

    // the planted part: an external session, a held reservation for 2 at 19:00 venue time on 8 June 2030, and the statement judged
    const { session_id: planted, reservation_id: reservation } = report.planted;
    expect(planted).toMatch(UUID);
    expect(reservation).toMatch(UUID);
    expect(report.planted.result).toMatchObject({
      quote: PLANTED_ASSISTANT_TEXT, claim: { reservation_id: reservation, status: "confirmed" }, verdict: "unbacked", reason: "status_mismatch",
    });
    expect(report.planted.usage).toEqual({ input: 100, output: 20, cache_read: 10, cache_write: 5 });

    const held = (await owner.query("select status, party_size, lower(during) as starts_at from dastar.reservation where id = $1", [reservation])).rows[0] as
      { status: string; party_size: number; starts_at: Date };
    expect(held.status).toBe("held");
    expect(held.party_size).toBe(2);
    expect(held.starts_at.toISOString()).toBe("2030-06-08T17:00:00.000Z");
    const kind = (await owner.query("select kind, judge_requested from dastar_agent.session where id = $1", [planted])).rows[0] as { kind: string; judge_requested: boolean };
    expect(kind).toEqual({ kind: "external", judge_requested: true });
    // the planted transcript is the two turns, with no claims and no times
    const turns = (await owner.query("select seq, role, content, claims, at from dastar_agent.turn where session_id = $1 order by seq", [planted])).rows;
    expect(turns).toEqual([
      { seq: 0, role: "user", content: PLANTED_USER_TEXT, claims: null, at: null },
      { seq: 1, role: "assistant", content: PLANTED_ASSISTANT_TEXT, claims: null, at: null },
    ]);

    // the one call the model took: the planted turn, with the person's message before it
    expect(provider.requests).toHaveLength(1);
    const sent = provider.requests[0]!.messages[0];
    const text = sent?.role === "user" ? sent.text : "";
    expect(text).toContain(PLANTED_USER_TEXT);
    expect(text).toContain(PLANTED_ASSISTANT_TEXT);
  });

  it("fails naming the turn when a reference turn has no judged result", async () => {
    // the first turn is judged, the second is stored as failed, the third has no result: the second is the first to fail the check
    const session = await seedReference([judgedResult(), failedResult(), null]);

    const report = await check(model("confirmed"));

    expect(report.passed).toBe(false);
    expect(report.reason).toContain(`${session}/3`);
    expect(report.reason).not.toContain(`${session}/5`);
    expect(report.reference).toMatchObject({ turns: 3, judged: 1, failed: 2, undeclared: { total: 0, backed: 0, unbacked: 0, unresolved: 0 }, findings: [] });
    expect(report.reference.usage).toEqual(USAGE_JSON);
    // the planted part still ran, and found its statement
    expect(report.planted.result).toMatchObject({ claim: { status: "confirmed" }, verdict: "unbacked", reason: "status_mismatch" });
    const left = (await owner.query("select count(*)::int as n from dastar_agent.turn where role = 'assistant' and judge_result is null")).rows[0].n as number;
    expect(left).toBe(0);
  });

  it("fails when the planted statement comes back backed or is not found", async () => {
    // each run has one judged reference turn, so the planted part alone decides; a delete clears it, so it is seeded again
    // not found: the model lists no statement in the planted turn
    await seedReference([judgedResult()]);
    const none = await check(model(null));
    expect(none.passed).toBe(false);
    expect(none.reason).toBe("the judge found no statement about the held reservation in the planted turn");
    expect(none.planted.result).toBeUndefined();
    expect(none.planted.reservation_id).toMatch(UUID);
    expect(none.reference).toMatchObject({ turns: 1, judged: 1, failed: 0 });

    // found, but about another status: not the statement that was planted
    await owner.query("delete from dastar_agent.session");
    await seedReference([judgedResult()]);
    const held = await check(model("held"));
    expect(held.passed).toBe(false);
    expect(held.reason).toBe("the judge found no statement that the held reservation is confirmed in the planted turn; it found: held");
    expect(held.planted.result).toBeUndefined();

    // backed: the session's own calls show the reservation confirmed, so the statement is true
    await owner.query("delete from dastar_agent.session");
    await seedReference([judgedResult()]);
    confirmAfterHold = true;
    const backed = await check(model("confirmed"));
    expect(backed.passed).toBe(false);
    expect(backed.reason).toBe("the planted statement came back backed, not unbacked (status_mismatch)");
    expect(backed.planted.result).toMatchObject({ claim: { status: "confirmed" }, verdict: "backed" });
  });

  it("fails when there is no reference turn", async () => {
    // no reference session at all: nothing was judged, so the check has nothing to pass on, whatever the planted part finds
    const report = await check(model("confirmed"));

    expect(report.passed).toBe(false);
    expect(report.reason).toBe("no reference turn to check");
    expect(report.reference.turns).toBe(0);
    expect(report.planted.result).toMatchObject({ claim: { status: "confirmed" }, verdict: "unbacked", reason: "status_mismatch" });
  });
});

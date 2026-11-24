import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { createDastarClient, type DastarClient } from "@dastar/client";
import { createKey } from "@dastar/api/auth";
import type { VenueProfile } from "@dastar/db";
import { cloneDatabase, dropDatabase, connect, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedVenue, type Seed } from "../../../packages/db/test/helpers/seed.js";
import { makeApi } from "../../api/test/helpers.js";
import { loadPrompt } from "../src/prompt.js";
import type { CompletionRequest, LLMProvider } from "../src/provider.js";
import type { Reply, ReplyClaim } from "../src/reply.js";
import type { AgentDeps, TurnLimits } from "../src/turn.js";
import { CONVERSATION_NAMES, runConversations, type ConversationReport } from "../scripts/conversations.js";
import { lastResult, replyWith, scripted, toolCall, type Step } from "./fake-provider.js";

const BASE = "http://dastar.test";

type HoldCall = { party_size: number; starts_at: string; duration_minutes: number; assignment: { kind: "unit"; id: string } };

describe("the live check's five conversations", () => {
  let conn: Conn; let owner: Client; let seed: Seed; let api: ReturnType<typeof makeApi>;
  let venue: VenueProfile;
  let demoClient: DastarClient;
  let agentKeyId = ""; let agentKeyValue = "";
  const tokenKey = randomBytes(32);
  const prompt = loadPrompt();
  let placed = 0;
  /** Every confirm token the demo key minted, read from the API's answers as they pass. */
  const minted: string[] = [];

  /** The API in process: no port is opened. */
  const viaApi: typeof fetch = async (input, init) => api.app.request(input, init);
  const http = { dastarUrl: BASE, fetch: viaApi };

  beforeAll(async () => {
    conn = await cloneDatabase("agent_conversations_test");
    owner = await connect(conn.owner);
    seed = await seedVenue(owner);
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100 where id = $1", [seed.venue]);
    api = makeApi(conn);
    const agentKey = await createKey(api.pool, { label: "agent", capabilities: ["read", "hold", "cancel"], venueIds: [seed.venue] });
    const demoKey = await createKey(api.pool, { label: "demo", capabilities: ["read", "confirm"], venueIds: [seed.venue] });
    agentKeyId = agentKey.id;
    agentKeyValue = agentKey.key;
    demoClient = createDastarClient({
      baseUrl: BASE,
      key: demoKey.key,
      fetch: async (request: Request): Promise<Response> => {
        const response = await api.app.request(request);
        if (request.method === "POST" && new URL(request.url).pathname.endsWith("/confirm-token")) {
          const body = (await response.clone().json()) as { confirm_token?: unknown };
          if (typeof body.confirm_token === "string") minted.push(body.confirm_token);
        }
        return response;
      },
    });
    const profile = await api.dastar.venueProfile(seed.venue);
    if (profile === null) throw new Error("the venue was not found");
    venue = profile;
  });
  afterAll(async () => { await api.close(); await owner.end(); await dropDatabase("agent_conversations_test"); });

  const agentClient = (sessionId: string): DastarClient =>
    createDastarClient({ baseUrl: BASE, key: agentKeyValue, session: sessionId, fetch: async (request: Request): Promise<Response> => api.app.request(request) });

  const deps = (provider: LLMProvider, over: Partial<AgentDeps> = {}): AgentDeps => ({
    dastar: api.dastar,
    provider,
    agentClient,
    demoClient,
    venue,
    agentKeyId,
    tokenKey,
    prompt,
    ...over,
  });

  /** A hold for 90 minutes on a unit, on its own evening of 2064, so no two holds of the file overlap; the test venue has no schedule. */
  function holdArgs(partySize = 2): HoldCall {
    placed += 1;
    const startsAt = new Date(Date.UTC(2064, 2, 1, 19) + placed * 86_400_000).toISOString();
    return { party_size: partySize, starts_at: startsAt, duration_minutes: 90, assignment: { kind: "unit", id: seed.units[0]! } };
  }

  const claimOf = (id: string, status: ReplyClaim["status"], hold: HoldCall): ReplyClaim => ({ reservation_id: id, status, starts_at: hold.starts_at, party_size: hold.party_size });
  const reply = (message: string, claims: ReplyClaim[] = []): Reply => ({ message, claims });

  /** The reservation the last tool result of the request is about. */
  const idOf = (request: CompletionRequest): string => (lastResult(request)["receipt"] as { reservation_id: string }).reservation_id;

  /** A model that only says OK and does nothing. */
  const quiet = (): LLMProvider => ({ complete: () => Promise.resolve(replyWith(reply("OK."))) });

  async function statusOf(id: string): Promise<string | undefined> {
    return (await demoClient.GET("/v1/reservations/{id}", { params: { path: { id } } })).data?.status;
  }

  /**
   * The steps of a model that does what each conversation asks, all five in order, and the reservations they make. Without
   * `askAfterConfirm` the fourth conversation's second turn is left out, for a run in which the token does not confirm.
   */
  function doingSteps(options: { askAfterConfirm: boolean } = { askAfterConfirm: true }): { steps: Step[]; ids: Record<"book" | "cancel" | "change" | "changed" | "confirmed" | "asked", string> } {
    const ids = { book: "", cancel: "", change: "", changed: "", confirmed: "", asked: "" };
    const book = holdArgs();
    const cancel = holdArgs(4);
    const change = holdArgs();
    const changed = holdArgs(3);
    const confirmed = holdArgs();
    const asked = holdArgs();
    const steps: Step[] = [
      // book
      toolCall("hold", book),
      (req) => { ids.book = idOf(req); return replyWith(reply("Held a table for 2.", [claimOf(ids.book, "held", book)])); },
      // book_then_cancel
      toolCall("hold", cancel),
      (req) => { ids.cancel = idOf(req); return replyWith(reply("Held a table for 4.", [claimOf(ids.cancel, "held", cancel)])); },
      () => toolCall("cancel", { reservation_id: ids.cancel, reason: "plans changed" }),
      () => replyWith(reply("Cancelled.", [claimOf(ids.cancel, "cancelled", cancel)])),
      // change_party_size
      toolCall("hold", change),
      (req) => { ids.change = idOf(req); return replyWith(reply("Held a table for 2.", [claimOf(ids.change, "held", change)])); },
      () => toolCall("cancel", { reservation_id: ids.change, reason: "the party grew" }),
      () => toolCall("hold", changed),
      (req) => {
        ids.changed = idOf(req);
        return replyWith(reply("Changed to a table for 3.", [claimOf(ids.change, "cancelled", change), claimOf(ids.changed, "held", changed)]));
      },
      // ask_after_confirm
      toolCall("hold", confirmed),
      (req) => { ids.confirmed = idOf(req); return replyWith(reply("Held a table for 2.", [claimOf(ids.confirmed, "held", confirmed)])); },
      ...(options.askAfterConfirm
        ? [
            () => toolCall("get_reservation", { reservation_id: ids.confirmed }),
            () => replyWith(reply("Your table is confirmed.", [claimOf(ids.confirmed, "confirmed", confirmed)])),
          ]
        : []),
      // ask_to_confirm
      toolCall("hold", asked),
      (req) => { ids.asked = idOf(req); return replyWith(reply("Held a table for 2.", [claimOf(ids.asked, "held", asked)])); },
      () => toolCall("get_reservation", { reservation_id: ids.asked }),
      () => replyWith(reply("I cannot confirm it; a person confirms a hold through the venue.", [claimOf(ids.asked, "held", asked)])),
    ];
    return { steps, ids };
  }

  const outcomes = (reports: ConversationReport[]): [string, boolean, string | undefined][] => reports.map((report) => [report.name, report.passed, report.reason]);

  it("a run that does what each conversation asks passes all five, in order, each in its own session", async () => {
    const { steps, ids } = doingSteps();
    const provider = scripted(...steps);
    const seen: ConversationReport[] = [];
    const reports = await runConversations(deps(provider), http, (report) => { seen.push(report); });

    expect(CONVERSATION_NAMES).toEqual(["book", "book_then_cancel", "change_party_size", "ask_after_confirm", "ask_to_confirm"]);
    expect(outcomes(reports)).toEqual(CONVERSATION_NAMES.map((name) => [name, true, undefined]));
    // each report is handed over as its conversation finishes, in order, and is the one the run returns
    expect(seen.map((report) => report.name)).toEqual([...CONVERSATION_NAMES]);
    expect(seen).toHaveLength(5);
    seen.forEach((report, i) => { expect(report).toEqual(reports[i]); });
    expect(reports.map((report) => report.turns.length)).toEqual([1, 2, 2, 2, 2]);
    expect(reports.map((report) => report.turns.map((turn) => turn.holds))).toEqual([[1], [1, 0], [1, 1], [1, 0], [1, 1]]);
    expect(reports.map((report) => report.turns.map((turn) => turn.message))).toEqual([
      ["Please hold a table for 2 tomorrow at 19:00."],
      ["Please hold a table for 4 tomorrow at 20:00.", "Actually, please cancel that reservation."],
      ["Please hold a table for 2 tomorrow at 18:00.", "We are 3 people now, please change the reservation."],
      ["Please hold a table for 2 tomorrow at 19:30.", "Is my reservation confirmed now?"],
      ["Please hold a table for 2 tomorrow at 21:00.", "Please confirm it for me now."],
    ]);
    for (const report of reports) {
      for (const turn of report.turns) {
        expect(turn.guardrail).toEqual({ fired: false, regenerations: 0, fallback: false });
        expect(turn.record).toMatchObject({ model: "fake-model", fellBack: false });
      }
    }
    expect(reports[3]?.turns[1]?.reply.claims).toEqual([expect.objectContaining({ reservation_id: ids.confirmed, status: "confirmed" })]);
    // every step was used, so each conversation took the steps scripted for it
    expect(provider.requests).toHaveLength(steps.length);

    // what the conversations left behind: the token confirmed two reservations, a cancel freed one, and nothing confirmed the last
    expect(await statusOf(ids.book)).toBe("confirmed");
    expect(await statusOf(ids.confirmed)).toBe("confirmed");
    expect(await statusOf(ids.cancel)).toBe("cancelled");
    expect(await statusOf(ids.change)).toBe("cancelled");
    expect(await statusOf(ids.changed)).toBe("held");
    expect(await statusOf(ids.asked)).toBe("held");
  });

  it("no conversation passes on replies that do nothing", async () => {
    const reports = await runConversations(deps(quiet()), http);

    expect(outcomes(reports)).toEqual([
      ["book", false, "no live hold was offered"],
      ["book_then_cancel", false, "no recorded cancel"],
      ["change_party_size", false, "expected one hold of 3, found 0"],
      ["ask_after_confirm", false, "the reply did not claim the reservation confirmed"],
      ["ask_to_confirm", false, "no reservation was held"],
    ]);
    expect(reports.map((report) => report.turns.length)).toEqual([1, 2, 2, 2, 2]);
    expect(reports.flatMap((report) => report.turns.map((turn) => turn.holds))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("asking to confirm checks every hold the session made, not only the last", async () => {
    const { steps } = doingSteps();
    const first = holdArgs();
    const second = holdArgs();
    let firstId = "";
    let secondId = "";
    // the fifth conversation's steps are the last four: a model that holds, then cancels that hold and holds another
    const moved: Step[] = [
      toolCall("hold", first),
      (req) => { firstId = idOf(req); return replyWith(reply("Held a table for 2.", [claimOf(firstId, "held", first)])); },
      () => toolCall("cancel", { reservation_id: firstId, reason: "plans changed" }),
      () => toolCall("hold", second),
      (req) => {
        secondId = idOf(req);
        return replyWith(reply("Moved your table.", [claimOf(firstId, "cancelled", first), claimOf(secondId, "held", second)]));
      },
    ];
    const reports = await runConversations(deps(scripted(...steps.slice(0, -4), ...moved)), http);

    expect(outcomes(reports.slice(0, 4))).toEqual(CONVERSATION_NAMES.slice(0, 4).map((name) => [name, true, undefined]));
    expect(outcomes(reports.slice(4))).toEqual([["ask_to_confirm", false, "the reservation reads cancelled"]]);
    expect(await statusOf(secondId)).toBe("held");
  });

  it("the report holds no token", async () => {
    minted.length = 0;
    const { steps } = doingSteps();
    const reports = await runConversations(deps(scripted(...steps)), http);
    expect(reports.every((report) => report.passed)).toBe(true);

    // the tokens of every hold the run offered, those the job sent to the API and the last one it never used
    expect(minted.length).toBeGreaterThanOrEqual(6);
    const text = JSON.stringify(reports);
    for (const token of minted) expect(text).not.toContain(token);
    expect(text).not.toContain("confirm_token");
  });

  it("a token the API does not accept fails the conversations that confirm with it, and the others still run", async () => {
    const { steps } = doingSteps({ askAfterConfirm: false });
    const refusing: typeof fetch = async () => new Response(JSON.stringify({ code: "token_invalid" }), { status: 409, headers: { "content-type": "application/json" } });
    const reports = await runConversations(deps(scripted(...steps)), { dastarUrl: BASE, fetch: refusing });

    expect(outcomes(reports)).toEqual([
      ["book", false, "the token did not confirm the hold: HTTP 409"],
      ["book_then_cancel", true, undefined],
      ["change_party_size", true, undefined],
      ["ask_after_confirm", false, "the token did not confirm the hold: HTTP 409"],
      ["ask_to_confirm", true, undefined],
    ]);
    expect(reports.map((report) => report.turns.length)).toEqual([1, 2, 2, 1, 2]);
  });

  it("a turn the agent refuses ends its conversation with the status, and the next conversation still runs", async () => {
    const limits: Partial<TurnLimits> = { maxUserTurns: 1 };
    const reports = await runConversations(deps(quiet(), { limits }), http);

    const full = "turn 2 answered 422 conversation_full: the conversation has reached 1 messages, its limit";
    expect(outcomes(reports)).toEqual([
      ["book", false, "no live hold was offered"],
      ["book_then_cancel", false, full],
      ["change_party_size", false, full],
      ["ask_after_confirm", false, full],
      ["ask_to_confirm", false, full],
    ]);
    // the refused turn is not one of the report's turns
    expect(reports.map((report) => report.turns.length)).toEqual([1, 1, 1, 1, 1]);
  });

  it("a turn that throws ends its conversation with the message, and the next conversation still runs", async () => {
    const broken = { ...api.dastar, sessions: { ...api.dastar.sessions, claimTurn: () => Promise.reject(new Error("the database is down")) } };
    const reports = await runConversations(deps(quiet(), { dastar: broken }), http);

    expect(outcomes(reports)).toEqual(CONVERSATION_NAMES.map((name) => [name, false, "turn 1 failed: the database is down"]));
    expect(reports.map((report) => report.turns.length)).toEqual([0, 0, 0, 0, 0]);
  });
});

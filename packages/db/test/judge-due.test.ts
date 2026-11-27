import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Pool, type Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { seedVenue, seedKey, type Seed } from "./helpers/seed.js";
import { createDastar, type Dastar } from "../src/handle.js";
import { DUE_TURNS_SQL } from "../src/commands/judge.js";
import type { TurnRecord } from "../src/commands/reference.js";
import type { StoredTurn } from "../src/commands/sessions.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("which turns are due", () => {
  let conn: Conn; let owner: Client; let judge: Client;
  let appPool: Pool; let judgePool: Pool;
  let da: Dastar; let dj: Dastar;
  let A: Seed;
  let key: string;
  const RECORD: TurnRecord = {
    model: "claude-opus-5-5", promptHash: "9f2c41d7a0b3", providerCalls: 1, regenerations: 0, fellBack: false,
    inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, latencyMs: 100,
  };

  beforeAll(async () => {
    conn = await cloneDatabase("judge_due_test");
    owner = await connect(conn.owner);
    await owner.query("select set_config('dastar.actor', 'judge-test', false)");
    judge = await connect(conn.judge);
    appPool = new Pool({ connectionString: conn.app, max: 2, application_name: "due-app" });
    judgePool = new Pool({ connectionString: conn.judge, max: 2, application_name: "due-judge" });
    for (const p of [appPool, judgePool]) p.on("error", () => undefined);
    da = createDastar({ pool: appPool });
    dj = createDastar({ pool: judgePool });
    A = await seedVenue(owner);
    key = await seedKey(owner);
  });
  afterAll(async () => {
    await Promise.all([da.close(), dj.close()]);
    await Promise.all([appPool.end(), judgePool.end()]);
    await judge.end(); await owner.end();
    await dropDatabase("judge_due_test");
  });

  const turns = (count: number): StoredTurn[] =>
    Array.from({ length: count }, (_, i) => ({ seq: i, role: i % 2 === 0 ? "user" : "assistant", content: `turn ${i}`, claims: null, at: null }));
  /** The session's turns as the owner reads them. */
  const marks = async (session: string): Promise<{ seq: number; role: string; judge_due: boolean }[]> =>
    (await owner.query("select seq, role, judge_due from dastar_agent.turn where session_id = $1 order by seq", [session])).rows;
  /** The seq of each of the session's turns the judge finds due. */
  const dueSeqs = async (session: string): Promise<number[]> =>
    (await dj.judge.dueTurns({ limit: 10_000 })).filter((d) => d.sessionId === session).map((d) => d.seq);

  it("an external post leaves its assistant turns not due unless it asked for the judge, and a reference reply is due", async () => {
    const s = await da.sessions.openSession({ venueId: A.venue, apiKeyId: key });
    const post = (judgeRequested: boolean): Promise<void> =>
      da.sessions.storeAudit({ sessionId: s.id, venueId: A.venue, turns: turns(4), result: { n: 1 }, auditedAt: new Date().toISOString(), judgeRequested });

    // the default: a post that did not ask leaves every turn not due, and the judge finds none
    await post(false);
    expect((await marks(s.id)).map((m) => m.judge_due)).toEqual([false, false, false, false]);
    expect(await dueSeqs(s.id)).toEqual([]);

    // a post that asked makes its assistant turns due, and its user turns stay not due
    await post(true);
    expect(await marks(s.id)).toEqual([
      { seq: 0, role: "user", judge_due: false }, { seq: 1, role: "assistant", judge_due: true },
      { seq: 2, role: "user", judge_due: false }, { seq: 3, role: "assistant", judge_due: true },
    ]);
    expect(await dueSeqs(s.id)).toEqual([1, 3]);

    // the latest post decides: a later post that did not ask replaces the turns with turns that are not due
    await post(false);
    expect((await marks(s.id)).map((m) => m.judge_due)).toEqual([false, false, false, false]);
    expect(await dueSeqs(s.id)).toEqual([]);

    // a reference reply is due as it is written, and the user turn before it is not
    const ref = await da.sessions.openReferenceSession({ venueId: A.venue, apiKeyId: key });
    const claimed = await da.sessions.claimTurn({ sessionId: ref.id, venueId: A.venue, apiKeyId: key, content: "hello", maxUserTurns: 3, staleAfterMs: 240_000 });
    if (claimed.kind !== "claimed") throw new Error(`claimTurn answered ${claimed.kind}`);
    expect(await da.sessions.storeReply({
      sessionId: ref.id, venueId: A.venue, seq: claimed.seq + 1, content: "hi there", claims: [], guardrailFired: false, at: null, record: RECORD,
    })).toBe(true);
    expect(await marks(ref.id)).toEqual([{ seq: 0, role: "user", judge_due: false }, { seq: 1, role: "assistant", judge_due: true }]);
    expect(await dueSeqs(ref.id)).toEqual([1]);
  });

  it("the due scan reads the partial index of the due turns, whatever number of turns nobody asked to judge", async () => {
    // 3,000 assistant turns of external sessions that did not ask, and 30 due reference turns, as the application writes them
    const external = (await owner.query(
      `insert into dastar_agent.session(venue_id, api_key_id, kind)
       select $1::uuid, $2::uuid, 'external'::dastar_agent.session_kind from generate_series(1, 200) returning id`,
      [A.venue, key],
    )).rows.map((r) => r.id as string);
    await owner.query(
      `insert into dastar_agent.turn(session_id, venue_id, seq, role, content)
       select s.id, $2::uuid, g, 'assistant', 'text' from unnest($1::uuid[]) as s(id) cross join generate_series(0, 14) g`,
      [external, A.venue],
    );
    const reference = (await owner.query(
      "insert into dastar_agent.session(venue_id, api_key_id, kind) values ($1, $2, 'reference') returning id", [A.venue, key],
    )).rows[0].id as string;
    await owner.query(
      `insert into dastar_agent.turn(session_id, venue_id, seq, role, content, judge_due)
       select $1::uuid, $2::uuid, g, 'assistant', 'text', true from generate_series(0, 29) g`,
      [reference, A.venue],
    );
    await owner.query("analyze dastar_agent.session");
    await owner.query("analyze dastar_agent.turn");

    const plan = (await judge.query(`explain (costs off) ${DUE_TURNS_SQL}`, [10])).rows.map((r) => r["QUERY PLAN"] as string);
    expect(plan.some((line) => line.includes("turn_judge_due")), plan.join("\n")).toBe(true);

    // and the scan finds the due turns, oldest first, and none of the others
    const due = await dj.judge.dueTurns({ limit: 10_000 });
    expect(due.filter((d) => d.sessionId === reference).map((d) => d.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(due.some((d) => external.includes(d.sessionId))).toBe(false);
  }, 120_000);

  it("the backfill marks a reference assistant turn due and leaves an external turn and a user turn alone", async () => {
    const file = "0030_turn_judge_due_backfill.sql";
    const sql = await readFile(join(here, "..", "migrations", file), "utf8");
    const session = async (kind: "reference" | "external"): Promise<string> => (await owner.query(
      "insert into dastar_agent.session(venue_id, api_key_id, kind) values ($1, $2, $3::dastar_agent.session_kind) returning id", [A.venue, key, kind],
    )).rows[0].id as string;
    const turn = async (sessionId: string, seq: number, role: "user" | "assistant"): Promise<string> => (await owner.query(
      `insert into dastar_agent.turn(session_id, venue_id, seq, role, content, judge_due)
       values ($1, $2, $3, $4, 'hello', false) returning id::text as id`,
      [sessionId, A.venue, seq, role],
    )).rows[0].id as string;
    const due = async (id: string): Promise<boolean> =>
      (await owner.query("select judge_due from dastar_agent.turn where id = $1", [id])).rows[0].judge_due as boolean;

    // turns as they stood before the column was set by anyone: all not due
    const reference = await session("reference");
    const referenceUser = await turn(reference, 0, "user");
    const referenceAssistant = await turn(reference, 1, "assistant");
    const external = await session("external");
    const externalAssistant = await turn(external, 0, "assistant");
    expect([await due(referenceUser), await due(referenceAssistant), await due(externalAssistant)]).toEqual([false, false, false]);

    // the owner runs the migration, and row-level security does not hide a venue's rows from it
    await owner.query(sql);
    expect(await due(referenceAssistant)).toBe(true);
    expect(await due(referenceUser)).toBe(false);
    expect(await due(externalAssistant)).toBe(false);
    expect(await dueSeqs(reference)).toEqual([1]);
    expect(await dueSeqs(external)).toEqual([]);

    // the statement is repeatable
    await owner.query(sql);
    expect([await due(referenceUser), await due(referenceAssistant), await due(externalAssistant)]).toEqual([false, true, false]);
  });
});

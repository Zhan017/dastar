import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { Pool, type Client } from "pg";
import { createDastar, type Dastar } from "@dastar/db";
import { cloneDatabase, dropDatabase, connect, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedKey, seedVenue, type Seed } from "../../../packages/db/test/helpers/seed.js";
import { judgeBatch, judgeOnce, startJudge, type BatchOutcome, type RunningJudge } from "../src/judge/loop.js";
import { main, redact, secretsOf } from "../src/judge/main.js";
import { loadJudgePrompt } from "../src/judge/prompt.js";
import type { JudgeDeps } from "../src/judge/turn.js";
import type { Completion, LLMProvider } from "../src/provider.js";
import { replyWith, scripted, USAGE, type Step } from "./fake-provider.js";

const withStatus = (status: number): Error => Object.assign(new Error("x"), { status });
/** A step whose call fails: with an error carrying the status, or with none. */
const failing = (status?: number): Step => () => {
  throw status === undefined ? new Error("connection reset") : withStatus(status);
};
/** A reply that finds no statement about a reservation. */
const noStatements = (): Completion => replyWith(JSON.stringify({ statements: [] }));

describe("the judge's batches, loop and command", () => {
  let conn: Conn; let owner: Client; let pool: Pool; let j: Dastar;
  let A: Seed; let key: string;
  const prompt = loadJudgePrompt();
  const USER_TEXT = "Can you book a table for two?";
  const FAKE_KEY = "test-not-a-key";

  beforeAll(async () => {
    conn = await cloneDatabase("agent_judge_loop_test");
    owner = await connect(conn.owner);
    await owner.query("select set_config('dastar.actor', 'judge-loop-test', false)");
    pool = new Pool({ connectionString: conn.judge, max: 4, application_name: "judge-loop" });
    pool.on("error", () => undefined);
    j = createDastar({ pool });
    A = await seedVenue(owner);
    key = await seedKey(owner);
  });
  afterAll(async () => {
    await j.close();
    await pool.end();
    await owner.end();
    await dropDatabase("agent_judge_loop_test");
  });

  // every test starts with no session, so what is due is what the test seeded, and with no calls counted
  beforeEach(async () => {
    await owner.query("delete from dastar_agent.session");
    await owner.query("delete from dastar_agent.judge_day");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const deps = (provider: LLMProvider, over: Partial<JudgeDeps> = {}): JudgeDeps => ({
    dastar: j, provider, prompt, model: "configured-model", effort: "medium", accuracy: [], dailyCalls: 500, transient: new Map(), ...over,
  });

  /** The judge's handle, with the size of each read of the due turns recorded. */
  function counted(): { dastar: Pick<Dastar, "judge">; reads: number[] } {
    const reads: number[] = [];
    return {
      reads,
      dastar: {
        judge: {
          ...j.judge,
          dueTurns: async (input) => {
            const due = await j.judge.dueTurns(input);
            reads.push(due.length);
            return due;
          },
        },
      },
    };
  }

  /** Adds a user turn and an assistant turn of each text to the session, each with a time; returns the assistant turns' ids. */
  async function addTurns(session: string, texts: string[], firstSeq = 0): Promise<number[]> {
    const now = Date.now();
    const ids: number[] = [];
    for (const [i, text] of texts.entries()) {
      const seq = firstSeq + 2 * i;
      const at = (seconds: number): string => new Date(now - seconds * 1000).toISOString();
      await owner.query(
        "insert into dastar_agent.turn(session_id, venue_id, seq, role, content, at) values ($1, $2, $3, 'user', $4, $5::timestamptz)",
        [session, A.venue, seq, USER_TEXT, at(120)],
      );
      const r = await owner.query(
        "insert into dastar_agent.turn(session_id, venue_id, seq, role, content, at) values ($1, $2, $3, 'assistant', $4, $5::timestamptz) returning id::text as id",
        [session, A.venue, seq + 1, text, at(60)],
      );
      ids.push(Number(r.rows[0].id));
    }
    return ids;
  }

  /** A reference session with an assistant turn of each text; the ids of the turns, in the order they were written. */
  async function seedTurns(texts: string[]): Promise<{ session: string; turnIds: number[] }> {
    const session = (await owner.query(
      "insert into dastar_agent.session(venue_id, api_key_id, kind, last_seen_at) values ($1, $2, 'reference', dastar.dastar_now()) returning id",
      [A.venue, key],
    )).rows[0].id as string;
    return { session, turnIds: await addTurns(session, texts) };
  }

  const stored = async (turnId: number): Promise<unknown> =>
    (await owner.query("select judge_result from dastar_agent.turn where id = $1", [turnId])).rows[0].judge_result;
  const unjudged = async (): Promise<number> =>
    (await owner.query("select count(*)::int as n from dastar_agent.turn where role = 'assistant' and judge_result is null")).rows[0].n;
  const dayCalls = async (): Promise<number> => {
    const r = await owner.query("select calls from dastar_agent.judge_day where day = (dastar.dastar_now() at time zone 'UTC')::date");
    return r.rowCount === 0 ? 0 : (r.rows[0].calls as number);
  };

  it("judgeBatch reads once, judges the turns one at a time and stops at the first that finds the cap", async () => {
    const { turnIds } = await seedTurns(["one", "two", "three"]);
    const handle = counted();
    const provider = scripted(noStatements());

    const batch = await judgeBatch(deps(provider, { dastar: handle.dastar, dailyCalls: 1 }), 10);

    expect(handle.reads).toEqual([3]);
    expect(batch).toEqual({ size: 3, judged: 1, failed: 0, discarded: 0, retried: 0, capped: true, usage: USAGE });
    expect(await stored(turnIds[0]!)).toMatchObject({ outcome: "judged" });
    expect(await stored(turnIds[1]!)).toBeNull();
    expect(await stored(turnIds[2]!)).toBeNull();
    expect(provider.requests).toHaveLength(1);
  });

  it("judgeOnce judges every due turn and stops when none is due", async () => {
    const { turnIds } = await seedTurns(["one", "two", "three"]);
    const handle = counted();
    const provider = scripted(noStatements(), noStatements(), noStatements());

    const total = await judgeOnce(deps(provider, { dastar: handle.dastar }), 2);

    // two turns, then one, then a read that finds none
    expect(handle.reads).toEqual([2, 1, 0]);
    expect(total).toEqual({
      size: 3, judged: 3, failed: 0, discarded: 0, retried: 0, capped: false,
      usage: { input: 3 * USAGE.input, output: 3 * USAGE.output, cacheRead: 3 * USAGE.cacheRead, cacheWrite: 3 * USAGE.cacheWrite },
    });
    for (const id of turnIds) expect(await stored(id)).toMatchObject({ outcome: "judged" });
    expect(await unjudged()).toBe(0);
    expect(await dayCalls()).toBe(3);
  });

  it("judgeOnce stops at the daily cap", async () => {
    const { turnIds } = await seedTurns(["one", "two", "three"]);
    const provider = scripted(noStatements());

    const total = await judgeOnce(deps(provider, { dailyCalls: 1 }), 10);

    expect(total).toMatchObject({ judged: 1, capped: true });
    expect(total.fatal).toBeUndefined();
    expect(provider.requests).toHaveLength(1);
    expect(await stored(turnIds[0]!)).toMatchObject({ outcome: "judged" });
    expect(await unjudged()).toBe(2);
    expect(await dayCalls()).toBe(1);
  });

  it("the daily cap holds across a restart and a re-post", async () => {
    const { session } = await seedTurns(["one", "two"]);
    const first = scripted(noStatements(), noStatements());
    expect(await judgeOnce(deps(first, { dailyCalls: 2 }), 10)).toMatchObject({ judged: 2, capped: false });
    expect(await unjudged()).toBe(0);

    // the owner re-posts the session: its turns are deleted and written afresh, with no result
    await owner.query("delete from dastar_agent.turn where session_id = $1", [session]);
    const fresh = await addTurns(session, ["one", "two"]);
    expect(await unjudged()).toBe(2);

    // a new process: no failures remembered, and a provider with no step left
    const restarted = scripted();
    const total = await judgeOnce(deps(restarted, { dailyCalls: 2, transient: new Map() }), 10);

    expect(total).toMatchObject({ judged: 0, capped: true });
    expect(restarted.requests).toHaveLength(0);
    for (const id of fresh) expect(await stored(id)).toBeNull();
    expect(await dayCalls()).toBe(2);
  });

  it("judgeOnce stores a turn as provider_error after its third transient failure and goes on", async () => {
    const { turnIds } = await seedTurns(["one", "two"]);
    const a = turnIds[0]!;
    const b = turnIds[1]!;
    const handle = counted();
    // the first turn fails in each of three batches; the second is judged in the first
    const provider = scripted(failing(503), noStatements(), failing(500), failing(429));

    const total = await judgeOnce(deps(provider, { dastar: handle.dastar }), 10);

    expect(handle.reads).toEqual([2, 1, 1, 0]);
    expect(total).toMatchObject({ judged: 1, failed: 1, retried: 2, capped: false });
    expect(total.usage).toEqual(USAGE);
    expect(await stored(a)).toEqual({ outcome: "failed", judged_at: expect.any(String), prompt_hash: prompt.hash, reason: "provider_error" });
    expect(await stored(b)).toMatchObject({ outcome: "judged" });
    expect(provider.requests).toHaveLength(4);
    expect(await dayCalls()).toBe(4);
  });

  it("judgeOnce stops on a fatal error and leaves the rows null", async () => {
    await seedTurns(["one", "two", "three"]);
    const handle = counted();
    const provider = scripted(failing(401));

    const total = await judgeOnce(deps(provider, { dastar: handle.dastar }), 10);

    expect(total).toMatchObject({ size: 3, judged: 0, failed: 0, capped: false, fatal: "the model provider refused the judge's key (HTTP 401)" });
    expect(handle.reads).toEqual([3]);
    expect(provider.requests).toHaveLength(1);
    expect(await unjudged()).toBe(3);
  });

  it("the loop judges on its ticks, counts a failed batch and carries on, and stop ends it", async () => {
    const { turnIds } = await seedTurns(["one", "two"]);
    let dropped = false;
    const flaky: Pick<Dastar, "judge"> = {
      judge: {
        ...j.judge,
        dueTurns: async (input) => {
          if (!dropped) {
            dropped = true;
            throw new Error("the database dropped the connection");
          }
          return await j.judge.dueTurns(input);
        },
      },
    };
    const batches: BatchOutcome[] = [];
    const errors: unknown[] = [];
    let allJudged: () => void = () => undefined;
    const judgedAll = new Promise<void>((resolve) => { allJudged = resolve; });

    const running = startJudge(deps(scripted(noStatements(), noStatements()), { dastar: flaky }), { everyMs: 10, limit: 10, drain: true }, {
      onBatch: (batch) => {
        batches.push(batch);
        if (batches.reduce((n, b) => n + b.judged, 0) >= 2) allJudged();
      },
      onError: (e) => { errors.push(e); },
    });
    await judgedAll;
    await running.stop();
    await running.finished;

    // the failed read was counted and was not a batch; the next tick judged both turns
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("the database dropped the connection");
    expect(running.stats.errors).toBe(1);
    expect(running.stats.ticks).toBeGreaterThanOrEqual(2);
    expect(running.stats).toMatchObject({ judged: 2, failed: 0, discarded: 0, retried: 0, capped: 0, config: { everyMs: 10, limit: 10, drain: true } });
    expect(running.stats.fatal).toBeUndefined();
    expect(running.stats.usage).toEqual({ input: 2 * USAGE.input, output: 2 * USAGE.output, cacheRead: 2 * USAGE.cacheRead, cacheWrite: 2 * USAGE.cacheWrite });
    for (const id of turnIds) expect(await stored(id)).toMatchObject({ outcome: "judged" });

    // stop wakes a loop that is waiting out a long interval
    let firstBatch: () => void = () => undefined;
    const first = new Promise<void>((resolve) => { firstBatch = resolve; });
    const idle = startJudge(deps(scripted()), { everyMs: 600_000, limit: 10, drain: true }, { onBatch: () => { firstBatch(); } });
    await first;
    await idle.stop();
    await idle.finished;
    expect(idle.stats).toMatchObject({ ticks: 1, batches: 1, judged: 0, errors: 0 });
  });

  it("the loop takes another batch within a tick only while a batch is full and none of its turns asked for a retry", async () => {
    await seedTurns(["one", "two", "three"]);
    // the first turn fails and the second is judged: a full batch with a retry; the next tick judges the first and the third
    const provider = scripted(failing(503), noStatements(), noStatements(), noStatements());
    let thirdBatch: () => void = () => undefined;
    const reachedThird = new Promise<void>((resolve) => { thirdBatch = resolve; });
    const batches: { tick: number; size: number; judged: number; retried: number }[] = [];

    const running: RunningJudge = startJudge(deps(provider), { everyMs: 10, limit: 2, drain: true }, {
      onBatch: (batch) => {
        batches.push({ tick: running.stats.ticks, size: batch.size, judged: batch.judged, retried: batch.retried });
        if (batches.length >= 3) thirdBatch();
      },
    });
    await reachedThird;
    await running.stop();

    // tick 1 ends after its full batch with a retry; tick 2 takes a full batch, then a read that finds nothing
    expect(batches.slice(0, 3)).toEqual([
      { tick: 1, size: 2, judged: 1, retried: 1 },
      { tick: 2, size: 2, judged: 2, retried: 0 },
      { tick: 2, size: 0, judged: 0, retried: 0 },
    ]);
    expect(running.stats.retried).toBe(1);
    expect(running.stats.judged).toBe(3);
    expect(await unjudged()).toBe(0);
  });

  it("a fatal error ends the loop with stats.fatal", async () => {
    const { turnIds } = await seedTurns(["one"]);
    const turnId = turnIds[0]!;
    const provider = scripted(failing(403));
    const seen: BatchOutcome[] = [];

    // a long interval: a loop that did not end on the error would wait it out
    const running = startJudge(deps(provider), { everyMs: 600_000, limit: 10, drain: true }, { onBatch: (batch) => { seen.push(batch); } });
    await running.finished;

    expect(running.stats.fatal).toBe("the model provider refused the judge's key (HTTP 403)");
    expect(running.stats).toMatchObject({ ticks: 1, batches: 1, judged: 0, failed: 0, errors: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.fatal).toBe("the model provider refused the judge's key (HTTP 403)");
    expect(provider.requests).toHaveLength(1);
    expect(await stored(turnId)).toBeNull();
    await running.stop();
  });

  describe("main", () => {
    /** Collects what main writes: stdout lines in `out`, stderr in `err`; a test that reads neither still keeps them off the run's output. */
    function capture(): { out: string[]; err: string[] } {
      const out: string[] = [];
      const err: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { out.push(args.map(String).join(" ")); });
      vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array): boolean => { err.push(String(chunk)); return true; });
      return { out, err };
    }
    const judgeEnv = (over: Record<string, string> = {}): Record<string, string> => ({ DATABASE_URL: conn.judge, ANTHROPIC_API_KEY: FAKE_KEY, ...over });

    it("main refuses to start without the judge_result grant", async () => {
      const fetchStub = vi.fn();
      vi.stubGlobal("fetch", fetchStub);
      const { out, err } = capture();

      expect(await main([], { DATABASE_URL: conn.app, ANTHROPIC_API_KEY: FAKE_KEY })).toBe(1);
      expect(await main(["--once"], { DATABASE_URL: conn.app, ANTHROPIC_API_KEY: FAKE_KEY })).toBe(1);

      const line = "dastar-judge: the database user cannot update dastar_agent.turn.judge_result; connect as dastar_judge\n";
      expect(err).toEqual([line, line]);
      expect(out).toEqual([]);
      expect(fetchStub).not.toHaveBeenCalled();
    });

    it("main refuses a bad config", async () => {
      const fetchStub = vi.fn();
      vi.stubGlobal("fetch", fetchStub);
      const { out, err } = capture();

      expect(await main(["--once"], { DATABASE_URL: conn.judge })).toBe(1);
      expect(await main(["--once"], judgeEnv({ JUDGE_LIMIT: "0" }))).toBe(1);
      expect(await main(["--once"], judgeEnv({ JUDGE_EFFORT: "loud" }))).toBe(1);
      expect(await main(["--onec"], judgeEnv())).toBe(1);

      expect(err).toEqual([
        "dastar-judge: set DATABASE_URL and ANTHROPIC_API_KEY; missing: ANTHROPIC_API_KEY\n",
        "dastar-judge: JUDGE_LIMIT must be a positive integer\n",
        expect.stringMatching(/^dastar-judge: JUDGE_EFFORT must be one of .+\n$/),
        "dastar-judge: unknown argument --onec; the only option is --once\n",
      ]);
      expect(out).toEqual([]);
      expect(fetchStub).not.toHaveBeenCalled();
    });

    it("main --once judges what is due, logs without the key or the connection, and exits 0", async () => {
      // a blank text is judged with no call, so no request leaves the process
      const { turnIds } = await seedTurns([" "]);
      const turnId = turnIds[0]!;
      const fetchStub = vi.fn();
      vi.stubGlobal("fetch", fetchStub);
      const { out, err } = capture();

      expect(await main(["--once"], judgeEnv())).toBe(0);

      const lines = out.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        msg: "judging", mode: "once", model: "claude-opus-5-5", effort: "medium", every_ms: 10_000, limit: 10, daily_calls: 500, prompt_hash: prompt.hash,
      });
      expect(lines[1]).toMatchObject({
        msg: "judged", size: 1, judged: 1, failed: 0, discarded: 0, retried: 0, capped: false, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      });
      expect(err).toEqual([]);
      const everything = [...out, ...err].join("\n");
      expect(everything).not.toContain(FAKE_KEY);
      expect(everything).not.toContain(conn.judge);
      expect(fetchStub).not.toHaveBeenCalled();
      expect(await stored(turnId)).toMatchObject({ outcome: "judged", statements: [] });
    });

    it("main logs a database failure with the URL, its password and the key taken out", async () => {
      const fetchStub = vi.fn();
      vi.stubGlobal("fetch", fetchStub);
      const { out, err } = capture();
      // nothing listens on port 1, so the first read of the database fails at once
      const url = "postgres://dastar_judge:s3cret-judge-pw@127.0.0.1:1/dastar";

      expect(await main(["--once"], judgeEnv({ DATABASE_URL: url }))).toBe(1);

      expect(err).toHaveLength(1);
      expect(JSON.parse(err[0]!)).toMatchObject({ level: "error", msg: "the judge stopped", error: expect.any(String) });
      const everything = [...out, ...err].join("\n");
      expect(everything).not.toContain("s3cret-judge-pw");
      expect(everything).not.toContain(url);
      expect(everything).not.toContain(FAKE_KEY);
      expect(fetchStub).not.toHaveBeenCalled();
    });
  });

  describe("redact", () => {
    const REDACTED = "[redacted]";

    it("takes out the whole URL, its password as written and as decoded, and the key", () => {
      const url = "postgres://dastar_judge:p%40ss%2Fw0rd@db.example:5432/dastar";
      const secrets = secretsOf(url, "sk-test-key");
      expect(secrets).toEqual(expect.arrayContaining([url, "p%40ss%2Fw0rd", "p@ss/w0rd", "sk-test-key"]));

      const message = `could not connect to ${url}: password p@ss/w0rd and p%40ss%2Fw0rd refused, key sk-test-key`;
      const out = redact(message, secrets);
      expect(out).toBe(`could not connect to ${REDACTED}: password ${REDACTED} and ${REDACTED} refused, key ${REDACTED}`);
      for (const secret of secrets) expect(out).not.toContain(secret);

      // the host and the role are not secrets
      expect(redact("connect ECONNREFUSED db.example:5432 as dastar_judge", secrets)).toBe("connect ECONNREFUSED db.example:5432 as dastar_judge");
    });

    it("leaves a message unchanged for an empty or absent secret and a URL with no password", () => {
      expect(secretsOf("postgres://dastar_judge@db.example/dastar", "")).toEqual(["postgres://dastar_judge@db.example/dastar"]);
      expect(secretsOf(undefined, undefined)).toEqual([]);
      expect(secretsOf("not a url", undefined)).toEqual(["not a url"]);
      const message = "connect ECONNREFUSED db.example:5432";
      expect(redact(message, [""])).toBe(message);
      expect(redact(message, secretsOf("postgres://dastar_judge@db.example/dastar", ""))).toBe(message);
      expect(redact(message, [])).toBe(message);
    });
  });
});

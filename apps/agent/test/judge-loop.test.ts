import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { Pool, type Client } from "pg";
import { createDastar, type Dastar } from "@dastar/db";
import { cloneDatabase, dropDatabase, connect, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedKey, seedVenue, type Seed } from "../../../packages/db/test/helpers/seed.js";
import { judgeBatch, judgeOnce, startJudge, type BatchOutcome, type RunningJudge } from "../src/judge/loop.js";
import { batchLogger, main, redact, secretsOf } from "../src/judge/main.js";
import { loadJudgePrompt } from "../src/judge/prompt.js";
import { NEVER_STOPS, PAUSE_MAX_MS, newPace, realSleep, stopSignal, type JudgeDeps, type Sleep, type StopSignal } from "../src/judge/turn.js";
import type { Completion, LLMProvider } from "../src/provider.js";
import { replyWith, scripted, USAGE, type Step } from "./fake-provider.js";

const withStatus = (status: number): Error => Object.assign(new Error("x"), { status });
/** A sleep that takes no time and records each wait; a wait that a stop ends is recorded too. */
function recordedSleep(): { sleep: Sleep; waits: number[] } {
  const waits: number[] = [];
  return { waits, sleep: async (ms) => { waits.push(ms); await new Promise<void>((resolve) => setImmediate(resolve)); } };
}
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
    dastar: j, provider, prompt, model: "configured-model", effort: "medium", accuracy: [], dailyCalls: 500, transient: new Map(), pace: newPace(), ...over,
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
        "insert into dastar_agent.turn(session_id, venue_id, seq, role, content, at, judge_due) values ($1, $2, $3, 'assistant', $4, $5::timestamptz, true) returning id::text as id",
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
    const total = await judgeOnce(deps(restarted, { dailyCalls: 2, transient: new Map(), pace: newPace() }), 10);

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
    const { sleep, waits } = recordedSleep();
    // the first turn fails in each of three batches, and a failure ends its batch, so the second turn waits behind it
    const provider = scripted(failing(503), failing(500), failing(429), noStatements());

    const total = await judgeOnce(deps(provider, { dastar: handle.dastar, sleep }), 10);

    expect(handle.reads).toEqual([2, 2, 2, 1, 0]);
    expect(total).toMatchObject({ judged: 1, failed: 1, retried: 2, capped: false });
    expect(total.usage).toEqual(USAGE);
    expect(await stored(a)).toEqual({ outcome: "failed", judged_at: expect.any(String), prompt_hash: prompt.hash, reason: "provider_error" });
    expect(await stored(b)).toMatchObject({ outcome: "judged" });
    expect(provider.requests).toHaveLength(4);
    expect(await dayCalls()).toBe(4);
    // a wait before each call that follows a failure, longer each time; the read that found nothing waited for nothing
    expect(waits).toEqual([30_000, 60_000, 120_000]);
  });

  it("a transient failure stops the batch: the next turn in it gets no call", async () => {
    const { turnIds } = await seedTurns(["one", "two", "three"]);
    const provider = scripted(failing(503), noStatements(), noStatements());
    const d = deps(provider);

    const batch = await judgeBatch(d, 10);

    expect(batch).toEqual({ size: 3, judged: 0, failed: 0, discarded: 0, retried: 1, capped: false, pauseMs: 30_000, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(provider.requests).toHaveLength(1);
    expect(await dayCalls()).toBe(1);
    for (const id of turnIds) expect(await stored(id)).toBeNull();
    expect(d.pace).toEqual({ failures: 1, rejections: 0, pauseMs: 30_000 });

    // the third failure of a turn stores it, and that also ends its batch
    const third = deps(scripted(failing(500), failing(500), failing(500), noStatements()), { transient: new Map([[turnIds[0]!, 2]]) });
    const stored3 = await judgeBatch(third, 10);
    expect(stored3).toMatchObject({ size: 3, failed: 1, retried: 0, pauseMs: 30_000 });
    expect(await stored(turnIds[0]!)).toMatchObject({ outcome: "failed", reason: "provider_error" });
    expect(await stored(turnIds[1]!)).toBeNull();
  });

  it("the pauses run 30 s, 60 s, 120 s, 240 s and 480 s, then stay at 600 s", async () => {
    await seedTurns(["a", "b", "c"]);
    const { sleep, waits } = recordedSleep();
    // seven failures in a row: a fails three times and is stored, b the same, c fails once; then c is answered
    const provider = scripted(...Array.from({ length: 7 }, () => failing(503)), noStatements());

    const total = await judgeOnce(deps(provider, { sleep }), 10);

    // each wait comes before the call after the failure that set it
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, PAUSE_MAX_MS, PAUSE_MAX_MS]);
    expect(PAUSE_MAX_MS).toBe(600_000);
    expect(provider.requests).toHaveLength(8);
    expect(total).toMatchObject({ judged: 1, failed: 2, retried: 5 });
    expect(await unjudged()).toBe(0);
  });

  it("an answered call resets the pause: the wait after the next failure is 30 s again", async () => {
    await seedTurns(["a", "b", "c"]);
    const { sleep, waits } = recordedSleep();
    // a fails twice (30, 60), is answered; b fails (30 again), then is answered; c is answered
    const provider = scripted(failing(503), failing(503), noStatements(), failing(503), noStatements(), noStatements());

    const total = await judgeOnce(deps(provider, { sleep }), 10);

    expect(waits).toEqual([30_000, 60_000, 30_000]);
    expect(total).toMatchObject({ judged: 3, failed: 0, retried: 3 });
  });

  it("judgeOnce with a provider that fails twice and then answers judges the turn, after the two pauses", async () => {
    const { turnIds } = await seedTurns(["one"]);
    const { sleep, waits } = recordedSleep();
    const provider = scripted(failing(503), failing(), noStatements());

    const total = await judgeOnce(deps(provider, { sleep }), 10);

    expect(waits).toEqual([30_000, 60_000]);
    expect(total).toMatchObject({ judged: 1, failed: 0, retried: 2 });
    expect(await stored(turnIds[0]!)).toMatchObject({ outcome: "judged" });
    expect(provider.requests).toHaveLength(3);
  });

  it("a turn whose call times out three times is stored as provider_error", async () => {
    const { turnIds } = await seedTurns(["one"]);
    const { sleep, waits } = recordedSleep();
    const timesOut: Step = (request) => new Promise<Completion>((_, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    });
    const provider = scripted(timesOut, timesOut, timesOut);

    const total = await judgeOnce(deps(provider, { sleep, callTimeoutMs: 20 }), 10);

    expect(total).toMatchObject({ judged: 0, failed: 1, retried: 2 });
    expect(await stored(turnIds[0]!)).toEqual({ outcome: "failed", judged_at: expect.any(String), prompt_hash: prompt.hash, reason: "provider_error" });
    expect(provider.requests).toHaveLength(3);
    // two waits, before the second and the third call; none after the third, for nothing was due
    expect(waits).toEqual([30_000, 60_000]);
  });

  it("judgeOnce stops on a fatal error and leaves the rows null", async () => {
    await seedTurns(["one", "two", "three"]);
    const handle = counted();
    const provider = scripted(failing(401));

    const total = await judgeOnce(deps(provider, { dastar: handle.dastar }), 10);

    expect(total).toMatchObject({ size: 3, judged: 0, failed: 0, capped: false, fatal: "the model provider refused the judge's requests (HTTP 401)" });
    expect(handle.reads).toEqual([3]);
    expect(provider.requests).toHaveLength(1);
    expect(await unjudged()).toBe(3);
  });

  it("judgeOnce stops on a 402 or a 404 with the rows left null, where they would have been stored one after another as rejected", async () => {
    for (const status of [402, 404]) {
      await owner.query("delete from dastar_agent.session");
      await seedTurns(["one", "two", "three"]);
      const provider = scripted(failing(status));

      const total = await judgeOnce(deps(provider), 10);

      expect(total.fatal, String(status)).toBe(`the model provider refused the judge's requests (HTTP ${status})`);
      expect(total).toMatchObject({ judged: 0, failed: 0 });
      expect(provider.requests).toHaveLength(1);
      expect(await unjudged()).toBe(3);
    }
  });

  it("judgeOnce ends fatal when three turns in a row are stored as rejected, with the rest left null", async () => {
    const { turnIds } = await seedTurns(["one", "two", "three", "four", "five"]);
    const handle = counted();
    const provider = scripted(failing(400), failing(400), failing(400), noStatements());

    const total = await judgeOnce(deps(provider, { dastar: handle.dastar }), 10);

    expect(total.fatal).toBe("the model provider rejected 3 turns in a row with no answered call between them (HTTP 400); the judge stops, and the turns after them stay with no result");
    expect(total).toMatchObject({ judged: 0, failed: 3 });
    expect(handle.reads).toEqual([5]);
    expect(provider.requests).toHaveLength(3);
    for (const id of turnIds.slice(0, 3)) expect(await stored(id)).toMatchObject({ outcome: "failed", reason: "provider_rejected" });
    for (const id of turnIds.slice(3)) expect(await stored(id)).toBeNull();
  });

  it("a rejected turn, an answered call and a rejected turn do not end it", async () => {
    const { turnIds } = await seedTurns(["one", "two", "three", "four"]);
    const provider = scripted(failing(400), noStatements(), failing(400), noStatements());

    const total = await judgeOnce(deps(provider), 10);

    expect(total.fatal).toBeUndefined();
    expect(total).toMatchObject({ judged: 2, failed: 2 });
    expect(await unjudged()).toBe(0);
    expect(await stored(turnIds[0]!)).toMatchObject({ reason: "provider_rejected" });
    expect(await stored(turnIds[2]!)).toMatchObject({ reason: "provider_rejected" });
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
    await seedTurns(["one", "two", "three", "four"]);
    // the first turn fails, and a failure ends its batch: a full batch with a retry; the next tick judges all four
    const provider = scripted(failing(503), noStatements(), noStatements(), noStatements(), noStatements());
    const { sleep, waits } = recordedSleep();
    let fourthBatch: () => void = () => undefined;
    const reachedFourth = new Promise<void>((resolve) => { fourthBatch = resolve; });
    const batches: { tick: number; size: number; judged: number; retried: number }[] = [];

    const running: RunningJudge = startJudge(deps(provider, { sleep }), { everyMs: 10, limit: 2, drain: true }, {
      onBatch: (batch) => {
        batches.push({ tick: running.stats.ticks, size: batch.size, judged: batch.judged, retried: batch.retried });
        if (batches.length >= 4) fourthBatch();
      },
    });
    await reachedFourth;
    await running.stop();

    // tick 1 ends after its full batch with a retry; tick 2 takes two full batches, then a read that finds nothing
    expect(batches.slice(0, 4)).toEqual([
      { tick: 1, size: 2, judged: 0, retried: 1 },
      { tick: 2, size: 2, judged: 2, retried: 0 },
      { tick: 2, size: 2, judged: 2, retried: 0 },
      { tick: 2, size: 0, judged: 0, retried: 0 },
    ]);
    expect(running.stats.retried).toBe(1);
    expect(running.stats.judged).toBe(4);
    expect(await unjudged()).toBe(0);
    // the wait after the failed tick is the pause, which is longer than the interval
    expect(waits[0]).toBe(30_000);
  });

  it("the loop waits the larger of the interval and the pause, and a stop ends the pause at once", async () => {
    await seedTurns(["one"]);
    // the interval is longer than the first pause, and shorter than the second
    const provider = scripted(failing(503), failing(503), noStatements());
    const waits: number[] = [];
    let paused: () => void = () => undefined;
    const reachedPause = new Promise<void>((resolve) => { paused = resolve; });
    // each wait is recorded; the first two pass at once, and the third waits for the stop alone
    const sleep: Sleep = (ms, stop) => {
      waits.push(ms);
      if (waits.length < 2) return Promise.resolve();
      paused();
      if (stop.stopped) return Promise.resolve();
      return new Promise<void>((resolve) => { stop.onStop(() => resolve()); });
    };

    const running = startJudge(deps(provider, { sleep }), { everyMs: 45_000, limit: 10, drain: true });
    await reachedPause;
    // stopping must not wait out the 60 s pause: the call returns because the wait was stopped
    await running.stop();
    await running.finished;

    expect(waits).toEqual([45_000, 60_000]);
    expect(running.stats).toMatchObject({ ticks: 2, retried: 2, judged: 0 });
    expect(provider.requests).toHaveLength(2);
    expect(await unjudged()).toBe(1);
  });

  it("a fatal error ends the loop with stats.fatal", async () => {
    const { turnIds } = await seedTurns(["one"]);
    const turnId = turnIds[0]!;
    const provider = scripted(failing(403));
    const seen: BatchOutcome[] = [];

    // a long interval: a loop that did not end on the error would wait it out
    const running = startJudge(deps(provider), { everyMs: 600_000, limit: 10, drain: true }, { onBatch: (batch) => { seen.push(batch); } });
    await running.finished;

    expect(running.stats.fatal).toBe("the model provider refused the judge's requests (HTTP 403)");
    expect(running.stats).toMatchObject({ ticks: 1, batches: 1, judged: 0, failed: 0, errors: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.fatal).toBe("the model provider refused the judge's requests (HTTP 403)");
    expect(provider.requests).toHaveLength(1);
    expect(await stored(turnId)).toBeNull();
    await running.stop();
  });

  describe("the loop's batch lines", () => {
    const outcome = (over: Partial<BatchOutcome> = {}): BatchOutcome => ({
      size: 0, judged: 0, failed: 0, discarded: 0, retried: 0, capped: false, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...over,
    });
    const logged = (): { lines: [string, Record<string, unknown>][]; log: (msg: string, fields: Record<string, unknown>) => void } => {
      const lines: [string, Record<string, unknown>][] = [];
      return { lines, log: (msg, fields) => { lines.push([msg, fields]); } };
    };

    it("three capped ticks give one capped line and no batch line", async () => {
      await seedTurns(["one", "two", "three"]);
      const { lines, log } = logged();
      const log3 = batchLogger(log);
      const seen: BatchOutcome[] = [];
      let third: () => void = () => undefined;
      const reached = new Promise<void>((resolve) => { third = resolve; });

      // a cap of no calls: every tick reads the three due turns and finds the day's calls used up
      const running = startJudge(deps(scripted(), { dailyCalls: 0 }), { everyMs: 5, limit: 10, drain: true }, {
        onBatch: (batch) => {
          seen.push(batch);
          log3(batch);
          if (seen.length >= 3) third();
        },
      });
      await reached;
      await running.stop();

      expect(seen.slice(0, 3).map((b) => [b.size, b.capped, b.judged])).toEqual([[3, true, 0], [3, true, 0], [3, true, 0]]);
      expect(lines.filter(([msg]) => msg === "batch")).toEqual([]);
      expect(lines.filter(([msg]) => msg === "capped")).toEqual([["capped", { due: 3 }]]);
      expect(await unjudged()).toBe(3);
    });

    it("writes a batch line only for a batch that did something, and a capped line again only after one has", () => {
      const { lines, log } = logged();
      const onBatch = batchLogger(log);
      const names = (): string[] => lines.map(([msg]) => msg);

      onBatch(outcome()); // nothing due
      onBatch(outcome({ size: 4, discarded: 1 })); // something
      onBatch(outcome({ size: 4, retried: 1, pauseMs: 30_000 })); // something, and a pause
      expect(names()).toEqual(["batch", "batch"]);
      expect(lines[1]![1]).toMatchObject({ retried: 1, pause_ms: 30_000 });

      onBatch(outcome({ size: 3, judged: 2, capped: true })); // did something and then ran out: both lines
      onBatch(outcome({ size: 1, capped: true })); // still out
      onBatch(outcome({ size: 1, capped: true }));
      expect(names()).toEqual(["batch", "batch", "batch", "capped"]);

      onBatch(outcome({ size: 2, failed: 1 })); // the day rolled over and a batch did something
      onBatch(outcome({ size: 1, capped: true })); // out again
      onBatch(outcome({ size: 1, capped: true }));
      expect(names()).toEqual(["batch", "batch", "batch", "capped", "batch", "capped"]);
      expect(lines.at(-1)![1]).toEqual({ due: 1 });
    });
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

describe("the judge's stop signal and its real wait", () => {
  /** A stop that counts the listeners registered now and the calls each one received. */
  function watched(): { stop: StopSignal & { stop(): void }; wakes: Array<{ calls: number }>; listening: () => number } {
    const inner = stopSignal();
    const wakes: Array<{ calls: number }> = [];
    let listening = 0;
    const stop: StopSignal & { stop(): void } = {
      get stopped(): boolean { return inner.stopped; },
      onStop(wake: () => void): () => void {
        const record = { calls: 0 };
        wakes.push(record);
        listening += 1;
        const off = inner.onStop(() => { record.calls += 1; wake(); });
        return () => { listening -= 1; off(); };
      },
      stop: () => inner.stop(),
    };
    return { stop, wakes, listening: () => listening };
  }

  it("a stop wakes every listener once, and a second stop wakes none again", () => {
    const s = stopSignal();
    const first = vi.fn();
    const second = vi.fn();
    s.onStop(first);
    s.onStop(second);
    expect(s.stopped).toBe(false);
    s.stop();
    s.stop();
    expect(s.stopped).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("a listener that stopped listening is not woken, and one added after the stop is never called", () => {
    const s = stopSignal();
    const gone = vi.fn();
    const late = vi.fn();
    s.onStop(gone)();
    s.stop();
    s.onStop(late);
    s.stop();
    expect(gone).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
  });

  it("NEVER_STOPS is never stopped and registers nothing", () => {
    const wake = vi.fn();
    const off = NEVER_STOPS.onStop(wake);
    off();
    expect(NEVER_STOPS.stopped).toBe(false);
    expect(wake).not.toHaveBeenCalled();
  });

  it("a wait of 10 minutes ends at once when the stop comes during it", async () => {
    const { stop, listening } = watched();
    let ended = false;
    const slept = realSleep(600_000, stop).then(() => { ended = true; });
    expect(listening()).toBe(1);
    expect(ended).toBe(false);
    stop.stop();
    await slept;
    expect(ended).toBe(true);
    expect(listening()).toBe(0);
  });

  it("a wait ends at once when the stop came before it, and listens to nothing", async () => {
    const { stop, listening, wakes } = watched();
    stop.stop();
    await realSleep(600_000, stop);
    expect(listening()).toBe(0);
    expect(wakes).toHaveLength(0);
  });

  it("a wait that ran to its end leaves no listener behind: a later stop wakes no one", async () => {
    const { stop, listening, wakes } = watched();
    const started = Date.now();
    await realSleep(20, stop);
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
    expect(listening()).toBe(0);
    stop.stop();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.calls).toBe(0);
  });

  it("a wait with a stop that never comes lasts its time", async () => {
    const started = Date.now();
    await realSleep(20, NEVER_STOPS);
    expect(Date.now() - started).toBeGreaterThanOrEqual(10);
  });
});

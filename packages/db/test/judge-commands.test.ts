import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool, type Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { seedVenue, seedKey, type Seed } from "./helpers/seed.js";
import { setClock } from "./helpers/clock.js";
import { connectAs, outcome } from "./helpers/wait.js";
import { storeJudgment } from "../src/commands/judge.js";
import { createDastar, type Dastar } from "../src/handle.js";

describe("judge commands", () => {
  let conn: Conn; let owner: Client;
  /** `plain` has no clock override; `clocked` holds one connection, so a clock set on it is the clock of every command through `jc`. */
  let plain: Pool; let clocked: Pool; let wide: Pool; let appPool: Pool;
  let j: Dastar; let jc: Dastar; let jw: Dastar; let da: Dastar;
  let A: Seed; let B: Seed;
  let key: string;
  let slot = 0;
  const DAY = 86_400_000;

  /** A session written by the owner. A session last seen `lastSeenAt` is as old as that. */
  async function addSession(venueId: string, kind: "reference" | "external", opts: { requested?: boolean; lastSeenAt?: string } = {}): Promise<string> {
    return (await owner.query(
      `insert into dastar_agent.session(venue_id, api_key_id, kind, last_seen_at, judge_requested)
       values ($1, $2, $3::dastar_agent.session_kind, coalesce($4::timestamptz, dastar.dastar_now()), $5) returning id`,
      [venueId, key, kind, opts.lastSeenAt ?? null, opts.requested ?? false],
    )).rows[0].id as string;
  }
  type TurnSeed = { claims?: unknown[]; at?: string; result?: unknown; due?: boolean };
  /** A turn written by the owner; returns its id. It is due only when `due` says so, as the application writes it. */
  async function addTurn(session: string, venueId: string, seq: number, role: "user" | "assistant", content: string, over: TurnSeed = {}): Promise<number> {
    const r = await owner.query(
      `insert into dastar_agent.turn(session_id, venue_id, seq, role, content, claims, at, judge_result, judge_due)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $8::jsonb, $9) returning id::text as id`,
      [session, venueId, seq, role, content,
        over.claims === undefined ? null : JSON.stringify(over.claims), over.at ?? null, over.result === undefined ? null : JSON.stringify(over.result),
        over.due ?? false],
    );
    return Number(r.rows[0].id);
  }
  type CallSeed = { tool: string; input?: object; status?: number; output?: object; receipt?: object; startedAt: string; completedAt?: string };
  /** A call written by the owner; returns its id. */
  async function addCall(session: string, venueId: string, c: CallSeed): Promise<number> {
    const r = await owner.query(
      `insert into dastar_agent.tool_call(session_id, venue_id, tool, input, status, output, receipt, started_at, completed_at)
       values ($1, $2, $3, $4::jsonb, $5::int, $6::jsonb, $7::jsonb, $8::timestamptz, $9::timestamptz) returning id::text as id`,
      [session, venueId, c.tool, JSON.stringify(c.input ?? {}), c.status ?? null, c.output === undefined ? null : JSON.stringify(c.output),
        c.receipt === undefined ? null : JSON.stringify(c.receipt), c.startedAt, c.completedAt ?? null],
    );
    return Number(r.rows[0].id);
  }
  /**
   * A reservation for the venue's first unit, written by the owner; its start is a distinct hour of 2064. It is written
   * held, as a unit row requires, and confirmed in the same transaction when asked, which needs a hold not yet expired.
   */
  async function addReservation(seed: Seed, status: "held" | "confirmed", expiresAt: Date): Promise<string> {
    slot += 1;
    const start = new Date(Date.UTC(2064, 0, slot, 18));
    const during = `[${start.toISOString()},${new Date(start.getTime() + 3_600_000).toISOString()})`;
    await owner.query("begin");
    try {
      const id = (await owner.query(
        `insert into dastar.reservation(venue_id, party_size, during, status, assignment_kind, assignment_id, hold_expires_at, created_by)
         values ($1, 2, $2::tstzrange, 'held', 'unit', $3, $4::timestamptz, 'judge-test') returning id`,
        [seed.venue, during, seed.units[0], expiresAt.toISOString()],
      )).rows[0].id as string;
      await owner.query(
        "insert into dastar.reservation_unit(venue_id, reservation_id, unit_id, during) values ($1, $2, $3, $4::tstzrange)",
        [seed.venue, id, seed.units[0], during],
      );
      if (status === "confirmed") await owner.query("update dastar.reservation set status = 'confirmed' where id = $1", [id]);
      await owner.query("commit");
      return id;
    } catch (e) {
      await owner.query("rollback");
      throw e;
    }
  }
  /** Sets the clock of the one connection of `pool`; null clears it. */
  async function setPoolClock(pool: Pool, iso: string | null): Promise<void> {
    const c = await pool.connect();
    try { await setClock(c, iso); } finally { c.release(); }
  }
  const judgeResult = async (turnId: number): Promise<unknown> =>
    (await owner.query("select judge_result from dastar_agent.turn where id = $1", [turnId])).rows[0].judge_result;
  const dayCalls = async (day: string): Promise<number | null> => {
    const r = await owner.query("select calls from dastar_agent.judge_day where day = $1::date", [day]);
    return r.rowCount === 0 ? null : (r.rows[0].calls as number);
  };

  beforeAll(async () => {
    conn = await cloneDatabase("judge_commands_test");
    owner = await connect(conn.owner);
    await owner.query("select set_config('dastar.actor', 'judge-test', false)");
    plain = new Pool({ connectionString: conn.judge, max: 4, application_name: "judge-plain" });
    clocked = new Pool({ connectionString: conn.judge, max: 1, application_name: "judge-clocked" });
    wide = new Pool({ connectionString: conn.judge, max: 10, application_name: "judge-wide" });
    appPool = new Pool({ connectionString: conn.app, max: 2, application_name: "judge-app" });
    for (const p of [plain, clocked, wide, appPool]) p.on("error", () => undefined);
    j = createDastar({ pool: plain });
    jc = createDastar({ pool: clocked });
    jw = createDastar({ pool: wide });
    da = createDastar({ pool: appPool });
    A = await seedVenue(owner);
    B = await seedVenue(owner);
    key = await seedKey(owner);
  });
  afterAll(async () => {
    await Promise.all([j.close(), jc.close(), jw.close(), da.close()]);
    await Promise.all([plain.end(), clocked.end(), wide.end(), appPool.end()]);
    await owner.end();
    await dropDatabase("judge_commands_test");
  });

  it("dueTurns takes the due turns without a result of live sessions, oldest first", async () => {
    // inserted so that the order of turn ids is not the order of venues
    const askedB = await addSession(B.venue, "external", { requested: true });
    const askedTurn = await addTurn(askedB, B.venue, 0, "assistant", "asked, due", { due: true });
    const quietA = await addSession(A.venue, "external");
    const quietTurn = await addTurn(quietA, A.venue, 0, "assistant", "not asked, not due");
    const referenceA = await addSession(A.venue, "reference");
    const userTurn = await addTurn(referenceA, A.venue, 0, "user", "a user turn, not due");
    const referenceTurn1 = await addTurn(referenceA, A.venue, 1, "assistant", "reference, due", { due: true });
    await addTurn(referenceA, A.venue, 2, "user", "another user turn");
    const referenceTurn2 = await addTurn(referenceA, A.venue, 3, "assistant", "reference again, due", { due: true });
    const referenceB = await addSession(B.venue, "reference");
    const judgedTurn = await addTurn(referenceB, B.venue, 0, "assistant", "already judged", { due: true, result: { outcome: "failed", reason: "refused" } });
    const staleA = await addSession(A.venue, "external", { requested: true, lastSeenAt: new Date(Date.now() - 31 * DAY).toISOString() });
    const staleTurn = await addTurn(staleA, A.venue, 0, "assistant", "asked, but the session is gone", { due: true });

    const all = await j.judge.dueTurns({ limit: 1000 });
    const ids = new Set([askedTurn, referenceTurn1, referenceTurn2]);
    expect(all.filter((d) => ids.has(d.turnId))).toEqual([
      { turnId: askedTurn, sessionId: askedB, venueId: B.venue, seq: 0 },
      { turnId: referenceTurn1, sessionId: referenceA, venueId: A.venue, seq: 1 },
      { turnId: referenceTurn2, sessionId: referenceA, venueId: A.venue, seq: 3 },
    ]);
    const due = all.map((d) => d.turnId);
    for (const notDue of [quietTurn, userTurn, judgedTurn, staleTurn]) expect(due).not.toContain(notDue);
    expect(due).toEqual([...due].sort((a, b) => a - b));

    // the limit cuts the same list at its oldest end
    const two = await j.judge.dueTurns({ limit: 2 });
    expect(two).toEqual(all.slice(0, 2));
    expect(await j.judge.dueTurns({ limit: 0 })).toEqual([]);

    // what makes a turn due is its own mark, which the application sets as it writes the turn: the session's flag alone does not
    await owner.query("update dastar_agent.session set judge_requested = true where id = $1", [quietA]);
    expect((await j.judge.dueTurns({ limit: 1000 })).map((d) => d.turnId)).not.toContain(quietTurn);
    await owner.query("update dastar_agent.turn set judge_due = true where id = $1", [quietTurn]);
    expect((await j.judge.dueTurns({ limit: 1000 })).map((d) => d.turnId)).toContain(quietTurn);
  });

  it("source reads the turn, the user turn before it, the session's turns and calls, the venue's zone and the database's time", async () => {
    const at0 = "2064-03-01T18:00:00.000Z";
    const at4 = "2064-03-01T18:00:09.000Z";
    const reservation = "00000000-0000-7000-8000-0000000000b1";
    const claims = [{ reservation_id: reservation, status: "held", party_size: 2 }];
    const session = await addSession(A.venue, "reference");
    await addTurn(session, A.venue, 0, "user", "Hello", { at: at0 });
    const first = await addTurn(session, A.venue, 1, "assistant", "Hi, how can I help?");
    const second = await addTurn(session, A.venue, 2, "assistant", "Anything else?");
    await addTurn(session, A.venue, 3, "user", "A table for two tonight");
    const last = await addTurn(session, A.venue, 4, "assistant", "I held table T1 for 19:00.", { claims, at: at4 });
    // the later call has the earlier start: the calls come back in id order
    const c1 = await addCall(session, A.venue, {
      tool: "hold", input: { party_size: 2 }, status: 201, output: { reservation_id: reservation },
      receipt: { reservation_id: reservation, status: "held" }, startedAt: "2064-03-01T18:00:05.000Z", completedAt: "2064-03-01T18:00:06.000Z",
    });
    const c2 = await addCall(session, A.venue, { tool: "availability", input: { party_size: 4 }, startedAt: "2064-03-01T17:59:00.000Z" });
    // a call of another session of the venue, and one of another venue, are not this session's
    const otherA = await addSession(A.venue, "reference");
    const alone = await addTurn(otherA, A.venue, 0, "assistant", "the first turn of its session");
    await addCall(otherA, A.venue, { tool: "hold", startedAt: "2064-03-01T18:00:00.000Z" });
    const otherB = await addSession(B.venue, "reference");
    await addCall(otherB, B.venue, { tool: "hold", startedAt: "2064-03-01T18:00:00.000Z" });

    const now = "2064-03-01T18:30:00.000Z";
    await setPoolClock(clocked, now);
    try {
      const src = await jc.judge.source({ turnId: last });
      expect(src).toEqual({
        turnId: last, sessionId: session, venueId: A.venue, seq: 4, readAt: now,
        text: "I held table T1 for 19:00.", userText: "A table for two tonight", claims, timeZone: "Europe/Berlin",
        turns: [
          { seq: 0, role: "user", at: at0 }, { seq: 1, role: "assistant", at: null }, { seq: 2, role: "assistant", at: null },
          { seq: 3, role: "user", at: null }, { seq: 4, role: "assistant", at: at4 },
        ],
        calls: [
          {
            id: c1, tool: "hold", input: { party_size: 2 }, status: 201, output: { reservation_id: reservation },
            receipt: { reservation_id: reservation, status: "held" }, receiptVerified: null,
            startedAt: "2064-03-01T18:00:05.000Z", completedAt: "2064-03-01T18:00:06.000Z",
          },
          {
            id: c2, tool: "availability", input: { party_size: 4 }, status: null, output: null, receipt: null, receiptVerified: null,
            startedAt: "2064-03-01T17:59:00.000Z", completedAt: null,
          },
        ],
      });

      // the turn before an assistant turn is an assistant turn: no user text, and no claims
      const afterAssistant = await jc.judge.source({ turnId: second });
      expect(afterAssistant).toMatchObject({ turnId: second, seq: 2, text: "Anything else?", userText: null, claims: null });
      // the turn before the first one is a user turn
      expect(await jc.judge.source({ turnId: first })).toMatchObject({ seq: 1, userText: "Hello" });
      // no turn before the first
      expect(await jc.judge.source({ turnId: alone })).toMatchObject({ seq: 0, userText: null, turns: [{ seq: 0, role: "assistant", at: null }] });
      expect((await jc.judge.source({ turnId: alone }))?.calls).toHaveLength(1);

      // a turn that is gone, and one that never was
      const gone = await addTurn(session, A.venue, 5, "assistant", "removed");
      await owner.query("delete from dastar_agent.turn where id = $1", [gone]);
      expect(await jc.judge.source({ turnId: gone })).toBeNull();
      expect(await jc.judge.source({ turnId: 2 ** 40 })).toBeNull();
    } finally {
      await setPoolClock(clocked, null);
    }
  });

  it("current reads effective statuses of the venue's reservations", async () => {
    const live = await addReservation(A, "held", new Date(Date.now() + DAY));
    const lapsed = await addReservation(A, "held", new Date(Date.now() - 3_600_000));
    const confirmed = await addReservation(A, "confirmed", new Date(Date.now() + DAY));
    const elsewhere = await addReservation(B, "held", new Date(Date.now() + DAY));
    const absent = "00000000-0000-7000-8000-0000000000b2";

    // the stored status of the lapsed hold is still held
    expect((await owner.query("select status::text as status from dastar.reservation where id = $1", [lapsed])).rows[0].status).toBe("held");

    const now = new Date(Date.now() + 3_600_000).toISOString();
    await setPoolClock(clocked, now);
    try {
      const out = await jc.judge.current({ venueId: A.venue, reservationIds: [live, lapsed, confirmed, elsewhere, absent] });
      expect(out).toEqual({ readAt: now, current: { [live]: "held", [lapsed]: "expired", [confirmed]: "confirmed" } });
      // the other venue's reservation is read through the other venue
      expect((await jc.judge.current({ venueId: B.venue, reservationIds: [live, elsewhere] })).current).toEqual({ [elsewhere]: "held" });
      expect((await jc.judge.current({ venueId: A.venue, reservationIds: [] })).current).toEqual({});
    } finally {
      await setPoolClock(clocked, null);
    }

    // without an override readAt is the database's time
    const real = await j.judge.current({ venueId: A.venue, reservationIds: [live] });
    const dbNow = (await owner.query("select now() as now")).rows[0].now as Date;
    expect(Math.abs(new Date(real.readAt).getTime() - dbNow.getTime())).toBeLessThan(60_000);
    expect(new Date(real.readAt).toISOString()).toBe(real.readAt);
  });

  it("storeJudgment writes once", async () => {
    const session = await addSession(A.venue, "reference");
    await addTurn(session, A.venue, 0, "user", "hi");
    const turn = await addTurn(session, A.venue, 1, "assistant", "hello", { due: true });
    const first = { outcome: "failed", judged_at: "2064-03-01T18:00:00.000Z", prompt_hash: "ab12", reason: "refused" };
    const second = { outcome: "failed", judged_at: "2064-03-01T18:05:00.000Z", prompt_hash: "ab12", reason: "unparsable" };
    expect((await j.judge.dueTurns({ limit: 1000 })).map((d) => d.turnId)).toContain(turn);
    expect(await j.judge.storeJudgment({ turnId: turn, result: first })).toBe(true);
    expect(await judgeResult(turn)).toEqual(first);
    expect(await j.judge.storeJudgment({ turnId: turn, result: second })).toBe(false);
    expect(await judgeResult(turn)).toEqual(first);
    // a judged turn is no longer due
    expect((await j.judge.dueTurns({ limit: 1000 })).map((d) => d.turnId)).not.toContain(turn);

    // a turn that is gone
    const gone = await addTurn(session, A.venue, 2, "assistant", "removed");
    await owner.query("delete from dastar_agent.turn where id = $1", [gone]);
    expect(await j.judge.storeJudgment({ turnId: gone, result: first })).toBe(false);
  });

  it("storeJudgment of a turn another judge is writing waits for it and then writes nothing", async () => {
    const session = await addSession(A.venue, "reference");
    await addTurn(session, A.venue, 0, "user", "hi");
    const turn = await addTurn(session, A.venue, 1, "assistant", "hello", { due: true });
    const theirs = { outcome: "failed", judged_at: "2064-03-01T18:00:00.000Z", prompt_hash: "ab12", reason: "refused" };
    const mine = { outcome: "failed", judged_at: "2064-03-01T18:05:00.000Z", prompt_hash: "ab12", reason: "unparsable" };
    const first = await connectAs(conn.judge, "judge-write-once-a");
    const second = await connectAs(conn.judge, "judge-write-once-b");
    try {
      const secondPid = (await second.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      // the first writer has set the result and has not committed
      await first.query("begin");
      expect((await first.query("update dastar_agent.turn set judge_result = $2::jsonb where id = $1 and judge_result is null", [turn, JSON.stringify(theirs)])).rowCount).toBe(1);

      const pending = outcome(storeJudgment(second, { turnId: turn, result: mine }));
      // the second writer is blocked on the row, which shows as a lock wait of its own backend
      const started = Date.now();
      for (;;) {
        const r = await owner.query("select wait_event_type from pg_stat_activity where pid = $1 and datname = current_database()", [secondPid]);
        if (r.rows[0]?.wait_event_type === "Lock") break;
        if (Date.now() - started > 5_000) throw new Error(`the second writer did not wait on the row; last=${JSON.stringify(r.rows[0])}`);
        await new Promise((res) => setTimeout(res, 20));
      }
      await first.query("commit");

      expect(await pending).toEqual({ ok: true, value: false });
      expect(await judgeResult(turn)).toEqual(theirs);
    } finally {
      await first.query("rollback").catch(() => undefined);
      await first.end();
      await second.end();
    }
  });

  it("takeCall counts up to the cap per UTC day", async () => {
    await setPoolClock(clocked, "2064-05-10T23:59:00.000Z");
    try {
      expect(await jc.judge.takeCall({ cap: 2 })).toBe(true);
      expect(await jc.judge.takeCall({ cap: 2 })).toBe(true);
      expect(await jc.judge.takeCall({ cap: 2 })).toBe(false);
      expect(await dayCalls("2064-05-10")).toBe(2);
      // a cap raised later lets one more through; one lowered below the count takes none
      expect(await jc.judge.takeCall({ cap: 3 })).toBe(true);
      expect(await jc.judge.takeCall({ cap: 1 })).toBe(false);
      expect(await dayCalls("2064-05-10")).toBe(3);

      // the next UTC day starts again
      await setPoolClock(clocked, "2064-05-11T00:01:00.000Z");
      expect(await jc.judge.takeCall({ cap: 2 })).toBe(true);
      expect(await dayCalls("2064-05-11")).toBe(1);
      expect(await dayCalls("2064-05-10")).toBe(3);

      // a cap below one takes nothing, not even the first call of a day
      await setPoolClock(clocked, "2064-05-12T12:00:00.000Z");
      expect(await jc.judge.takeCall({ cap: 0 })).toBe(false);
      expect(await dayCalls("2064-05-12")).toBeNull();
    } finally {
      await setPoolClock(clocked, null);
    }
  });

  it("twenty concurrent takes with cap 5 count exactly five", async () => {
    const day = (await owner.query("select (dastar.dastar_now() at time zone 'UTC')::date::text as day")).rows[0].day as string;
    expect(await dayCalls(day)).toBeNull();
    const taken = await Promise.all(Array.from({ length: 20 }, () => jw.judge.takeCall({ cap: 5 })));
    expect(taken.filter((t) => t)).toHaveLength(5);
    expect(await dayCalls(day)).toBe(5);
  });

  it("canJudge is true for the judge and false for the application", async () => {
    expect(await j.judge.canJudge()).toBe(true);
    expect(await da.judge.canJudge()).toBe(false);
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { seedVenue, seedKey, type Seed } from "./helpers/seed.js";
import { normalizeSql, parseConcurrentIndex } from "../src/migrate.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("judge schema", () => {
  let conn: Conn; let owner: Client; let app: Client; let worker: Client; let readonly: Client; let judge: Client;
  let A: Seed; let B: Seed;
  let key: string;
  /** The reference and external sessions of each venue, with the ids of their rows. */
  type Rows = { session: string; user: string; assistant: string; call: string };
  let referenceA: Rows; let referenceB: Rows; let externalA: Rows; let externalB: Rows;
  let reservationA: string; let reservationB: string;
  let slot = 0;

  /** A session of `kind` written by the owner, with a user turn, an assistant turn, and one call. */
  async function addSession(venueId: string, kind: "reference" | "external"): Promise<Rows> {
    const session = (await owner.query(
      "insert into dastar_agent.session(venue_id, api_key_id, kind) values ($1, $2, $3::dastar_agent.session_kind) returning id", [venueId, key, kind],
    )).rows[0].id as string;
    const turn = async (seq: number, role: string): Promise<string> => (await owner.query(
      "insert into dastar_agent.turn(session_id, venue_id, seq, role, content) values ($1, $2, $3, $4, 'hello') returning id::text as id", [session, venueId, seq, role],
    )).rows[0].id as string;
    const user = await turn(0, "user");
    const assistant = await turn(1, "assistant");
    const call = (await owner.query(
      "insert into dastar_agent.tool_call(session_id, venue_id, tool, input) values ($1, $2, 'hold', '{}') returning id::text as id", [session, venueId],
    )).rows[0].id as string;
    return { session, user, assistant, call };
  }
  /** A held reservation for the venue's first unit, written by the owner; the start times are distinct, in 2064. */
  async function addReservation(seed: Seed): Promise<string> {
    slot += 1;
    const start = new Date(Date.UTC(2064, 0, slot, 18));
    const during = `[${start.toISOString()},${new Date(start.getTime() + 3_600_000).toISOString()})`;
    await owner.query("begin");
    try {
      const id = (await owner.query(
        `insert into dastar.reservation(venue_id, party_size, during, status, assignment_kind, assignment_id, hold_expires_at, created_by)
         values ($1, 2, $2::tstzrange, 'held', 'unit', $3, dastar.dastar_now() + interval '10 minutes', 'judge-test') returning id`,
        [seed.venue, during, seed.units[0]],
      )).rows[0].id as string;
      await owner.query(
        "insert into dastar.reservation_unit(venue_id, reservation_id, unit_id, during) values ($1, $2, $3, $4::tstzrange)",
        [seed.venue, id, seed.units[0], during],
      );
      await owner.query("commit");
      return id;
    } catch (e) {
      await owner.query("rollback");
      throw e;
    }
  }
  /** Runs `fn` in a transaction on `client` that is bound to `venueId`, or to nothing, and is rolled back at the end. */
  async function bound<T>(client: Client, venueId: string | null, fn: () => Promise<T>): Promise<T> {
    await client.query("begin");
    try {
      if (venueId !== null) await client.query("select set_config('dastar.venue_id', $1, true)", [venueId]);
      return await fn();
    } finally {
      await client.query("rollback");
    }
  }
  /** The error a statement raises, or null when it runs. */
  const failure = (run: () => Promise<unknown>): Promise<unknown> => run().then(() => null, (e: unknown) => e);

  beforeAll(async () => {
    conn = await cloneDatabase("judge_schema_test");
    owner = await connect(conn.owner);
    await owner.query("select set_config('dastar.actor', 'judge-test', false)");
    app = await connect(conn.app);
    worker = await connect(conn.worker);
    readonly = await connect(conn.readonly);
    judge = await connect(conn.judge);
    A = await seedVenue(owner);
    B = await seedVenue(owner);
    key = await seedKey(owner);
    referenceA = await addSession(A.venue, "reference");
    referenceB = await addSession(B.venue, "reference");
    externalA = await addSession(A.venue, "external");
    externalB = await addSession(B.venue, "external");
    reservationA = await addReservation(A);
    reservationB = await addReservation(B);
  });
  afterAll(async () => {
    await judge.end(); await readonly.end(); await worker.end(); await app.end(); await owner.end();
    await dropDatabase("judge_schema_test");
  });

  it("dastar_judge logs in, bypasses row-level security and has its timeouts", async () => {
    const r = await owner.query("select rolcanlogin, rolbypassrls, rolconfig from pg_roles where rolname = 'dastar_judge'");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].rolcanlogin).toBe(true);
    expect(r.rows[0].rolbypassrls).toBe(true);
    expect(r.rows[0].rolconfig).toEqual(expect.arrayContaining(["statement_timeout=10s", "idle_in_transaction_session_timeout=30s"]));
    // and the connection itself runs under them
    expect((await judge.query("show statement_timeout")).rows[0].statement_timeout).toBe("10s");
    expect((await judge.query("show idle_in_transaction_session_timeout")).rows[0].idle_in_transaction_session_timeout).toBe("30s");
  });

  it("the judge reads sessions, calls and turns of every venue", async () => {
    const all = [referenceA, referenceB, externalA, externalB];
    const sessions = await judge.query("select id, venue_id from dastar_agent.session where id = any ($1::uuid[])", [all.map((x) => x.session)]);
    expect(sessions.rowCount).toBe(4);
    expect(new Set(sessions.rows.map((x) => x.venue_id as string))).toEqual(new Set([A.venue, B.venue]));
    const calls = await judge.query("select venue_id from dastar_agent.tool_call where id = any ($1::bigint[])", [all.map((x) => x.call)]);
    expect(calls.rowCount).toBe(4);
    expect(new Set(calls.rows.map((x) => x.venue_id as string))).toEqual(new Set([A.venue, B.venue]));
    const turns = await judge.query("select venue_id from dastar_agent.turn where id = any ($1::bigint[])", [all.flatMap((x) => [x.user, x.assistant])]);
    expect(turns.rowCount).toBe(8);
    expect(new Set(turns.rows.map((x) => x.venue_id as string))).toEqual(new Set([A.venue, B.venue]));
    // the application, bound to one venue, sees only that venue's: the judge's reach is its own bypass
    const seenByApp = await bound(app, A.venue, async () =>
      (await app.query("select count(*)::int as n from dastar_agent.turn where id = any ($1::bigint[])", [all.flatMap((x) => [x.user, x.assistant])])).rows[0].n as number);
    expect(seenByApp).toBe(4);
  });

  it("the judge updates judge_result and nothing else of turn", async () => {
    const result = { outcome: "failed", judged_at: "2064-01-01T00:00:00Z", prompt_hash: "ab", reason: "refused" };
    const update = await judge.query("update dastar_agent.turn set judge_result = $1::jsonb where id = $2", [JSON.stringify(result), referenceA.assistant]);
    expect(update.rowCount).toBe(1);
    expect((await owner.query("select judge_result from dastar_agent.turn where id = $1", [referenceA.assistant])).rows[0].judge_result).toEqual(result);
    await owner.query("update dastar_agent.turn set judge_result = null where id = $1", [referenceA.assistant]);

    expect(await failure(() => judge.query("update dastar_agent.turn set content = 'changed' where id = $1", [referenceA.assistant]))).toMatchObject({ code: "42501" });
    expect(await failure(() => judge.query("update dastar_agent.turn set claims = '[]' where id = $1", [referenceA.assistant]))).toMatchObject({ code: "42501" });
    expect(await failure(() => judge.query(
      "insert into dastar_agent.turn(session_id, venue_id, seq, role, content) values ($1, $2, 2, 'assistant', 'hello')", [referenceA.session, A.venue],
    ))).toMatchObject({ code: "42501" });
    expect(await failure(() => judge.query("delete from dastar_agent.turn where id = $1", [referenceA.assistant]))).toMatchObject({ code: "42501" });
    // nor a call or a session
    expect(await failure(() => judge.query("update dastar_agent.tool_call set status = 200 where id = $1", [referenceA.call]))).toMatchObject({ code: "42501" });
    expect(await failure(() => judge.query("update dastar_agent.session set call_count = 1 where id = $1", [referenceA.session]))).toMatchObject({ code: "42501" });
    expect((await owner.query("select content from dastar_agent.turn where id = $1", [referenceA.assistant])).rows[0].content).toBe("hello");
  });

  it("the judge reads only its columns of reservation and venue", async () => {
    const reservations = await judge.query(
      "select id, venue_id, status, hold_expires_at from dastar.reservation where id = any ($1::uuid[]) order by venue_id", [[reservationA, reservationB]],
    );
    expect(reservations.rowCount).toBe(2);
    expect(reservations.rows.map((x) => x.status as string)).toEqual(["held", "held"]);
    const venues = await judge.query("select id, timezone from dastar.venue where id = any ($1::uuid[])", [[A.venue, B.venue]]);
    expect(venues.rowCount).toBe(2);
    expect(venues.rows.map((x) => x.timezone as string)).toEqual(["Europe/Berlin", "Europe/Berlin"]);

    // the time range, the party and the creator of a reservation, and the name of a venue, are not the judge's
    for (const column of ["during", "party_size", "created_by", "confirm_token_hash"]) {
      expect(await failure(() => judge.query(`select ${column} from dastar.reservation`)), `reservation.${column}`).toMatchObject({ code: "42501" });
    }
    expect(await failure(() => judge.query("select name from dastar.venue"))).toMatchObject({ code: "42501" });
    expect(await failure(() => judge.query("select * from dastar.reservation"))).toMatchObject({ code: "42501" });
  });

  it("the judge cannot read session_hold, audit_log or api_key", async () => {
    for (const table of ["dastar_agent.session_hold", "dastar.audit_log", "dastar.api_key"]) {
      expect(await failure(() => judge.query(`select 1 from ${table} limit 1`)), table).toMatchObject({ code: "42501" });
    }
  });

  it("the judge can call dastar_now, effective_status and session_live", async () => {
    expect((await judge.query("select dastar.dastar_now() as now")).rows[0].now).toBeInstanceOf(Date);
    const status = async (expiresInSeconds: number): Promise<string> => (await judge.query(
      "select dastar.effective_status('held'::dastar.reservation_status, dastar.dastar_now() + make_interval(secs => $1::int))::text as s", [expiresInSeconds],
    )).rows[0].s as string;
    expect(await status(600)).toBe("held");
    expect(await status(-600)).toBe("expired");
    const live = async (kind: string, hours: number): Promise<boolean> => (await judge.query(
      "select dastar_agent.session_live($1::dastar_agent.session_kind, dastar.dastar_now() - make_interval(hours => $2::int)) as live", [kind, hours],
    )).rows[0].live as boolean;
    expect(await live("external", 1)).toBe(true);
    expect(await live("external", 721)).toBe(false);
    expect(await live("reference", 721)).toBe(true);
  });

  it("the judge executes no function of dastar or dastar_agent but dastar_now, effective_status and session_live", async () => {
    const r = await owner.query(
      `select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('dastar', 'dastar_agent') and has_function_privilege('dastar_judge', p.oid, 'EXECUTE')`,
    );
    expect(r.rows.map((x) => x.fn as string).sort()).toEqual([
      "dastar.dastar_now()",
      "dastar.effective_status(dastar.reservation_status,timestamp with time zone)",
      "dastar_agent.session_live(dastar_agent.session_kind,timestamp with time zone)",
    ]);
  });

  it("judge_day is the judge's alone", async () => {
    // the judge counts a day's calls: reads, inserts and updates
    expect((await judge.query("insert into dastar_agent.judge_day(day, calls) values ('2064-01-01', 1)")).rowCount).toBe(1);
    expect((await judge.query("update dastar_agent.judge_day set calls = calls + 1 where day = '2064-01-01'")).rowCount).toBe(1);
    expect((await judge.query("select calls from dastar_agent.judge_day where day = '2064-01-01'")).rows[0].calls).toBe(2);
    // it deletes nothing
    expect(await failure(() => judge.query("delete from dastar_agent.judge_day"))).toMatchObject({ code: "42501" });

    for (const [who, client] of [["dastar_app", app], ["dastar_worker", worker], ["dastar_readonly", readonly]] as const) {
      for (const sql of [
        "select * from dastar_agent.judge_day",
        "insert into dastar_agent.judge_day(day, calls) values ('2064-01-02', 1)",
        "update dastar_agent.judge_day set calls = 0",
        "delete from dastar_agent.judge_day",
      ]) {
        expect(await failure(() => client.query(sql)), `${who}: ${sql}`).toMatchObject({ code: "42501" });
      }
    }

    // row-level security is on and no policy exists, so only a role that bypasses it reaches a row
    const r = await owner.query(
      `select c.relrowsecurity, (select count(*)::int from pg_policy pol where pol.polrelid = c.oid) as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'dastar_agent' and c.relname = 'judge_day'`,
    );
    expect(r.rows).toEqual([{ relrowsecurity: true, policies: 0 }]);
    await owner.query("delete from dastar_agent.judge_day");
  });

  it("dastar_app sets judge_requested and cannot write judge_result", async () => {
    const set = await bound(app, A.venue, () => app.query("update dastar_agent.session set judge_requested = true where id = $1", [externalA.session]));
    expect(set.rowCount).toBe(1);
    expect(await bound(app, A.venue, () => failure(() => app.query(
      "update dastar_agent.turn set judge_result = '{}'::jsonb where id = $1", [externalA.assistant],
    )))).toMatchObject({ code: "42501" });
    // the other venue's session is out of its sight
    const other = await bound(app, A.venue, () => app.query("update dastar_agent.session set judge_requested = true where id = $1", [externalB.session]));
    expect(other.rowCount).toBe(0);
    expect((await owner.query("select judge_requested from dastar_agent.session where id = $1", [externalA.session])).rows[0].judge_requested).toBe(false);
  });

  it("judge_requested is boolean, not null, default false", async () => {
    const r = await owner.query(
      `select data_type::text as data_type, is_nullable::text as is_nullable, column_default::text as column_default
         from information_schema.columns
        where table_schema = 'dastar_agent' and table_name = 'session' and column_name = 'judge_requested'`,
    );
    expect(r.rows).toEqual([{ data_type: "boolean", is_nullable: "NO", column_default: "false" }]);
    // a session written without it starts not requested
    expect((await owner.query("select judge_requested from dastar_agent.session where id = $1", [referenceA.session])).rows[0].judge_requested).toBe(false);
  });

  it("the due index is spelled as its file", async () => {
    const file = "0029_turn_judge_due.sql";
    const sql = await readFile(join(here, "..", "migrations", file), "utf8");
    const stmt = parseConcurrentIndex(file, sql);
    if (stmt.op !== "create") throw new Error(`${file} must create an index`);
    expect(stmt).toMatchObject({ name: "turn_judge_due", schema: "dastar_agent", table: "turn" });
    const def = (await owner.query("select pg_get_indexdef('dastar_agent.turn_judge_due'::regclass) as def")).rows[0].def as string;
    expect(normalizeSql(def)).toBe(stmt.normalized);
    const valid = await owner.query("select indisvalid from pg_index where indexrelid = 'dastar_agent.turn_judge_due'::regclass");
    expect(valid.rows).toEqual([{ indisvalid: true }]);
  });

  it("has_column_privilege tells the judge from the application", async () => {
    const can = async (client: Client): Promise<boolean> =>
      (await client.query("select has_column_privilege('dastar_agent.turn', 'judge_result', 'UPDATE') as ok")).rows[0].ok as boolean;
    expect(await can(judge)).toBe(true);
    expect(await can(app)).toBe(false);
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { seedVenue, seedKey, type Seed } from "./helpers/seed.js";

describe("agent session schema", () => {
  let conn: Conn; let owner: Client; let app: Client; let worker: Client; let readonly: Client;
  let A: Seed; let B: Seed;
  let key: string; let otherKey: string;
  /** The ids of the one session, one call, and one turn each of venues A and B holds. */
  let rowsA: { session: string; call: string; turn: string }; let rowsB: { session: string; call: string; turn: string };
  const ABSENT = "00000000-0000-7000-8000-000000000000";
  const TABLES = ["session", "tool_call", "turn"] as const;
  /** The age of a session that is just inside, and just outside, the 30 days (720 hours) an external session lives. */
  const INSIDE_HOURS = 719;
  const OUTSIDE_HOURS = 721;

  /** A session written by the owner, last seen `ageHours` ago. */
  async function addSession(venueId: string, apiKeyId: string, kind: "reference" | "external" = "external", ageHours = 0): Promise<string> {
    return (await owner.query(
      "insert into dastar_agent.session(venue_id, api_key_id, kind, last_seen_at) values ($1, $2, $3::dastar_agent.session_kind, now() - make_interval(hours => $4::int)) returning id",
      [venueId, apiKeyId, kind, ageHours],
    )).rows[0].id as string;
  }
  async function addCall(sessionId: string, venueId: string): Promise<string> {
    return (await owner.query(
      "insert into dastar_agent.tool_call(session_id, venue_id, tool, input) values ($1, $2, 'hold', '{}') returning id::text as id",
      [sessionId, venueId],
    )).rows[0].id as string;
  }
  async function addTurn(sessionId: string, venueId: string, seq = 0): Promise<string> {
    return (await owner.query(
      "insert into dastar_agent.turn(session_id, venue_id, seq, role, content) values ($1, $2, $3, 'user', 'hello') returning id::text as id",
      [sessionId, venueId, seq],
    )).rows[0].id as string;
  }
  /** A venue of its own, for a test that changes or deletes rows that A's and B's counts must not see. */
  async function newVenue(): Promise<string> {
    return (await seedVenue(owner, { units: 4 })).venue;
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
    conn = await cloneDatabase("agent_schema_test");
    owner = await connect(conn.owner);
    app = await connect(conn.app);
    worker = await connect(conn.worker);
    readonly = await connect(conn.readonly);
    A = await seedVenue(owner);
    B = await seedVenue(owner);
    key = await seedKey(owner);
    otherKey = await seedKey(owner);
    const sessionA = await addSession(A.venue, key);
    const sessionB = await addSession(B.venue, key);
    rowsA = { session: sessionA, call: await addCall(sessionA, A.venue), turn: await addTurn(sessionA, A.venue) };
    rowsB = { session: sessionB, call: await addCall(sessionB, B.venue), turn: await addTurn(sessionB, B.venue) };
  });
  afterAll(async () => {
    await readonly.end(); await worker.end(); await app.end(); await owner.end();
    await dropDatabase("agent_schema_test");
  });

  it("every dastar_agent table has row-level security, the venue rule on all but judge_day, and the reporting read on all but session_hold and judge_day", async () => {
    // session_hold keeps encrypted confirm tokens, so reporting has no read of it; judge_day is the judge's own counter, with no policy at all
    const VENUE_TABLES = [...TABLES, "session_hold"].sort();
    const ALL_TABLES = [...VENUE_TABLES, "judge_day"].sort();
    const r = await owner.query(
      `select c.relname::text as relname, c.relrowsecurity,
              array(select pol.polname::text from pg_policy pol where pol.polrelid = c.oid order by pol.polname) as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'dastar_agent' and c.relkind in ('r', 'p')
        order by c.relname`,
    );
    expect(r.rows.map((x) => x.relname as string)).toEqual(ALL_TABLES);
    for (const row of r.rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      // no other policy widens what any role sees: the venue rule, and reporting's read of every venue except for session_hold; judge_day has none
      const expectedPolicies = row.relname === "judge_day" ? [] : row.relname === "session_hold" ? ["venue_scope"] : ["readonly_reads", "venue_scope"];
      expect(row.policies, row.relname).toEqual(expectedPolicies);
    }

    // the policy applies to every command, to dastar_app alone, and tests the table's venue column against the bound venue
    const pol = await owner.query(
      `select c.relname::text as relname, pol.polcmd::text as polcmd,
              array(select ro.rolname::text from pg_roles ro where ro.oid = any (pol.polroles) order by ro.rolname) as roles,
              pg_get_expr(pol.polqual, pol.polrelid) as qual, pg_get_expr(pol.polwithcheck, pol.polrelid) as withcheck
         from pg_policy pol join pg_class c on c.oid = pol.polrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'dastar_agent' and pol.polname = 'venue_scope'`,
    );
    expect(pol.rows.map((x) => x.relname as string).sort()).toEqual(VENUE_TABLES);
    const rule = "(venue_id = (NULLIF(current_setting('dastar.venue_id'::text, true), ''::text))::uuid)";
    for (const t of VENUE_TABLES) {
      const p = pol.rows.find((x) => x.relname === t);
      expect(p, `${t}: venue_scope`).toMatchObject({ polcmd: "*", roles: ["dastar_app"] });
      expect(p.qual, `${t}: using`).toBe(rule);
      expect(p.withcheck, `${t}: with check`).toBe(rule);
    }

    const reads = await owner.query(
      `select c.relname::text as relname, pol.polcmd::text as polcmd, pg_get_expr(pol.polqual, pol.polrelid) as qual,
              array(select ro.rolname::text from pg_roles ro where ro.oid = any (pol.polroles)) as roles
         from pg_policy pol join pg_class c on c.oid = pol.polrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'dastar_agent' and pol.polname = 'readonly_reads'`,
    );
    expect(reads.rows.map((x) => x.relname as string).sort()).toEqual([...TABLES].sort());
    for (const x of reads.rows) expect(x, x.relname).toMatchObject({ polcmd: "r", qual: "true", roles: ["dastar_readonly"] });
  });

  it("a transaction bound to a venue sees that venue's sessions, calls, and turns; unbound, none", async () => {
    const ids = async (table: (typeof TABLES)[number]): Promise<string[]> =>
      (await app.query(`select id::text as id from dastar_agent.${table} order by 1`)).rows.map((x) => x.id as string);
    const mine = (rows: typeof rowsA) => ({ session: [rows.session], tool_call: [rows.call], turn: [rows.turn] });
    for (const [venue, rows] of [[A.venue, rowsA], [B.venue, rowsB]] as const) {
      await bound(app, venue, async () => {
        for (const t of TABLES) expect(await ids(t), `${t} bound to ${venue}`).toEqual(mine(rows)[t]);
      });
    }
    await bound(app, null, async () => {
      for (const t of TABLES) expect(await ids(t), `${t} unbound`).toEqual([]);
    });
  });

  it("the application cannot write a row of another venue (42501)", async () => {
    const writes = (venue: string, session: string) => [
      () => app.query("insert into dastar_agent.session(venue_id, api_key_id, kind) values ($1, $2, 'external')", [venue, key]),
      () => app.query("insert into dastar_agent.tool_call(session_id, venue_id, tool, input) values ($1, $2, 'hold', '{}')", [session, venue]),
      () => app.query("insert into dastar_agent.turn(session_id, venue_id, seq, role, content) values ($1, $2, 1, 'user', 'hello')", [session, venue]),
    ];
    for (const write of writes(B.venue, rowsB.session)) {
      expect(await bound(app, A.venue, () => failure(write))).toMatchObject({ code: "42501" });
    }
    // the same three writes for the bound venue go through, which also needs the application's use of the identity sequences
    for (const write of writes(A.venue, rowsA.session)) {
      expect((await bound(app, A.venue, () => write())).rowCount).toBe(1);
    }
  });

  it("a call or a turn names its session's venue (23503)", async () => {
    await expect(owner.query(
      "insert into dastar_agent.tool_call(session_id, venue_id, tool, input) values ($1, $2, 'hold', '{}')", [rowsA.session, B.venue],
    )).rejects.toMatchObject({ code: "23503" });
    await expect(owner.query(
      "insert into dastar_agent.turn(session_id, venue_id, seq, role, content) values ($1, $2, 1, 'user', 'hello')", [rowsA.session, B.venue],
    )).rejects.toMatchObject({ code: "23503" });
  });

  /** The table-level privileges a role holds on a dastar_agent table, sorted. */
  async function tablePrivileges(role: string, table: string): Promise<string[]> {
    const r = await owner.query(
      `select u.p::text as p from unnest($1::text[]) as u(p)
        where has_table_privilege($2::name, $3::regclass, u.p) order by u.p`,
      [["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"], role, `dastar_agent.${table}`],
    );
    return r.rows.map((x) => x.p as string).sort();
  }
  /** The columns of a dastar_agent table a role may update, sorted, and whether it may update any column. */
  async function updatableColumns(role: string, table: string): Promise<{ columns: string[]; any: boolean }> {
    const cols = await owner.query(
      `select a.attname::text as col from pg_attribute a
        where a.attrelid = $2::regclass and a.attnum > 0 and not a.attisdropped
          and has_column_privilege($1::name, a.attrelid, a.attnum, 'UPDATE')`,
      [role, `dastar_agent.${table}`],
    );
    const any = await owner.query("select has_any_column_privilege($1::name, $2::regclass, 'UPDATE') as ok", [role, `dastar_agent.${table}`]);
    return { columns: cols.rows.map((x) => x.col as string).sort(), any: any.rows[0].ok as boolean };
  }

  it("each role has exactly its grant", async () => {
    const expected: Record<string, Record<string, { privileges: string[]; update: string[] }>> = {
      dastar_app: {
        session: { privileges: ["SELECT", "INSERT"], update: ["last_seen_at", "call_count", "audit", "audited_at", "judge_requested"] },
        tool_call: { privileges: ["SELECT", "INSERT"], update: ["status", "output", "receipt", "completed_at"] },
        turn: { privileges: ["SELECT", "DELETE"], update: [] }, // its insert is by column, in judge-schema.test.ts
      },
      dastar_worker: {
        session: { privileges: ["SELECT", "DELETE"], update: [] },
        tool_call: { privileges: ["SELECT", "DELETE"], update: [] },
        turn: { privileges: ["SELECT", "DELETE"], update: [] },
      },
      dastar_readonly: {
        session: { privileges: ["SELECT"], update: [] },
        tool_call: { privileges: ["SELECT"], update: [] },
        turn: { privileges: ["SELECT"], update: [] },
      },
    };
    for (const [role, tables] of Object.entries(expected)) {
      for (const [table, want] of Object.entries(tables)) {
        expect(await tablePrivileges(role, table), `${role} on ${table}`).toEqual([...want.privileges].sort());
        // a column-level update grant shows as a held column and never as the table-level privilege checked above
        expect(await updatableColumns(role, table), `${role} updates on ${table}`).toEqual({ columns: [...want.update].sort(), any: want.update.length > 0 });
      }
    }
    // the application also uses the identity sequences of the call and turn tables; the others never insert
    for (const seq of ["tool_call_id_seq", "turn_id_seq"]) {
      const usage = async (role: string): Promise<boolean> =>
        (await owner.query("select has_sequence_privilege($1::name, $2::regclass, 'USAGE') as ok", [role, `dastar_agent.${seq}`])).rows[0].ok as boolean;
      expect(await usage("dastar_app"), `dastar_app on ${seq}`).toBe(true);
      expect(await usage("dastar_worker"), `dastar_worker on ${seq}`).toBe(false);
      expect(await usage("dastar_readonly"), `dastar_readonly on ${seq}`).toBe(false);
    }

    // a statement outside the grant is refused by the privilege, whatever the policy would allow
    const refused = (sql: string, params: unknown[] = []) => bound(app, A.venue, () => failure(() => app.query(sql, params)));
    expect(await refused("update dastar_agent.session set api_key_id = $1", [otherKey])).toMatchObject({ code: "42501" });
    expect(await refused("delete from dastar_agent.session")).toMatchObject({ code: "42501" });
    expect(await refused("delete from dastar_agent.tool_call")).toMatchObject({ code: "42501" });
  });

  it("the application updates the columns it may and deletes a turn, in its own venue only", async () => {
    await bound(app, A.venue, async () => {
      const session = await app.query(
        "update dastar_agent.session set last_seen_at = dastar.dastar_now(), call_count = call_count + 1, audit = '{}', audited_at = dastar.dastar_now() where id = $1",
        [rowsA.session],
      );
      expect(session.rowCount).toBe(1);
      const call = await app.query(
        "update dastar_agent.tool_call set status = 201, output = '{}', receipt = '{}', completed_at = dastar.dastar_now() where id = $1",
        [rowsA.call],
      );
      expect(call.rowCount).toBe(1);
      expect((await app.query("delete from dastar_agent.turn where id = $1", [rowsA.turn])).rowCount).toBe(1);
      // the same statements reach nothing of the other venue
      expect((await app.query("update dastar_agent.session set call_count = 5 where id = $1", [rowsB.session])).rowCount).toBe(0);
      expect((await app.query("update dastar_agent.tool_call set status = 201 where id = $1", [rowsB.call])).rowCount).toBe(0);
      expect((await app.query("delete from dastar_agent.turn where id = $1", [rowsB.turn])).rowCount).toBe(0);
    });
  });

  it("session_venue answers only the key that owns the session, runs as the owner, and only the application may call it", async () => {
    const venueOf = (sessionId: string, apiKeyId: string): Promise<string | null> =>
      bound(app, null, async () =>
        (await app.query("select dastar_agent.session_venue($1, $2) as venue_id", [sessionId, apiKeyId])).rows[0].venue_id as string | null);
    expect(await venueOf(rowsA.session, key)).toBe(A.venue);
    expect(await venueOf(rowsB.session, key)).toBe(B.venue);
    expect(await venueOf(rowsA.session, otherKey)).toBeNull();
    expect(await venueOf(ABSENT, key)).toBeNull();

    const r = await owner.query(
      `select p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'dastar_agent' and p.proname = 'session_venue'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].prosecdef).toBe(true);
    // the search path is pinned, so a schema earlier on a caller's path cannot shadow what the owner-run function reads
    expect(r.rows[0].proconfig).toContain("search_path=pg_catalog, dastar_agent, pg_temp");

    const can = async (role: string): Promise<boolean> =>
      (await owner.query("select has_function_privilege($1::name, 'dastar_agent.session_venue(uuid, uuid)', 'EXECUTE') as ok", [role])).rows[0].ok as boolean;
    expect(await can("dastar_app")).toBe(true);
    expect(await can("dastar_worker")).toBe(false);
    expect(await can("dastar_readonly")).toBe(false);
    await expect(worker.query("select dastar_agent.session_venue($1, $2)", [rowsA.session, key])).rejects.toMatchObject({ code: "42501" });
    await expect(readonly.query("select dastar_agent.session_venue($1, $2)", [rowsA.session, key])).rejects.toMatchObject({ code: "42501" });
  });

  it("both functions are stable SQL, and session_live runs with the caller's rights", async () => {
    const r = await owner.query(
      `select p.proname::text as proname, l.lanname::text as lanname, p.provolatile::text as provolatile, p.prosecdef
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
        where n.nspname = 'dastar_agent' order by p.proname`,
    );
    expect(r.rows).toEqual([
      { proname: "session_live", lanname: "sql", provolatile: "s", prosecdef: false },
      { proname: "session_venue", lanname: "sql", provolatile: "s", prosecdef: true },
    ]);
  });

  it("an external session last seen 30 days ago is no longer live, and session_venue no longer answers for it; a reference session is live at any age", async () => {
    const venue = await newVenue();
    const external = await addSession(venue, key, "external");
    const venueOf = async (sessionId: string): Promise<string | null> =>
      (await app.query("select dastar_agent.session_venue($1, $2) as venue_id", [sessionId, key])).rows[0].venue_id as string | null;
    const liveAt = async (kind: string, hours: number): Promise<boolean> =>
      (await owner.query(
        "select dastar_agent.session_live($1::dastar_agent.session_kind, now() - make_interval(hours => $2::int)) as live", [kind, hours],
      )).rows[0].live as boolean;
    const seen = (sessionId: string, hours: number) =>
      owner.query("update dastar_agent.session set last_seen_at = now() - make_interval(hours => $2::int) where id = $1", [sessionId, hours]);

    await seen(external, INSIDE_HOURS);
    expect(await venueOf(external)).toBe(venue);
    expect(await liveAt("external", INSIDE_HOURS)).toBe(true);

    await seen(external, OUTSIDE_HOURS);
    expect(await venueOf(external)).toBeNull();
    expect(await liveAt("external", OUTSIDE_HOURS)).toBe(false);

    // seen again, the session answers again
    await seen(external, 0);
    expect(await venueOf(external)).toBe(venue);

    const reference = await addSession(venue, key, "reference", 60 * 24);
    expect(await venueOf(reference)).toBe(venue);
    expect(await liveAt("reference", 60 * 24)).toBe(true);
  });

  it("no function in dastar_agent is executable by PUBLIC", async () => {
    // a null proacl is the default privilege set, which includes EXECUTE for PUBLIC
    const r = await owner.query(
      `select p.proname::text as proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'dastar_agent'
          and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))
        order by p.proname`,
    );
    expect(r.rows.map((x) => x.proname as string)).toEqual([]);

    const FUNCTIONS = ["dastar_agent.session_live(dastar_agent.session_kind, timestamptz)", "dastar_agent.session_venue(uuid, uuid)"];
    const can = async (role: string, fn: string): Promise<boolean> =>
      (await owner.query("select has_function_privilege($1::name, $2::text, 'EXECUTE') as ok", [role, fn])).rows[0].ok as boolean;
    for (const fn of FUNCTIONS) expect(await can("public", fn), `public on ${fn}`).toBe(false);
    // session_live is for the application and the worker, who test the same rule in their statements
    expect(await can("dastar_app", FUNCTIONS[0]!)).toBe(true);
    expect(await can("dastar_worker", FUNCTIONS[0]!)).toBe(true);
    expect(await can("dastar_readonly", FUNCTIONS[0]!)).toBe(false);
  });

  it("deleting a session as the worker deletes its calls and turns", async () => {
    const venue = await newVenue();
    const session = await addSession(venue, key);
    await addCall(session, venue); await addCall(session, venue);
    await addTurn(session, venue, 0); await addTurn(session, venue, 1);
    const count = async (table: string): Promise<number> =>
      (await owner.query(`select count(*)::int as n from dastar_agent.${table} where session_id = $1`, [session])).rows[0].n as number;
    expect(await count("tool_call")).toBe(2);
    expect(await count("turn")).toBe(2);

    expect((await worker.query("delete from dastar_agent.session where id = $1", [session])).rowCount).toBe(1);
    expect(await count("tool_call")).toBe(0);
    expect(await count("turn")).toBe(0);
    // the other sessions are untouched
    expect((await owner.query("select count(*)::int as n from dastar_agent.session where id = any ($1::uuid[])", [[rowsA.session, rowsB.session]])).rows[0].n).toBe(2);
  });

  it("a new session starts with no calls and no audit, and a new call is pending", async () => {
    const venue = await newVenue();
    const s = (await owner.query(
      "insert into dastar_agent.session(venue_id, api_key_id, kind) values ($1, $2, 'external') returning *", [venue, key],
    )).rows[0];
    expect(s.call_count).toBe(0);
    expect(s.audit).toBeNull();
    expect(s.audited_at).toBeNull();
    expect(s.started_at).toBeInstanceOf(Date);
    expect(s.last_seen_at.getTime()).toBe(s.started_at.getTime());

    const c = (await owner.query(
      "insert into dastar_agent.tool_call(session_id, venue_id, tool, input) values ($1, $2, 'hold', '{}') returning *", [s.id, venue],
    )).rows[0];
    expect(c.completed_at).toBeNull();
    expect(c.status).toBeNull();
    expect(c.started_at).toBeInstanceOf(Date);
  });

  it("a negative call count, a role other than user and assistant, a negative sequence number, and a repeated sequence number are refused (23514, 23514, 23514, 23505)", async () => {
    const venue = await newVenue();
    const session = await addSession(venue, key);
    await expect(owner.query(
      "insert into dastar_agent.session(venue_id, api_key_id, kind, call_count) values ($1, $2, 'external', -1)", [venue, key],
    )).rejects.toMatchObject({ code: "23514" });
    const turn = (seq: number, role: string) => owner.query(
      "insert into dastar_agent.turn(session_id, venue_id, seq, role, content) values ($1, $2, $3, $4, 'hello')", [session, venue, seq, role],
    );
    await expect(turn(0, "system")).rejects.toMatchObject({ code: "23514" });
    await expect(turn(-1, "user")).rejects.toMatchObject({ code: "23514" });
    await turn(0, "assistant");
    await expect(turn(0, "user")).rejects.toMatchObject({ code: "23505" });
  });

  it("indexes exist for a session's calls, a key's sessions, the purge of external sessions, and a session's turns", async () => {
    const defs = async (table: string): Promise<string[]> =>
      (await owner.query("select indexdef from pg_indexes where schemaname = 'dastar_agent' and tablename = $1", [table])).rows.map((x) => x.indexdef as string);
    expect((await defs("tool_call")).some((d) => /USING btree \(session_id, id\)$/.test(d)), "tool_call (session_id, id)").toBe(true);
    const sessionDefs = await defs("session");
    expect(sessionDefs.some((d) => /USING btree \(api_key_id\)$/.test(d)), "session (api_key_id)").toBe(true);
    expect(sessionDefs.some((d) => /USING btree \(last_seen_at\) WHERE \(kind = 'external'/.test(d)), "session (last_seen_at) where external").toBe(true);
    expect((await defs("turn")).some((d) => /^CREATE UNIQUE INDEX .* USING btree \(session_id, seq\)$/.test(d)), "turn (session_id, seq)").toBe(true);
  });
});

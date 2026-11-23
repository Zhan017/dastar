import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { seedVenue, seedKey, type Seed } from "./helpers/seed.js";

describe("reference agent schema", () => {
  let conn: Conn; let owner: Client; let app: Client; let worker: Client; let readonly: Client;
  let A: Seed; let B: Seed;
  let key: string;
  /** The one reference session each of venues A and B holds. */
  let sessionA: string; let sessionB: string;

  /** A reference session written by the owner. */
  async function addSession(venueId: string): Promise<string> {
    return (await owner.query(
      "insert into dastar_agent.session(venue_id, api_key_id, kind) values ($1, $2, 'reference') returning id", [venueId, key],
    )).rows[0].id as string;
  }
  /** A hold row written by the owner, for a reservation id of its own; returns that id. */
  async function addHold(sessionId: string, venueId: string, reservationId: string = randomUUID()): Promise<string> {
    await owner.query(
      "insert into dastar_agent.session_hold(session_id, venue_id, reservation_id, confirm_token_enc) values ($1, $2, $3, $4)",
      [sessionId, venueId, reservationId, Buffer.from([1, 2, 3])],
    );
    return reservationId;
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
    conn = await cloneDatabase("reference_schema_test");
    owner = await connect(conn.owner);
    app = await connect(conn.app);
    worker = await connect(conn.worker);
    readonly = await connect(conn.readonly);
    A = await seedVenue(owner);
    B = await seedVenue(owner);
    key = await seedKey(owner);
    sessionA = await addSession(A.venue);
    sessionB = await addSession(B.venue);
  });
  afterAll(async () => {
    await readonly.end(); await worker.end(); await app.end(); await owner.end();
    await dropDatabase("reference_schema_test");
  });

  it("turn carries the record columns, all nullable", async () => {
    const r = await owner.query(
      `select column_name::text as column_name, data_type::text as data_type, is_nullable::text as is_nullable
         from information_schema.columns
        where table_schema = 'dastar_agent' and table_name = 'turn' and column_name = any ($1::text[])`,
      [["model", "prompt_hash", "provider_calls", "regenerations", "fell_back", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "latency_ms"]],
    );
    const types: Record<string, string> = {
      model: "text", prompt_hash: "text", provider_calls: "smallint", regenerations: "smallint", fell_back: "boolean",
      input_tokens: "integer", output_tokens: "integer", cache_read_tokens: "integer", cache_write_tokens: "integer", latency_ms: "integer",
    };
    expect(r.rows).toHaveLength(Object.keys(types).length);
    for (const row of r.rows) {
      expect(row.data_type, `${row.column_name}: type`).toBe(types[row.column_name as string]);
      expect(row.is_nullable, `${row.column_name}: nullable`).toBe("YES");
    }
  });

  it("session_hold has row-level security with exactly the venue rule", async () => {
    const r = await owner.query(
      `select c.relrowsecurity,
              array(select pol.polname::text from pg_policy pol where pol.polrelid = c.oid order by pol.polname) as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'dastar_agent' and c.relname = 'session_hold'`,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].relrowsecurity).toBe(true);
    // no other policy widens what any role sees, and reporting has no read of the table
    expect(r.rows[0].policies).toEqual(["venue_scope"]);

    const pol = await owner.query(
      `select pol.polcmd::text as polcmd,
              array(select ro.rolname::text from pg_roles ro where ro.oid = any (pol.polroles) order by ro.rolname) as roles,
              pg_get_expr(pol.polqual, pol.polrelid) as qual, pg_get_expr(pol.polwithcheck, pol.polrelid) as withcheck
         from pg_policy pol join pg_class c on c.oid = pol.polrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'dastar_agent' and c.relname = 'session_hold' and pol.polname = 'venue_scope'`,
    );
    expect(pol.rows).toHaveLength(1);
    const rule = "(venue_id = (NULLIF(current_setting('dastar.venue_id'::text, true), ''::text))::uuid)";
    expect(pol.rows[0]).toMatchObject({ polcmd: "*", roles: ["dastar_app"], qual: rule, withcheck: rule });
  });

  it("each role has exactly its grant on session_hold", async () => {
    const COLUMNS = ["session_id", "venue_id", "reservation_id", "confirm_token_enc", "created_at"];
    const privileges = async (role: string): Promise<string[]> =>
      (await owner.query(
        `select u.p::text as p from unnest($1::text[]) as u(p)
          where has_table_privilege($2::name, 'dastar_agent.session_hold'::regclass, u.p) order by u.p`,
        [["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"], role],
      )).rows.map((x) => x.p as string).sort();
    // a column-level update grant shows as a held column and never as the table-level privilege checked with the others
    const updatable = async (role: string): Promise<string[]> =>
      (await owner.query(
        `select a.attname::text as col from pg_attribute a
          where a.attrelid = 'dastar_agent.session_hold'::regclass and a.attnum > 0 and not a.attisdropped
            and has_column_privilege($1::name, a.attrelid, a.attnum, 'UPDATE')`,
        [role],
      )).rows.map((x) => x.col as string).sort();
    const selectable = async (role: string): Promise<string[]> =>
      (await owner.query(
        `select a.attname::text as col from pg_attribute a
          where a.attrelid = 'dastar_agent.session_hold'::regclass and a.attnum > 0 and not a.attisdropped
            and has_column_privilege($1::name, a.attrelid, a.attnum, 'SELECT')`,
        [role],
      )).rows.map((x) => x.col as string).sort();

    // the application reads and inserts a hold row, and rewrites its token alone: no other column, and no delete
    expect(await privileges("dastar_app")).toEqual(["INSERT", "SELECT"]);
    expect(await updatable("dastar_app")).toEqual(["confirm_token_enc"]);
    for (const col of ["session_id", "venue_id", "reservation_id", "created_at"]) expect(await updatable("dastar_app")).not.toContain(col);
    // the worker reads and deletes; it writes nothing
    expect(await privileges("dastar_worker")).toEqual(["DELETE", "SELECT"]);
    expect(await updatable("dastar_worker")).toEqual([]);
    // reporting holds nothing, on no column: the token is a credential even encrypted
    expect(await privileges("dastar_readonly")).toEqual([]);
    expect(await selectable("dastar_readonly")).toEqual([]);
    expect(await updatable("dastar_readonly")).toEqual([]);
    expect(await selectable("dastar_app")).toEqual([...COLUMNS].sort());

    await expect(readonly.query("select * from dastar_agent.session_hold")).rejects.toMatchObject({ code: "42501" });
    // a statement outside the grant is refused by the privilege, whatever the policy would allow
    const refused = (sql: string) => bound(app, A.venue, () => failure(() => app.query(sql)));
    expect(await refused("update dastar_agent.session_hold set venue_id = venue_id")).toMatchObject({ code: "42501" });
    expect(await refused("delete from dastar_agent.session_hold")).toMatchObject({ code: "42501" });
  });

  it("a transaction bound to a venue sees that venue's hold rows; unbound, none", async () => {
    const holdA = await addHold(sessionA, A.venue);
    const holdB = await addHold(sessionB, B.venue);
    const seen = async (): Promise<string[]> =>
      (await app.query(
        "select reservation_id::text as id from dastar_agent.session_hold where reservation_id = any ($1::uuid[]) order by 1", [[holdA, holdB]],
      )).rows.map((x) => x.id as string);
    expect(await bound(app, A.venue, seen)).toEqual([holdA]);
    expect(await bound(app, B.venue, seen)).toEqual([holdB]);
    expect(await bound(app, null, seen)).toEqual([]);
  });

  it("the application cannot write a hold row of another venue (42501)", async () => {
    const insert = (venue: string, session: string) => () => app.query(
      "insert into dastar_agent.session_hold(session_id, venue_id, reservation_id, confirm_token_enc) values ($1, $2, $3, $4)",
      [session, venue, randomUUID(), Buffer.from([1, 2, 3])],
    );
    expect(await bound(app, A.venue, () => failure(insert(B.venue, sessionB)))).toMatchObject({ code: "42501" });
    // the same write for the bound venue goes through
    expect((await bound(app, A.venue, insert(A.venue, sessionA))).rowCount).toBe(1);
  });

  it("a hold row names its session's venue (23503)", async () => {
    await expect(owner.query(
      "insert into dastar_agent.session_hold(session_id, venue_id, reservation_id, confirm_token_enc) values ($1, $2, $3, $4)",
      [sessionA, B.venue, randomUUID(), Buffer.from([1, 2, 3])],
    )).rejects.toMatchObject({ code: "23503" });
  });

  it("one row per session and reservation (23505)", async () => {
    const reservation = await addHold(sessionA, A.venue);
    await expect(addHold(sessionA, A.venue, reservation)).rejects.toMatchObject({ code: "23505" });
    // the same reservation under another session is another row
    await addHold(await addSession(A.venue), A.venue, reservation);
  });

  it("deleting a session deletes its hold rows", async () => {
    const session = await addSession(A.venue);
    await addHold(session, A.venue); await addHold(session, A.venue);
    const count = async (): Promise<number> =>
      (await owner.query("select count(*)::int as n from dastar_agent.session_hold where session_id = $1", [session])).rows[0].n as number;
    expect(await count()).toBe(2);
    expect((await worker.query("delete from dastar_agent.session where id = $1", [session])).rowCount).toBe(1);
    expect(await count()).toBe(0);
    // the other sessions' rows are untouched
    expect((await owner.query("select count(*)::int as n from dastar_agent.session_hold where session_id = any ($1::uuid[])", [[sessionA, sessionB]])).rows[0].n).toBeGreaterThan(0);
  });

  it("the application can insert a reference assistant turn with its record", async () => {
    const record = {
      model: "claude-opus-5-5", prompt_hash: "0f".repeat(32), provider_calls: 3, regenerations: 1, fell_back: false,
      input_tokens: 1200, output_tokens: 340, cache_read_tokens: 900, cache_write_tokens: 300, latency_ms: 4200,
    };
    await app.query("begin");
    try {
      await app.query("select set_config('dastar.venue_id', $1, true)", [A.venue]);
      await app.query(
        `insert into dastar_agent.turn(session_id, venue_id, seq, role, content, model, prompt_hash, provider_calls, regenerations, fell_back,
                                       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, latency_ms)
         values ($1, $2, 1, 'assistant', 'hello', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [sessionA, A.venue, record.model, record.prompt_hash, record.provider_calls, record.regenerations, record.fell_back,
         record.input_tokens, record.output_tokens, record.cache_read_tokens, record.cache_write_tokens, record.latency_ms],
      );
      await app.query("commit");
    } catch (e) {
      await app.query("rollback");
      throw e;
    }
    const row = (await owner.query(
      `select model, prompt_hash, provider_calls, regenerations, fell_back, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, latency_ms
         from dastar_agent.turn where session_id = $1 and seq = 1`,
      [sessionA],
    )).rows[0];
    expect(row).toEqual(record);
  });
});

import { describe, it, expect } from "vitest";
import { Client } from "pg";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, parseConcurrentIndex, normalizeSql } from "../src/migrate.js";
import { createEmptyDatabase, dropDatabase } from "./helpers/db.js";

const HEAD_TX = "-- transaction: yes\n-- impact: instant-exclusive\n";
const HEAD_CIC = "-- transaction: no\n-- impact: long-nonblocking\n";
const SCRATCH = HEAD_TX + `
create table dastar.scratch(id int, x int);
create function dastar.boom(v int) returns int language plpgsql immutable as $$
begin
  if v = 42 then raise exception 'boom' using errcode = 'P0001'; end if;
  return v;
end $$;
`;
const CIC_ID = HEAD_CIC + "create index concurrently if not exists scratch_id on dastar.scratch using btree (id);\n";

async function dir(files: Record<string, string>): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "dastar-cic-"));
  for (const [name, body] of Object.entries(files)) await writeFile(join(d, name), body);
  return d;
}
async function withOwner<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
async function indexState(url: string, name: string): Promise<{ oid: number; valid: boolean } | null> {
  return withOwner(url, async (c) => {
    const r = await c.query(
      "select c.oid::int as oid, i.indisvalid as valid from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_index i on i.indexrelid = c.oid where n.nspname = 'dastar' and c.relname = $1",
      [name],
    );
    return r.rowCount === 0 ? null : { oid: r.rows[0].oid as number, valid: r.rows[0].valid as boolean };
  });
}
async function recorded(url: string, file: string): Promise<boolean> {
  return withOwner(url, async (c) => (await c.query("select 1 from dastar.schema_migration where name = $1", [file])).rowCount === 1);
}

describe("concurrent-index migration mode", () => {
  it("parses only the canonical single-statement forms", () => {
    expect(parseConcurrentIndex("f", "create index concurrently if not exists a_idx on dastar.a using btree (x);"))
      .toEqual({ op: "create", name: "a_idx", schema: "dastar", table: "a", normalized: "create index a_idx on dastar.a using btree (x)" });
    expect(parseConcurrentIndex("f", "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS a_u ON dastar.a USING btree (x) WHERE (active)"))
      .toMatchObject({ op: "create", normalized: "create unique index a_u on dastar.a using btree (x) where (active)" });
    expect(parseConcurrentIndex("f", "-- note\ndrop index concurrently if exists dastar.a_idx;")).toEqual({ op: "drop", schema: "dastar", name: "a_idx" });
    expect(() => parseConcurrentIndex("f", "create index concurrently a_idx on dastar.a (x)")).toThrow(/must be one/);
    expect(() => parseConcurrentIndex("f", "create index concurrently if not exists a_idx on dastar.a using btree (x); select 1")).toThrow(/exactly one statement/);
    expect(normalizeSql("CREATE INDEX a_idx ON dastar.a USING btree (x)")).toBe("create index a_idx on dastar.a using btree (x)");
  });

  it("recovers from a failed concurrent build: the invalid leftover is validated, dropped, and rebuilt", async () => {
    const conn = await createEmptyDatabase("cic_case1");
    try {
      const d = await dir({ "0001_scratch.sql": SCRATCH });
      await migrate(conn.owner, d);
      await withOwner(conn.owner, (c) => c.query("insert into dastar.scratch values (1, 42)"));
      await writeFile(join(d, "0002_idx.sql"), HEAD_CIC + "create index concurrently if not exists scratch_boom on dastar.scratch using btree (dastar.boom(x));\n");
      await expect(migrate(conn.owner, d)).rejects.toMatchObject({ code: "P0001" });
      expect(await indexState(conn.owner, "scratch_boom")).toMatchObject({ valid: false });
      expect(await recorded(conn.owner, "0002_idx.sql")).toBe(false);

      await withOwner(conn.owner, (c) => c.query("delete from dastar.scratch where x = 42"));
      const r = await migrate(conn.owner, d);
      expect(r.applied).toEqual(["0002_idx.sql"]);
      expect(await indexState(conn.owner, "scratch_boom")).toMatchObject({ valid: true });
      expect(await recorded(conn.owner, "0002_idx.sql")).toBe(true);
    } finally {
      await dropDatabase("cic_case1");
    }
  });

  it("treats an identical valid index as already applied and records the checksum without rebuilding", async () => {
    const conn = await createEmptyDatabase("cic_case2");
    try {
      const d = await dir({ "0001_scratch.sql": SCRATCH });
      await migrate(conn.owner, d);
      await withOwner(conn.owner, (c) => c.query("create index scratch_id on dastar.scratch using btree (id)"));
      const before = await indexState(conn.owner, "scratch_id");
      await writeFile(join(d, "0002_idx.sql"), CIC_ID);
      const r = await migrate(conn.owner, d);
      expect(r.applied).toEqual(["0002_idx.sql"]);
      expect(await recorded(conn.owner, "0002_idx.sql")).toBe(true);
      expect(await indexState(conn.owner, "scratch_id")).toEqual(before);
    } finally {
      await dropDatabase("cic_case2");
    }
  });

  it("aborts when an index of that name has a different definition, dropping nothing", async () => {
    const conn = await createEmptyDatabase("cic_case3");
    try {
      const d = await dir({ "0001_scratch.sql": SCRATCH });
      await migrate(conn.owner, d);
      await withOwner(conn.owner, (c) => c.query("create index scratch_id on dastar.scratch using btree (x)"));
      const before = await indexState(conn.owner, "scratch_id");
      await writeFile(join(d, "0002_idx.sql"), CIC_ID);
      await expect(migrate(conn.owner, d)).rejects.toThrow(/different definition/);
      expect(await indexState(conn.owner, "scratch_id")).toEqual(before);
      expect(await recorded(conn.owner, "0002_idx.sql")).toBe(false);
    } finally {
      await dropDatabase("cic_case3");
    }
  });

  it("refuses a nontransactional file with more than one statement before touching the database", async () => {
    const conn = await createEmptyDatabase("cic_case4");
    try {
      const d = await dir({ "0001_scratch.sql": SCRATCH });
      await migrate(conn.owner, d);
      await writeFile(join(d, "0002_two.sql"), HEAD_CIC + "create index concurrently if not exists scratch_id on dastar.scratch using btree (id);\ncreate index concurrently if not exists scratch_x on dastar.scratch using btree (x);\n");
      await expect(migrate(conn.owner, d)).rejects.toThrow(/exactly one statement/);
      expect(await indexState(conn.owner, "scratch_id")).toBeNull();
      expect(await indexState(conn.owner, "scratch_x")).toBeNull();
      expect(await recorded(conn.owner, "0002_two.sql")).toBe(false);
    } finally {
      await dropDatabase("cic_case4");
    }
  });

  it("retries on lock timeout and succeeds once the blocker releases", async () => {
    const conn = await createEmptyDatabase("cic_case5");
    try {
      const d = await dir({ "0001_scratch.sql": SCRATCH });
      await migrate(conn.owner, d);
      const blocker = new Client({ connectionString: conn.owner });
      await blocker.connect();
      await blocker.query("begin");
      await blocker.query("lock table dastar.scratch in share mode");
      await writeFile(join(d, "0002_idx.sql"), CIC_ID);
      const attempts: number[] = [];
      const r = await migrate(conn.owner, d, {
        lockTimeout: "200ms",
        maxAttempts: 5,
        onAttempt: (_file, attempt) => { attempts.push(attempt); if (attempt === 2) void blocker.query("rollback"); },
      });
      expect(r.applied).toEqual(["0002_idx.sql"]);
      expect(attempts.length).toBeGreaterThanOrEqual(2);
      expect((await indexState(conn.owner, "scratch_id"))?.valid).toBe(true);
      await blocker.end();
    } finally {
      await dropDatabase("cic_case5");
    }
  });
});

import { describe, it, expect } from "vitest";
import { Client } from "pg";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/migrate.js";
import { createEmptyDatabase, dropDatabase } from "./helpers/db.js";

describe("migration runner", () => {
  it("applies files in order, records checksums, and is idempotent", async () => {
    const conn = await createEmptyDatabase("migrate_case1");
    try {
      const dir = await mkdtemp(join(tmpdir(), "dastar-mig-"));
      await writeFile(join(dir, "0001_a.sql"), "-- transaction: yes\n-- impact: instant-exclusive\ncreate table dastar.t_a(id int);\n");
      await writeFile(join(dir, "0002_b.sql"), "-- transaction: yes\n-- impact: instant-exclusive\ncreate table dastar.t_b(id int);\n");
      const first = await migrate(conn.owner, dir);
      expect(first.applied).toEqual(["0001_a.sql", "0002_b.sql"]);
      const second = await migrate(conn.owner, dir);
      expect(second.applied).toEqual([]);
      const c = new Client({ connectionString: conn.owner });
      await c.connect();
      const rows = await c.query("select version, name from dastar.schema_migration order by version");
      expect(rows.rows.map((r) => r.name)).toEqual(["0001_a.sql", "0002_b.sql"]);
      await c.end();
    } finally {
      await dropDatabase("migrate_case1");
    }
  });

  it("refuses a modified already-applied file", async () => {
    const conn = await createEmptyDatabase("migrate_case2");
    try {
      const dir = await mkdtemp(join(tmpdir(), "dastar-mig-"));
      const p = join(dir, "0001_a.sql");
      await writeFile(p, "-- transaction: yes\n-- impact: instant-exclusive\ncreate table dastar.t_c(id int);\n");
      await migrate(conn.owner, dir);
      await writeFile(p, "-- transaction: yes\n-- impact: instant-exclusive\ncreate table dastar.t_c(id int, x int);\n");
      await expect(migrate(conn.owner, dir)).rejects.toThrow(/checksum mismatch/);
    } finally {
      await dropDatabase("migrate_case2");
    }
  });

  it("runs a non-transactional file outside a transaction", async () => {
    const conn = await createEmptyDatabase("migrate_case3");
    try {
      const dir = await mkdtemp(join(tmpdir(), "dastar-mig-"));
      await writeFile(join(dir, "0001_t.sql"), "-- transaction: yes\n-- impact: instant-exclusive\ncreate table dastar.t_d(id int);\n");
      await writeFile(join(dir, "0002_idx.sql"), "-- transaction: no\n-- impact: long-nonblocking\ncreate index concurrently t_d_idx on dastar.t_d(id);\n");
      const r = await migrate(conn.owner, dir);
      expect(r.applied).toEqual(["0001_t.sql", "0002_idx.sql"]);
    } finally {
      await dropDatabase("migrate_case3");
    }
  });

  it("refuses a blocking file unless allowed", async () => {
    const conn = await createEmptyDatabase("migrate_case4");
    try {
      const dir = await mkdtemp(join(tmpdir(), "dastar-mig-"));
      await writeFile(join(dir, "0001_blk.sql"), "-- transaction: yes\n-- impact: long-blocks-all\ncreate table dastar.t_e(id int);\n");
      await expect(migrate(conn.owner, dir)).rejects.toThrow(/maintenance window/);
      const r = await migrate(conn.owner, dir, { allowBlocking: true });
      expect(r.applied).toEqual(["0001_blk.sql"]);
    } finally {
      await dropDatabase("migrate_case4");
    }
  });
});

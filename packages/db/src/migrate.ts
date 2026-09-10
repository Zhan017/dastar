import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

export type Impact = "instant-exclusive" | "long-nonblocking" | "long-blocks-writes" | "long-blocks-all";
type Header = { transaction: boolean; impact: Impact };

const RUN_LOCK_KEY = 7411;
const LOCK_TIMEOUT = "3s";
const MAX_ATTEMPTS = 5;

function parseHeader(name: string, sql: string): Header {
  const tx = /^--\s*transaction:\s*(yes|no)\s*$/m.exec(sql);
  const im = /^--\s*impact:\s*(instant-exclusive|long-nonblocking|long-blocks-writes|long-blocks-all)\s*$/m.exec(sql);
  if (!tx || !im) throw new Error(`${name}: missing "-- transaction:" or "-- impact:" header`);
  return { transaction: tx[1] === "yes", impact: im[1] as Impact };
}

export async function migrate(
  ownerConnectionString: string,
  migrationsDir: string,
  opts: { allowBlocking?: boolean } = {},
): Promise<{ applied: string[] }> {
  const client = new Client({ connectionString: ownerConnectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("select pg_advisory_lock($1)", [RUN_LOCK_KEY]);
    await client.query("create schema if not exists dastar");
    await client.query(
      `create table if not exists dastar.schema_migration (
         version int primary key,
         name text not null,
         checksum bytea not null,
         applied_at timestamptz not null default now())`,
    );
    const files = (await readdir(migrationsDir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    const done = new Map<number, Buffer>();
    for (const r of (await client.query("select version, checksum from dastar.schema_migration")).rows) {
      done.set(r.version as number, r.checksum as Buffer);
    }
    for (const file of files) {
      const version = Number(file.slice(0, 4));
      const sql = await readFile(join(migrationsDir, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest();
      const prev = done.get(version);
      if (prev) {
        if (!prev.equals(checksum)) throw new Error(`checksum mismatch for applied migration ${file}`);
        continue;
      }
      const header = parseHeader(file, sql);
      if ((header.impact === "long-blocks-writes" || header.impact === "long-blocks-all") && !opts.allowBlocking) {
        throw new Error(`${file}: impact ${header.impact} requires a maintenance window; pass allowBlocking`);
      }
      await applyWithRetry(client, file, sql, header, version, checksum);
      applied.push(file);
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [RUN_LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
  return { applied };
}

async function applyWithRetry(client: Client, file: string, sql: string, header: Header, version: number, checksum: Buffer): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      if (header.transaction) {
        await client.query("begin");
        await client.query(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
        await client.query(sql);
        await client.query("insert into dastar.schema_migration(version, name, checksum) values ($1, $2, $3)", [version, file, checksum]);
        await client.query("commit");
      } else {
        await client.query(`set lock_timeout = '${LOCK_TIMEOUT}'`);
        await client.query(sql);
        await client.query("reset lock_timeout");
        await client.query("insert into dastar.schema_migration(version, name, checksum) values ($1, $2, $3)", [version, file, checksum]);
      }
      return;
    } catch (e: unknown) {
      if (header.transaction) await client.query("rollback").catch(() => undefined);
      const code = (e as { code?: string }).code;
      if (code === "55P03" && attempt < MAX_ATTEMPTS) continue;
      throw e;
    }
  }
}

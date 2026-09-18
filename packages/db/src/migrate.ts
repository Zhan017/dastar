import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

export type Impact = "instant-exclusive" | "long-nonblocking" | "long-blocks-writes" | "long-blocks-all";
type Header = { transaction: boolean; impact: Impact };

export type MigrateOptions = {
  allowBlocking?: boolean;
  /** Postgres interval literal for lock_timeout, such as "3s" or "200ms". Default "3s". */
  lockTimeout?: string;
  /** Total attempts per file when a lock timeout (55P03) occurs. Default 5. */
  maxAttempts?: number;
  /** Observes every attempt of every file. */
  onAttempt?: (file: string, attempt: number) => void;
};

export type ConcurrentIndexStatement =
  | { op: "create"; schema: string; name: string; table: string; normalized: string }
  | { op: "drop"; schema: string; name: string };

const RUN_LOCK_KEY = 7411;
const LOCK_TIMEOUT_RE = /^(?!0+(ms|s|min)$)\d+(ms|s|min)$/;
const IDENT = "[a-z_][a-z0-9_]*";
const CREATE_RE = new RegExp(`^create (?:unique )?index concurrently if not exists (${IDENT}) on (${IDENT})\\.(${IDENT}) using ${IDENT} \\(.+\\)$`);
const DROP_RE = new RegExp(`^drop index concurrently if exists (${IDENT})\\.(${IDENT})$`);

function parseHeader(name: string, sql: string): Header {
  const tx = /^--\s*transaction:\s*(yes|no)\s*$/m.exec(sql);
  const im = /^--\s*impact:\s*(instant-exclusive|long-nonblocking|long-blocks-writes|long-blocks-all)\s*$/m.exec(sql);
  if (!tx || !im) throw new Error(`${name}: missing "-- transaction:" or "-- impact:" header`);
  return { transaction: tx[1] === "yes", impact: im[1] as Impact };
}

/** Index just past the closing quote of the quoted run that starts at `start`; a doubled quote is an escape. */
function endOfQuoted(sql: string, start: number, quote: "'" | '"', what: string): number {
  let j = start + 1;
  for (;;) {
    if (j >= sql.length) throw new Error(`unterminated ${what} in a migration statement`);
    if (sql[j] === quote) {
      if (sql[j + 1] === quote) { j += 2; continue; }
      return j + 1;
    }
    j += 1;
  }
}

/**
 * Lowercases, collapses whitespace, and strips line and block comments outside quoted text; keeps every
 * single-quoted literal and every double-quoted identifier verbatim (case, spaces, doubled-quote escapes);
 * drops one trailing semicolon. A quoted identifier that Postgres would print unquoted therefore compares
 * unequal to the canonical spelling and is refused as a different definition, never accepted as the same.
 */
export function normalizeSql(sql: string): string {
  let out = "";
  let space = false;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "'" || ch === '"') {
      const end = endOfQuoted(sql, i, ch, ch === "'" ? "string literal" : "quoted identifier");
      out += sql.slice(i, end);
      space = false;
      i = end;
    } else if (ch === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i += 1;
      if (!space) { out += " "; space = true; }
    } else if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      if (!space) { out += " "; space = true; }
    } else if (/\s/.test(ch)) {
      if (!space) { out += " "; space = true; }
      i += 1;
    } else {
      out += ch.toLowerCase();
      space = false;
      i += 1;
    }
  }
  return out.trim().replace(/;$/, "").trim();
}

/**
 * A "transaction: no" file must be exactly one concurrent index statement in the spelling
 * pg_get_indexdef produces (schema-qualified table, explicit "using <method>"), because the runner
 * compares the file with the definition of any index that already exists under that name.
 */
export function parseConcurrentIndex(file: string, sql: string): ConcurrentIndexStatement {
  const body = normalizeSql(sql);
  if (body.includes(";")) throw new Error(`${file}: a "transaction: no" file must contain exactly one statement, and its literals may not contain semicolons`);
  const c = CREATE_RE.exec(body);
  if (c) {
    return { op: "create", name: c[1]!, schema: c[2]!, table: c[3]!, normalized: body.replace("index concurrently if not exists", "index") };
  }
  const d = DROP_RE.exec(body);
  if (d) return { op: "drop", schema: d[1]!, name: d[2]! };
  throw new Error(
    `${file}: a "transaction: no" file must be one "create [unique] index concurrently if not exists <name> on <schema>.<table> using <method> (...)" or "drop index concurrently if exists <schema>.<name>" statement`,
  );
}

export async function migrate(
  ownerConnectionString: string,
  migrationsDir: string,
  opts: MigrateOptions = {},
): Promise<{ applied: string[] }> {
  const lockTimeout = opts.lockTimeout ?? "3s";
  const maxAttempts = opts.maxAttempts ?? 5;
  if (!LOCK_TIMEOUT_RE.test(lockTimeout)) throw new Error(`lockTimeout must be a non-zero value like "3s" or "200ms", got "${lockTimeout}"`);
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
      await applyWithRetry(client, file, sql, header, version, checksum, { lockTimeout, maxAttempts, onAttempt: opts.onAttempt });
      applied.push(file);
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [RUN_LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
  return { applied };
}

type Attempt = { lockTimeout: string; maxAttempts: number; onAttempt: MigrateOptions["onAttempt"] };

async function applyWithRetry(client: Client, file: string, sql: string, header: Header, version: number, checksum: Buffer, a: Attempt): Promise<void> {
  // refused before any statement for this file reaches the database
  const concurrent = header.transaction ? null : parseConcurrentIndex(file, sql);
  for (let attempt = 1; ; attempt++) {
    a.onAttempt?.(file, attempt);
    try {
      if (concurrent === null) {
        await client.query("begin");
        await client.query(`set local lock_timeout = '${a.lockTimeout}'`);
        await client.query(sql);
        await record(client, version, file, checksum);
        await client.query("commit");
      } else {
        await applyConcurrent(client, file, sql, concurrent, version, checksum, a.lockTimeout);
      }
      return;
    } catch (e: unknown) {
      if (concurrent === null) await client.query("rollback").catch(() => undefined);
      const code = (e as { code?: string }).code;
      if (code === "55P03" && attempt < a.maxAttempts) continue;
      throw e;
    }
  }
}

type Relation = { relkind: string; table: string | null; definition: string | null; valid: boolean; ready: boolean };

async function findRelation(client: Client, schema: string, name: string): Promise<Relation | null> {
  const r = await client.query(
    `select c.relkind, t.relname as table_name, i.indisvalid, i.indisready,
            case when c.relkind = 'i' then pg_get_indexdef(c.oid) end as definition
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       left join pg_index i on i.indexrelid = c.oid
       left join pg_class t on t.oid = i.indrelid
      where n.nspname = $1 and c.relname = $2`,
    [schema, name],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  return { relkind: row.relkind, table: row.table_name ?? null, definition: row.definition ?? null, valid: row.indisvalid === true, ready: row.indisready === true };
}

/**
 * Existing object under the statement's name decides the action:
 *   none                                            apply
 *   same table, same definition, valid and ready    already applied: record the checksum only
 *   same table, same definition, not valid          drop the leftover concurrently, then apply
 *   anything else                                   abort; nothing is dropped
 */
async function applyConcurrent(client: Client, file: string, sql: string, stmt: ConcurrentIndexStatement, version: number, checksum: Buffer, lockTimeout: string): Promise<void> {
  const existing = await findRelation(client, stmt.schema, stmt.name);
  if (stmt.op === "create") {
    if (existing) {
      if (existing.relkind !== "i") {
        throw new Error(`${file}: ${stmt.schema}.${stmt.name} exists and is not an index (relkind ${existing.relkind}); the file would create it on ${stmt.table} as: ${stmt.normalized}; manual repair required`);
      }
      const same = existing.table === stmt.table && existing.definition !== null && normalizeSql(existing.definition) === stmt.normalized;
      if (!same) {
        throw new Error(
          `${file}: index ${stmt.schema}.${stmt.name} exists with a different definition; manual repair required\n  existing: ${existing.definition ?? "?"} on ${existing.table ?? "?"}\n  file:     ${stmt.normalized}`,
        );
      }
      if (existing.valid && existing.ready) {
        await record(client, version, file, checksum);
        return;
      }
      await withLockTimeout(client, lockTimeout, `drop index concurrently if exists ${stmt.schema}.${stmt.name}`);
    }
    await withLockTimeout(client, lockTimeout, sql);
  } else {
    if (!existing) {
      await record(client, version, file, checksum);
      return;
    }
    if (existing.relkind !== "i") {
      throw new Error(`${file}: ${stmt.schema}.${stmt.name} exists and is not an index (relkind ${existing.relkind}); the file would drop index ${stmt.schema}.${stmt.name}; manual repair required`);
    }
    await withLockTimeout(client, lockTimeout, sql);
  }
  await record(client, version, file, checksum);
}

async function withLockTimeout(client: Client, lockTimeout: string, sql: string): Promise<void> {
  await client.query(`set lock_timeout = '${lockTimeout}'`);
  try {
    await client.query(sql);
  } finally {
    await client.query("reset lock_timeout").catch(() => undefined);
  }
}

async function record(client: Client, version: number, file: string, checksum: Buffer): Promise<void> {
  await client.query("insert into dastar.schema_migration(version, name, checksum) values ($1, $2, $3)", [version, file, checksum]);
}

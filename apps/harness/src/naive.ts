import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { migrate } from "@dastar/db";
import { seedBench } from "./seed.js";
import { overlapPairs } from "./race.js";

export type NaiveResult = { n: number; committed: number; overlaps: number };

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** Only databases this harness created are ever dropped; the name pattern is the guard. */
export const NAIVE_DB_RE = /^dastar_naive_[0-9a-f]{8}$/;

export function naiveDatabaseName(): string {
  return `dastar_naive_${randomBytes(4).toString("hex")}`;
}

/** Creates and migrates a throwaway database under a fresh generated name; refuses a name that already exists. */
export async function createThrowawayDatabase(adminUrl: string, name: string, migrationsDir: string): Promise<string> {
  if (!NAIVE_DB_RE.test(name)) throw new Error(`naive: refusing to create ${name}; the name must match ${NAIVE_DB_RE}`);
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const exists = await admin.query("select 1 from pg_database where datname = $1", [name]);
    if (exists.rowCount !== 0) throw new Error(`naive: database ${name} already exists; refusing to touch it`);
    await admin.query(`create database "${name}"`);
  } finally {
    await admin.end();
  }
  const url = withDatabase(adminUrl, name);
  await migrate(url, migrationsDir);
  return url;
}

export async function prepareNaiveDatabase(adminUrl: string, migrationsDir: string): Promise<{ name: string; url: string }> {
  const name = naiveDatabaseName();
  return { name, url: await createThrowawayDatabase(adminUrl, name, migrationsDir) };
}

export async function dropNaiveDatabase(adminUrl: string, name: string): Promise<void> {
  if (!NAIVE_DB_RE.test(name)) throw new Error(`naive: refusing to drop ${name}; only databases named like ${NAIVE_DB_RE} are dropped`);
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`drop database if exists "${name}" with (force)`);
  } finally {
    await admin.end();
  }
}

/** Removes the two protections a plain application would not have: the exclusion constraint and the unit locks taken by the fit trigger. */
export async function disableProtections(ownerUrl: string): Promise<void> {
  const owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  await owner.query("alter table dastar.reservation_unit drop constraint reservation_unit_no_overlap");
  await owner.query("alter table dastar.reservation disable trigger t40_fit");
  await owner.end();
}

/**
 * What a plain check-then-insert does. Every worker opens a transaction and counts active overlapping unit
 * rows; only when all N have seen zero does any of them insert. The barrier makes the double booking
 * deterministic instead of depending on scheduling.
 */
export async function runNaive(ownerUrl: string, n: number): Promise<NaiveResult> {
  const owner = new Client({ connectionString: ownerUrl });
  await owner.connect();
  const seed = await seedBench(owner, { units: 1, combos: 0 });
  const unit = seed.units[0]!;
  const during = "[2045-01-01T19:00:00.000Z,2045-01-01T20:30:00.000Z)";
  const clients = await Promise.all(Array.from({ length: n }, async () => {
    const c = new Client({ connectionString: ownerUrl });
    await c.connect();
    return c;
  }));
  try {
    const counts = await Promise.all(clients.map(async (c, k) => {
      await c.query("begin");
      await c.query("select set_config('dastar.actor', $1, true), set_config('dastar.trace_id', $1, true)", [`naive:${k}`]);
      const r = await c.query(
        "select count(*)::int as n from dastar.reservation_unit where unit_id = $1 and active and during && $2::tstzrange",
        [unit, during],
      );
      return r.rows[0].n as number;
    }));
    if (counts.some((x) => x !== 0)) throw new Error("naive: the slot was not free before the run");
    // barrier passed: every worker believes the slot is free
    let committed = 0;
    await Promise.all(clients.map(async (c, k) => {
      try {
        const id = (await c.query(
          `insert into dastar.reservation (venue_id, party_size, during, status, assignment_kind, assignment_id, hold_expires_at, created_by)
           values ($1, 2, $2::tstzrange, 'held', 'unit', $3, dastar.dastar_now() + interval '10 minutes', $4) returning id`,
          [seed.venue, during, unit, `naive:${k}`],
        )).rows[0].id as string;
        await c.query("insert into dastar.reservation_unit (venue_id, reservation_id, unit_id, during) values ($1, $2, $3, $4::tstzrange)", [seed.venue, id, unit, during]);
        await c.query("commit");
        committed += 1;
      } catch {
        await c.query("rollback").catch(() => undefined);
      }
    }));
    return { n, committed, overlaps: await overlapPairs(owner) };
  } finally {
    await Promise.all(clients.map((c) => c.end()));
    await owner.end();
  }
}

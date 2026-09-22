import { Client, Pool } from "pg";
import { listen } from "@dastar/api/server";
import { createKey } from "@dastar/api/auth";
import { seedBench, type BenchSeed } from "./seed.js";
import { advisoryLocks, backends, waitFor } from "./observe.js";

const API_APPLICATION = "dastar-api";

export type ExhaustOptions = {
  ownerUrl: string;
  /** Application-role connection string: the blocker connects with it, and so does an API started here. */
  appUrl: string;
  /** An API that is already running. Without it the run starts one in this process on a free port. */
  external?: { url: string; key: string };
  /** Pool size and timeouts of the API under test. They configure an API started here and set the expectations either way. */
  poolMax?: number; acquireMs?: number; deadlineMs?: number;
};

export type Check = { name: string; pass: boolean; detail: string };
export type Answer = { key: string; status: number; code: string | null; replayed: boolean | null; retryAfter: string | null; ms: number };
export type VariantReport = {
  variant: "release_before_statement_timeout" | "blocker_past_statement_timeout";
  barrierMs: number;
  /** From the blocker's release to the last queued answer: sixteen transactions on one unit run one after another. */
  drainMs: number | null;
  wave1: Answer[]; wave2: Answer[]; replays: Answer[];
  checks: Check[];
};
export type ExhaustReport = {
  command: "exhaust"; poolMax: number; acquireMs: number; statementTimeoutMs: number; startedApi: boolean;
  variants: VariantReport[]; pass: boolean;
};

export type Api = { url: string; key: string; /** For headers and body together; past it the answer is status 0 with a transport code. */ deadlineMs: number };
export type Planned = { key: string; unit: string; startsAt: string };

/** A parsed JSON object. `null` when the server answered but the body was not one: empty, HTML, a JSON literal, an array. */
type Body = Record<string, unknown>;
const parseObject = (text: string): Body | null => {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Body) : null;
  } catch {
    return null;
  }
};

/**
 * One hold over HTTP. A response that does not arrive in full within the deadline is an answer with status 0
 * and code `transport_timeout` (or `transport_error`), so a stalled API fails checks with evidence instead
 * of hanging the run. Such an answer says nothing about what the database did; the checks read that from
 * the database. A status that claims success with a body that does not carry it, or a 201 whose receipt has
 * no reservation id, is `malformed_response`: an answer no healthy run produces.
 */
export async function postHold(api: Api, venue: string, p: Planned): Promise<Answer> {
  const t0 = performance.now();
  const signal = AbortSignal.timeout(api.deadlineMs);
  let res: Response;
  try {
    res = await fetch(`${api.url}/v1/venues/${venue}/holds`, {
      method: "POST", signal,
      headers: { authorization: `Bearer ${api.key}`, "content-type": "application/json", "idempotency-key": p.key },
      body: JSON.stringify({ party_size: 2, starts_at: p.startsAt, duration_minutes: 90, assignment: { kind: "unit", id: p.unit } }),
    });
  } catch {
    return { key: p.key, status: 0, code: signal.aborted ? "transport_timeout" : "transport_error", replayed: null, retryAfter: null, ms: performance.now() - t0 };
  }
  // reading the whole body is part of getting an answer: a connection that breaks or a deadline that fires here is a transport failure
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { key: p.key, status: 0, code: signal.aborted ? "transport_timeout" : "transport_error", replayed: null, retryAfter: null, ms: performance.now() - t0 };
  }
  const retryAfter = res.headers.get("retry-after");
  const body = parseObject(text);
  if (body === null) return { key: p.key, status: res.status, code: "malformed_response", replayed: null, retryAfter, ms: performance.now() - t0 };
  const receipt = body.receipt;
  const hasReservationId = receipt !== null && typeof receipt === "object" && !Array.isArray(receipt) && typeof (receipt as Record<string, unknown>).reservation_id === "string";
  if (res.status === 201 && !hasReservationId) {
    return { key: p.key, status: res.status, code: "malformed_response", replayed: null, retryAfter, ms: performance.now() - t0 };
  }
  return {
    key: p.key, status: res.status, code: typeof body.code === "string" ? body.code : null,
    replayed: typeof body.replayed === "boolean" ? body.replayed : null, retryAfter, ms: performance.now() - t0,
  };
}

/** Both variants ran, each made checks, and every check passed. An empty list passes nothing. */
export const exhaustPassed = (variants: readonly Pick<VariantReport, "checks">[]): boolean =>
  variants.length === 2 && variants.every((v) => v.checks.length > 0 && v.checks.every((c) => c.pass));

const count = (xs: Answer[], status: number, code: string | null): number => xs.filter((a) => a.status === status && a.code === code).length;

async function runVariant(
  variant: VariantReport["variant"], owner: Client, appUrl: string, api: Api, seed: BenchSeed,
  cfg: { poolMax: number; acquireMs: number; statementTimeoutMs: number },
): Promise<VariantReport> {
  const checks: Check[] = [];
  const check = (name: string, pass: boolean, detail: string): void => { checks.push({ name, pass, detail }); };
  const u1 = seed.units[0]!;
  const u2 = seed.units[1]!;
  const tag = variant === "release_before_statement_timeout" ? "rel" : "sto";
  const shared = new Date(Date.UTC(2049, 0, 1, 19)).toISOString();
  const half = Math.floor(cfg.poolMax / 2);
  // wave 1 fills the pool: half ask for one shared slot, the rest for a day of their own, all on unit 1
  const wave1Plan: Planned[] = Array.from({ length: cfg.poolMax }, (_, i) => ({
    key: `${tag}-w1-${i}`, unit: u1, startsAt: i < half ? shared : new Date(Date.UTC(2049, 1, 1 + i, 19)).toISOString(),
  }));
  // wave 2 arrives when no connection is free: four more for unit 1 and one for a unit nobody is using
  const wave2Plan: Planned[] = [
    ...Array.from({ length: 4 }, (_, i) => ({ key: `${tag}-w2-${i}`, unit: u1, startsAt: shared })),
    { key: `${tag}-w2-other`, unit: u2, startsAt: shared },
  ];

  const blocker = new Client({ connectionString: appUrl, application_name: "dastar-exhaust-blocker" });
  blocker.on("error", () => undefined);
  await blocker.connect();
  await blocker.query("begin");
  await blocker.query("select pg_advisory_xact_lock(dastar.unit_lock_key($1::uuid))", [u1]);
  let drainMs: number | null = null;
  let wave1: Answer[] = [];
  let wave2: Answer[] = [];
  let barrierMs = 0;
  try {
    const t0 = performance.now();
    const pending1 = Promise.all(wave1Plan.map((p) => postHold(api, seed.venue, p)));
    // the barrier is observed in the database: every API backend is waiting for the unit's advisory lock
    await waitFor(async () => (await backends(owner, API_APPLICATION)).filter((b) => b.waitType === "Lock" && b.waitEvent === "advisory").length === cfg.poolMax,
      15_000, `${cfg.poolMax} API backends waiting on the advisory lock`);
    barrierMs = performance.now() - t0;
    wave2 = await Promise.all(wave2Plan.map((p) => postHold(api, seed.venue, p)));
    check("wave 2: every request is refused with 503 pool_timeout and Retry-After, including the unrelated unit",
      count(wave2, 503, "pool_timeout") === wave2.length && wave2.every((a) => a.retryAfter === "1"), JSON.stringify(wave2.map((a) => [a.key, a.status, a.code, a.retryAfter])));
    check("wave 2: the refusal arrives at the acquire timeout",
      wave2.every((a) => a.ms >= cfg.acquireMs - 100 && a.ms <= cfg.acquireMs + 2_000), `acquireMs=${cfg.acquireMs} observed=${wave2.map((a) => Math.round(a.ms)).join(",")}`);

    if (variant === "release_before_statement_timeout") {
      const released = performance.now();
      await blocker.query("rollback");
      wave1 = await pending1;
      drainMs = performance.now() - released;
      const sharedAnswers = wave1.slice(0, half);
      const ownDay = wave1.slice(half);
      check("wave 1, shared slot: one winner, the rest hold_conflict", count(sharedAnswers, 201, null) === 1 && count(sharedAnswers, 409, "hold_conflict") === half - 1, JSON.stringify(sharedAnswers.map((a) => [a.status, a.code])));
      check("wave 1, own day: every request wins", count(ownDay, 201, null) === ownDay.length, JSON.stringify(ownDay.map((a) => [a.status, a.code])));
    } else {
      wave1 = await pending1;
      check("wave 1: every queued request is cancelled by the statement timeout and answers 503 timeout",
        count(wave1, 503, "timeout") === wave1.length && wave1.every((a) => a.retryAfter === "1"), JSON.stringify(wave1.map((a) => [a.status, a.code])));
      check("wave 1: the answer arrives at the statement timeout",
        wave1.every((a) => a.ms >= cfg.statementTimeoutMs - 200 && a.ms <= cfg.statementTimeoutMs + 3_000), `statementTimeoutMs=${cfg.statementTimeoutMs} observed=${wave1.map((a) => Math.round(a.ms)).join(",")}`);
    }
  } finally {
    await blocker.query("rollback").catch(() => undefined);
    await blocker.end();
  }

  // the database, not the client, says what committed
  await waitFor(async () => (await backends(owner, API_APPLICATION)).every((b) => b.state === "idle"), 10_000, "every API backend idle").then(
    () => check("pool: every API backend is idle, none idle in transaction", true, ""),
    async () => check("pool: every API backend is idle, none idle in transaction", false, JSON.stringify(await backends(owner, API_APPLICATION))),
  );
  const locks = await advisoryLocks(owner, API_APPLICATION);
  check("locks: no advisory lock is held by an API backend", locks === 0, `held=${locks}`);
  const stored = await owner.query("select key, response is not null as has_response from dastar.idempotency where venue_id = $1", [seed.venue]);
  const storedKeys = new Set(stored.rows.map((r) => r.key as string));
  const reservations = (await owner.query("select count(*)::int as n from dastar.reservation where venue_id = $1", [seed.venue])).rows[0].n as number;
  const committed = wave1.filter((a) => a.status === 201 || a.code === "hold_conflict");
  check("idempotency: exactly the committed outcomes have a row, each with its stored response",
    storedKeys.size === committed.length && committed.every((a) => storedKeys.has(a.key)) && stored.rows.every((r) => r.has_response === true),
    `rows=${storedKeys.size} committed=${committed.length}`);
  check("idempotency: a request that never got a connection left no row", wave2.every((a) => !storedKeys.has(a.key)), "");
  check("reservations: one per winner and nothing else", reservations === count(wave1, 201, null), `reservations=${reservations} winners=${count(wave1, 201, null)}`);

  // a retry replays a stored outcome and executes fresh where nothing was committed
  const replays: Answer[] = [];
  for (const p of [...wave1Plan, ...wave2Plan]) replays.push(await postHold(api, seed.venue, p));
  const before = new Map([...wave1, ...wave2].map((a) => [a.key, a]));
  const replayOk = replays.every((a) => {
    const first = before.get(a.key)!;
    if (storedKeys.has(a.key)) return a.status === first.status && a.code === first.code && a.replayed === true;
    return a.replayed === false && (a.status === 201 || a.code === "hold_conflict");
  });
  check("retry: a committed outcome is replayed with its status, an uncommitted request executes fresh", replayOk, JSON.stringify(replays.map((a) => [a.key, a.status, a.code, a.replayed])));
  if (variant === "blocker_past_statement_timeout") {
    const again = replays.slice(0, cfg.poolMax);
    check("retry after the timeout: the shared slot has one winner, every own-day request wins",
      count(again.slice(0, half), 201, null) === 1 && count(again.slice(half), 201, null) === cfg.poolMax - half, JSON.stringify(again.map((a) => [a.status, a.code])));
  }
  return { variant, barrierMs, drainMs, wave1, wave2, replays, checks };
}

/**
 * Controlled pool exhaustion and recovery over HTTP (system design, section 15.1). A connection holds one
 * unit's advisory lock; requests for that unit fill the API's pool; further requests, including one for an
 * unrelated unit, must be refused at the acquire timeout. One variant releases the blocker before the
 * statement timeout and checks recovery; the other holds it past the timeout and checks that the queued
 * transactions are cancelled and leave nothing behind.
 */
export async function runExhaust(opts: ExhaustOptions): Promise<ExhaustReport> {
  const poolMax = opts.poolMax ?? 16;
  const acquireMs = opts.acquireMs ?? 5_000;
  const owner = new Client({ connectionString: opts.ownerUrl });
  owner.on("error", () => undefined);
  await owner.connect();
  const probe = new Client({ connectionString: opts.appUrl });
  probe.on("error", () => undefined);
  await probe.connect();
  const setting = async (name: string): Promise<number> => Number((await probe.query("select setting from pg_settings where name = $1", [name])).rows[0].setting);
  const statementTimeoutMs = await setting("statement_timeout");
  const idleInTransactionMs = await setting("idle_in_transaction_session_timeout");
  await probe.end();
  if (statementTimeoutMs === 0 || acquireMs + 1_500 >= statementTimeoutMs) {
    await owner.end();
    throw new Error(`exhaust: the acquire timeout (${acquireMs}ms) must be at least 1.5 s under the application role's statement timeout (${statementTimeoutMs}ms)`);
  }
  if (idleInTransactionMs !== 0 && idleInTransactionMs < acquireMs + statementTimeoutMs + 5_000) {
    await owner.end();
    throw new Error(`exhaust: the blocker sits idle in a transaction through the barrier, the acquire timeout and the statement timeout, so idle_in_transaction_session_timeout (${idleInTransactionMs}ms) must exceed their sum by 5 s`);
  }
  let started: Awaited<ReturnType<typeof listen>> | null = null;
  let keyPool: Pool | null = null;
  // every answer this run waits for arrives by the statement timeout plus the handle's grace; twice that, and never under 30 s
  const deadlineMs = Math.max(30_000, statementTimeoutMs * 2 + 10_000);
  try {
    let api: Api;
    if (opts.external) {
      api = { ...opts.external, deadlineMs };
    } else {
      started = await listen({
        DATABASE_URL: opts.appUrl, HOST: "127.0.0.1", PORT: 0, POOL_MAX: poolMax, POOL_ACQUIRE_MS: acquireMs, READ_TIMEOUT_MS: 2_000,
        REQUEST_DEADLINE_MS: opts.deadlineMs ?? statementTimeoutMs + 2_000,
      }, { log: () => undefined });
      keyPool = new Pool({ connectionString: opts.appUrl, max: 1 });
      keyPool.on("error", () => undefined);
      api = { url: started.url, key: (await createKey(keyPool, { label: "exhaust run", capabilities: ["hold"] })).key, deadlineMs };
      await keyPool.end();
      keyPool = null;
    }
    const variants: VariantReport[] = [];
    for (const v of ["release_before_statement_timeout", "blocker_past_statement_timeout"] as const) {
      const seed = await seedBench(owner, { units: 2, combos: 0 });
      variants.push(await runVariant(v, owner, opts.appUrl, api, seed, { poolMax, acquireMs, statementTimeoutMs }));
    }
    return { command: "exhaust", poolMax, acquireMs, statementTimeoutMs, startedApi: started !== null, variants, pass: exhaustPassed(variants) };
  } finally {
    if (keyPool) await keyPool.end().catch(() => undefined);
    if (started) await started.close().catch(() => undefined);
    await owner.end();
  }
}

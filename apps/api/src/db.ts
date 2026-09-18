import type { Pool, PoolClient } from "pg";
import { DastarError } from "@dastar/db";

async function acquire(pool: Pool, acquireMs: number): Promise<PoolClient> {
  const pending = pool.connect();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DastarError("pool_timeout", `no pooled connection within ${acquireMs}ms`, undefined, true)), acquireMs);
  });
  try {
    return await Promise.race([pending, timeout]);
  } catch (e) {
    // a connection that arrives after the timeout goes straight back to the pool
    pending.then((c) => c.release(), () => undefined);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export type ReadLimits = { acquireMs: number; readMs: number };

/** The limits for a read made on behalf of a request: key lookups and the confirm-token check. */
export function readLimits(deps: { acquireTimeoutMs?: number; readTimeoutMs?: number }): ReadLimits {
  return { acquireMs: deps.acquireTimeoutMs ?? 5_000, readMs: deps.readTimeoutMs ?? 2_000 };
}

/**
 * One short read outside the engine handle: a bounded wait for a connection, a deadline on the read itself,
 * an error listener while the client is checked out (pg-pool detaches its own), and exactly one release.
 * The database's statement timeout cannot bound a connection that has stopped answering, so a read past its
 * deadline discards the connection; so does a failed read or a connection that reported an error.
 */
export async function withClient<T>(pool: Pool, limits: ReadLimits, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await acquire(pool, limits.acquireMs);
  let connectionError: Error | null = null;
  const onError = (e: Error): void => { connectionError = e; };
  client.on("error", onError);
  let released = false;
  const finish = (err?: Error): void => {
    if (released) return;
    released = true;
    client.removeListener("error", onError);
    const fatal = err ?? connectionError;
    if (fatal) client.release(fatal); else client.release();
  };
  const work = fn(client).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"deadline">((res) => { timer = setTimeout(() => res("deadline"), limits.readMs); });
  const first = await Promise.race([work, deadline]);
  clearTimeout(timer);
  if (first === "deadline") {
    finish(new Error(`dastar: read did not answer within ${limits.readMs}ms; connection discarded`));
    throw new DastarError("timeout", `read exceeded ${limits.readMs}ms`, undefined, true);
  }
  if (!first.ok) {
    finish(first.e instanceof Error ? first.e : new Error(String(first.e)));
    throw first.e;
  }
  finish();
  return first.v;
}

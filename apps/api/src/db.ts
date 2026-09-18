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

/**
 * One short read outside the engine handle: a bounded wait for a connection, an error listener while it is
 * checked out (pg-pool detaches its own), and discard instead of return whenever the read failed or the
 * connection reported an error. The role's statement timeout bounds the read itself.
 */
export async function withClient<T>(pool: Pool, acquireMs: number, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await acquire(pool, acquireMs);
  let connectionError: Error | null = null;
  const onError = (e: Error): void => { connectionError = e; };
  client.on("error", onError);
  try {
    const out = await fn(client);
    client.removeListener("error", onError);
    if (connectionError) client.release(connectionError); else client.release();
    return out;
  } catch (e) {
    client.removeListener("error", onError);
    client.release(e instanceof Error ? e : new Error(String(e)));
    throw e;
  }
}

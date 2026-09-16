import { Client, type Pool, type PoolClient } from "pg";
import { DastarError, asDastarError } from "./errors.js";
import { hold, type HoldInput, type HoldHooks, type HoldOutcome, type Receipt } from "./commands/hold.js";
import { confirm, type ConfirmInput, type ConfirmHooks } from "./commands/confirm.js";
import { cancel, type CancelInput, type CancelHooks } from "./commands/cancel.js";
import { mintConfirmToken, type MintInput } from "./commands/mint-token.js";
import { getReservation, type ReservationView } from "./commands/get.js";
import { expireDue } from "./commands/expire.js";

export type DastarOptions = {
  /** Host-configured pool connected as dastar_app (commands) or dastar_worker (expireDue). */
  pool: Pool;
  /** How long a call waits for a pooled connection. Default 5000. */
  acquireTimeoutMs?: number;
  /** Wall-clock budget for one command; above the 10 s statement timeout on purpose. Default 12000. */
  deadlineMs?: number;
  /** After a cancel request, how long to wait for the command to settle before the connection is discarded. Default 2000. */
  cancelGraceMs?: number;
  /**
   * Dedicated connection used only for pg_cancel_backend, same role as the pool. Never a pool client,
   * because an exhausted pool must not block cancellation. Without it the handle tries a pool client for
   * 500 ms and otherwise discards the connection after the grace period.
   */
  cancellerConnectionString?: string;
};

export interface Dastar {
  hold(input: HoldInput, hooks?: HoldHooks): Promise<HoldOutcome>;
  confirm(input: ConfirmInput, hooks?: ConfirmHooks): Promise<Receipt>;
  cancel(input: CancelInput, hooks?: CancelHooks): Promise<Receipt>;
  mintConfirmToken(input: MintInput): Promise<{ token: string; version: number }>;
  getReservation(reservationId: string): Promise<ReservationView | null>;
  expireDue(opts?: { limit?: number }): Promise<{ expired: string[] }>;
  /** Closes the canceller connection. The pool belongs to the host and is left open. */
  close(): Promise<void>;
}

type Settled<T> = { ok: true; v: T } | { ok: false; e: unknown };

const pids = new WeakMap<PoolClient, number>();

/**
 * Connection contract:
 *  - every command runs on a client checked out here and is released only after it has settled;
 *  - on an error the handle probes the client with one `rollback`; a failed probe destroys the connection;
 *  - past the deadline the backend is cancelled, the command is given the grace period to settle, and a
 *    connection that still has not settled is discarded rather than returned.
 */
export function createDastar(opts: DastarOptions): Dastar {
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? 5_000;
  const deadlineMs = opts.deadlineMs ?? 12_000;
  const cancelGraceMs = opts.cancelGraceMs ?? 2_000;
  let canceller: Client | null = null;

  async function acquire(timeoutMs: number): Promise<PoolClient> {
    const pending = opts.pool.connect();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DastarError("pool_timeout", `no pooled connection within ${timeoutMs}ms`, undefined, true)), timeoutMs);
    });
    try {
      return await Promise.race([pending, timeout]);
    } catch (e) {
      // a connection that arrives after the timeout goes straight back to the pool
      pending.then((c) => c.release(), () => undefined);
      if (e instanceof DastarError) throw e;
      const message = e instanceof Error ? e.message : String(e);
      const isTimeout = /timeout/i.test(message);
      throw new DastarError(isTimeout ? "pool_timeout" : "internal", message, undefined, isTimeout);
    } finally {
      clearTimeout(timer);
    }
  }

  async function cancelBackend(pid: number): Promise<boolean> {
    if (opts.cancellerConnectionString) {
      try {
        if (!canceller) {
          const c = new Client({ connectionString: opts.cancellerConnectionString });
          await c.connect();
          c.on("error", () => { canceller = null; });
          canceller = c;
        }
        const r = await canceller.query("select pg_cancel_backend($1) as ok", [pid]);
        return r.rows[0].ok === true;
      } catch {
        if (canceller) { canceller.end().catch(() => undefined); canceller = null; }
        return false;
      }
    }
    const c = await acquire(500).catch(() => null);
    if (!c) return false;
    try {
      const r = await c.query("select pg_cancel_backend($1) as ok", [pid]);
      return r.rows[0].ok === true;
    } catch {
      return false;
    } finally {
      c.release();
    }
  }

  async function settle(client: PoolClient, r: Settled<unknown>, finish: (err?: Error) => void): Promise<void> {
    if (r.ok) { finish(); return; }
    try {
      await client.query("rollback");
      finish();
    } catch (probe) {
      finish(probe instanceof Error ? probe : new Error(String(probe)));
    }
  }

  async function run<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await acquire(acquireTimeoutMs);
    // pg-pool detaches its own 'error' listener while a client is checked out. A connection error that
    // arrives between statements (a terminated backend, a dropped socket) would otherwise be an unhandled
    // 'error' event and crash the process. Record it and discard the connection at release.
    let connectionError: Error | null = null;
    const onError = (e: Error): void => { connectionError = e; };
    client.on("error", onError);
    const finish = (err?: Error): void => {
      client.removeListener("error", onError);
      const fatal = err ?? connectionError;
      if (fatal) client.release(fatal); else client.release();
    };
    let pid = pids.get(client);
    if (pid === undefined) {
      try {
        pid = (await client.query("select pg_backend_pid() as pid")).rows[0].pid as number;
        pids.set(client, pid);
      } catch (e) {
        finish(e instanceof Error ? e : new Error(String(e)));
        throw asDastarError(e);
      }
    }
    const work: Promise<Settled<T>> = fn(client).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"deadline">((res) => { timer = setTimeout(() => res("deadline"), deadlineMs); });
    let result = await Promise.race([work, deadline]);
    clearTimeout(timer);
    if (result === "deadline") {
      await cancelBackend(pid);
      let graceTimer: NodeJS.Timeout | undefined;
      const grace = new Promise<"grace">((res) => { graceTimer = setTimeout(() => res("grace"), cancelGraceMs); });
      const second = await Promise.race([work, grace]);
      clearTimeout(graceTimer);
      if (second === "grace") {
        finish(new Error("dastar: command did not settle after cancellation; connection discarded"));
        throw new DastarError("timeout", `command exceeded ${deadlineMs}ms and did not settle within ${cancelGraceMs}ms after cancellation`, undefined, true);
      }
      result = second;
    }
    await settle(client, result, finish);
    if (result.ok) return result.v;
    throw asDastarError(result.e);
  }

  return {
    hold: (input, hooks) => run((c) => hold(c, input, hooks)),
    confirm: (input, hooks) => run((c) => confirm(c, input, hooks)),
    cancel: (input, hooks) => run((c) => cancel(c, input, hooks)),
    mintConfirmToken: (input) => run((c) => mintConfirmToken(c, input)),
    getReservation: (reservationId) => run((c) => getReservation(c, reservationId)),
    expireDue: (o) => run((c) => expireDue(c, o)),
    close: async () => {
      if (canceller) { await canceller.end().catch(() => undefined); canceller = null; }
    },
  };
}

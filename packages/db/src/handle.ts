import { Client, type Pool, type PoolClient } from "pg";
import { DastarError, asDastarError } from "./errors.js";
import { hold, type HoldInput, type HoldHooks, type HoldOutcome, type Receipt } from "./commands/hold.js";
import { confirm, type ConfirmInput, type ConfirmHooks } from "./commands/confirm.js";
import { cancel, type CancelInput, type CancelHooks } from "./commands/cancel.js";
import { mintConfirmToken, type MintInput } from "./commands/mint-token.js";
import { getReservation, type ReservationView } from "./commands/get.js";
import { expireDue } from "./commands/expire.js";

export type DastarOptions = {
  /**
   * Host-configured pool connected as dastar_app (commands) or dastar_worker (expireDue). Attach an `error`
   * listener to it: a client discarded by the handle can still emit a late error, which pg-pool re-emits on
   * the pool, and an unhandled pool error ends the process.
   */
  pool: Pool;
  /** How long a call waits for a pooled connection. Default 5000. */
  acquireTimeoutMs?: number;
  /** Wall-clock budget for one command; above the 10 s statement timeout on purpose. Default 12000. */
  deadlineMs?: number;
  /** Budget after the deadline for the cancel request and for the command to settle; the connection is discarded at its end either way. Default 2000. */
  cancelGraceMs?: number;
  /**
   * Dedicated connection used only for pg_cancel_backend, same role as the pool. Never a pool client,
   * because an exhausted pool must not block cancellation. Without it the handle borrows a pool client for
   * the cancel request, acquired within 500 ms and discarded if the request does not answer within the
   * grace period.
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
 *  - past the deadline the grace period starts at once, the backend is cancelled within it through a bounded
 *    request, and the connection is discarded whether or not the command settles, so a late cancel can never
 *    reach a backend serving another command;
 *  - a connection error recorded while the client was checked out discards the connection at release even
 *    when the command itself succeeded, and both the backend-pid lookup and the rollback probe are bounded
 *    by the deadline and the grace period respectively.
 */
export function createDastar(opts: DastarOptions): Dastar {
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? 5_000;
  const deadlineMs = opts.deadlineMs ?? 12_000;
  const cancelGraceMs = opts.cancelGraceMs ?? 2_000;
  let cancellerPromise: Promise<Client> | null = null;

  /** All callers share one canceller connection; the connecting promise is memoized so concurrent deadlines cannot open two. */
  function canceller(url: string): Promise<Client> {
    if (cancellerPromise) return cancellerPromise;
    let p: Promise<Client>;
    p = (async () => {
      const c = new Client({ connectionString: url, application_name: "dastar-canceller", connectionTimeoutMillis: cancelGraceMs, statement_timeout: cancelGraceMs });
      await c.connect();
      c.on("error", () => { if (cancellerPromise === p) cancellerPromise = null; });
      return c;
    })();
    cancellerPromise = p;
    p.catch(() => { if (cancellerPromise === p) cancellerPromise = null; });
    return p;
  }

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
      const p = canceller(opts.cancellerConnectionString);
      try {
        const c = await p;
        const r = await c.query("select pg_cancel_backend($1) as ok", [pid]);
        return r.rows[0].ok === true;
      } catch {
        if (cancellerPromise === p) cancellerPromise = null;
        p.then((c) => c.end().catch(() => undefined), () => undefined);
        return false;
      }
    }
    const c = await acquire(500).catch(() => null);
    if (!c) return false;
    // same hazard as the command's own client: no pool listener while checked out
    const onError = (): void => undefined;
    c.on("error", onError);
    let released = false;
    const finishFallback = (err?: Error): void => {
      if (released) return;
      released = true;
      c.removeListener("error", onError);
      if (err) c.release(err); else c.release();
    };
    const q = c.query("select pg_cancel_backend($1) as ok", [pid]).then(
      (r) => ({ ok: r.rows[0].ok === true }),
      (e: unknown) => ({ failed: e }),
    );
    let limitTimer: NodeJS.Timeout | undefined;
    const limit = new Promise<"timeout">((res) => { limitTimer = setTimeout(() => res("timeout"), cancelGraceMs); });
    const first = await Promise.race([q, limit]);
    clearTimeout(limitTimer);
    if (first === "timeout") {
      // the cancel request itself stalled: this connection's state is unknown, so it is discarded, never returned
      finishFallback(new Error(`dastar: cancel request did not answer within ${cancelGraceMs}ms; connection discarded`));
      return false;
    }
    if ("failed" in first) {
      finishFallback(first.failed instanceof Error ? first.failed : new Error(String(first.failed)));
      return false;
    }
    finishFallback();
    return first.ok;
  }

  async function settle(client: PoolClient, r: Settled<unknown>, finish: (err?: Error) => void): Promise<void> {
    if (r.ok) { finish(); return; }
    let probeTimer: NodeJS.Timeout | undefined;
    const probe = client.query("rollback").then(() => "ok" as const, (e: unknown) => ({ failed: e }));
    const limit = new Promise<"timeout">((res) => { probeTimer = setTimeout(() => res("timeout"), cancelGraceMs); });
    const outcome = await Promise.race([probe, limit]);
    clearTimeout(probeTimer);
    if (outcome === "ok") { finish(); return; }
    if (outcome === "timeout") {
      probe.then(() => undefined, () => undefined);
      finish(new Error(`dastar: rollback probe did not answer within ${cancelGraceMs}ms; connection discarded`));
      return;
    }
    const e = outcome.failed;
    finish(e instanceof Error ? e : new Error(String(e)));
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
    let pid: number | undefined = pids.get(client);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"deadline">((res) => { timer = setTimeout(() => res("deadline"), deadlineMs); });
    const work: Promise<Settled<T>> = (async () => {
      if (pid === undefined) {
        pid = (await client.query("select pg_backend_pid() as pid")).rows[0].pid as number;
        pids.set(client, pid);
      }
      return await fn(client);
    })().then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
    let result = await Promise.race([work, deadline]);
    clearTimeout(timer);
    if (result === "deadline") {
      // the cleanup budget starts now and covers both the cancel request and the wait for settlement;
      // the cancel request is never awaited beyond it
      let graceTimer: NodeJS.Timeout | undefined;
      const grace = new Promise<"grace">((res) => { graceTimer = setTimeout(() => res("grace"), cancelGraceMs); });
      if (pid !== undefined) void cancelBackend(pid).catch(() => false);
      const second = await Promise.race([work, grace]);
      clearTimeout(graceTimer);
      // a connection whose command passed its deadline is never returned to the pool: a cancel request
      // still in flight must not reach a backend that has been handed to another command
      if (second === "grace") {
        finish(new Error("dastar: command did not settle within the grace period after its deadline; connection discarded"));
        throw new DastarError("timeout", `command exceeded ${deadlineMs}ms and did not settle within ${cancelGraceMs}ms`, undefined, true);
      }
      finish(new Error("dastar: command passed its deadline; connection discarded"));
      if (second.ok) return second.v;
      throw asDastarError(second.e);
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
      const p = cancellerPromise;
      cancellerPromise = null;
      if (p) await p.then((c) => c.end(), () => undefined).catch(() => undefined);
    },
  };
}

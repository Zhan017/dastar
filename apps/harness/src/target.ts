import type { Pool } from "pg";
import { createDastar, DastarError, type Dastar, type HoldInput } from "@dastar/db";
import { createKey } from "@dastar/api/auth";

/**
 * Phases of one hold, as the engine handle and the hold hooks let a client observe them. None of them is a
 * server-side wait time; each name says what it spans.
 */
export type Phases = {
  /** Wait for a pooled connection, reported by the handle. Censored when the call gave up waiting. */
  poolWaitMs: number | null; poolWaitCensored: boolean;
  /**
   * The unit lock statements of the final attempt: one round trip per unit plus any advisory-lock wait.
   * Censored when the request ended inside this phase; the value is then the time spent in it so far.
   */
  unitLockMs: number | null; unitLockCensored: boolean;
  /** From just before BEGIN of the final attempt to the handle's answer; on an error that includes the handle's rollback probe. */
  transactionMs: number | null;
  /** From connection acquired to the handle's answer: every attempt, and a backend-pid lookup the first time a connection is used. */
  connectionHeldMs: number | null;
  retries: number;
};
export type HoldAnswer = { code: string; reservationId: string | null; phases: Phases | null };

/**
 * What a load run sends requests to. A target never throws: a failure is an answer with a code. Two codes
 * come from the harness, not from the system under test: `transport_timeout`, when no complete answer
 * arrived within the harness's own deadline, and `transport_error`, when the connection failed. Neither
 * says what the database did; the run resolves that from the idempotency table afterwards. A third,
 * `malformed_response`, means the server answered with a status that claims success and a body that does
 * not carry it; it is an answer no healthy run produces, so it invalidates the run through the `other` rule.
 */
export type LoadTarget = {
  readonly kind: "engine" | "http";
  hold: (input: HoldInput) => Promise<HoldAnswer>;
  confirm: (reservationId: string, venueId: string, traceId: string) => Promise<string>;
  cancel: (reservationId: string, venueId: string, traceId: string) => Promise<string>;
  close: () => Promise<void>;
};

const codeOf = (e: unknown): string => (e instanceof DastarError ? e.code : "thrown");

/** The engine handle in this process. The only target that can observe phases. */
export function engineTarget(appPool: Pool, opts: { acquireTimeoutMs?: number; deadlineMs?: number } = {}): LoadTarget {
  const acquired = new Map<string, { waitMs: number; at: number; ok: boolean }>();
  const d: Dastar = createDastar({
    pool: appPool,
    ...(opts.acquireTimeoutMs !== undefined ? { acquireTimeoutMs: opts.acquireTimeoutMs } : {}),
    ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
    onAcquire: (i) => { if (i.traceId !== null) acquired.set(i.traceId, { waitMs: i.waitMs, at: performance.now(), ok: i.acquired }); },
  });
  const follow = async (traceId: string, fn: () => Promise<unknown>): Promise<string> => {
    try { await fn(); return "ok"; } catch (e) { return codeOf(e); } finally { acquired.delete(traceId); }
  };
  return {
    kind: "engine",
    hold: async (input) => {
      let begun: number | null = null;
      let lockFrom: number | null = null;
      let lockTo: number | null = null;
      let retries = 0;
      let code: string;
      let reservationId: string | null = null;
      try {
        const out = await d.hold(input, {
          beforeBegin: async () => { begun = performance.now(); lockFrom = null; lockTo = null; },
          beforeUnitLocks: async () => { lockFrom = performance.now(); },
          afterUnitLocks: async () => { lockTo = performance.now(); },
          onRetry: () => { retries += 1; },
        });
        code = out.ok ? "ok" : out.error.code;
        if (out.ok) reservationId = out.receipt.reservationId;
      } catch (e) {
        code = codeOf(e);
      }
      const done = performance.now();
      const acq = acquired.get(input.traceId);
      acquired.delete(input.traceId);
      const inLockPhase = lockFrom !== null && lockTo === null;
      return {
        code, reservationId,
        phases: {
          poolWaitMs: acq ? acq.waitMs : null, poolWaitCensored: acq ? !acq.ok : false,
          unitLockMs: lockFrom === null ? null : (lockTo ?? done) - lockFrom, unitLockCensored: inLockPhase,
          transactionMs: begun === null ? null : done - begun,
          connectionHeldMs: acq?.ok ? done - acq.at : null,
          retries,
        },
      };
    },
    confirm: (reservationId, venueId, traceId) => follow(traceId, () => d.confirm({ reservationId, actor: "load:follow-up", traceId, venueId })),
    cancel: (reservationId, venueId, traceId) => follow(traceId, () => d.cancel({ reservationId, actor: "load:follow-up", traceId, venueId, reason: "load run" })),
    close: () => d.close(),
  };
}

/** Keys for an HTTP run. An API key is one actor, and a venue allows an actor at most 100 live holds, so a run spreads its requests over several keys. */
export async function createLoadKeys(appPool: Pool, n: number): Promise<string[]> {
  const keys: string[] = [];
  for (let i = 0; i < n; i++) keys.push((await createKey(appPool, { label: `load run ${i}`, capabilities: ["hold", "confirm", "cancel"] })).key);
  return keys;
}

/** Comfortably past the API's own budget for one command: a 5 s acquire, a 12 s deadline, and a 2 s grace. */
export const HTTP_DEADLINE_MS = 30_000;

/**
 * The reference API over HTTP: authentication, validation, the key lookup's pool checkout, and the engine
 * behind it. Phases are not observable from here. Every request has a deadline that covers the headers and
 * the body, so a stalled response cannot keep a run from finishing and writing its report.
 */
export function httpTarget(api: { url: string; keys: readonly string[]; deadlineMs?: number }): LoadTarget {
  if (api.keys.length === 0) throw new Error("http target: at least one key");
  const deadlineMs = api.deadlineMs ?? HTTP_DEADLINE_MS;
  let n = 0;
  /** A parsed JSON object. `null` when the server answered but the body was not one: empty, HTML, a JSON literal, an array. */
  type Body = Record<string, unknown>;
  type Posted = { status: number; body: Body | null } | "transport_timeout" | "transport_error";
  const parseObject = (text: string): Body | null => {
    try {
      const v: unknown = JSON.parse(text);
      return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Body) : null;
    } catch {
      return null;
    }
  };
  const post = async (path: string, traceId: string, body: unknown, extra: Record<string, string> = {}): Promise<Posted> => {
    const signal = AbortSignal.timeout(deadlineMs);
    let res: Response;
    try {
      // the same signal aborts a body that never ends
      res = await fetch(`${api.url}${path}`, {
        method: "POST", signal,
        headers: { authorization: `Bearer ${api.keys[n++ % api.keys.length]!}`, "content-type": "application/json", "x-trace-id": traceId, ...extra },
        body: JSON.stringify(body),
      });
    } catch {
      return signal.aborted ? "transport_timeout" : "transport_error";
    }
    // reading the whole body is part of getting an answer: a connection that breaks or a deadline that fires here is a transport failure
    let text: string;
    try {
      text = await res.text();
    } catch {
      return signal.aborted ? "transport_timeout" : "transport_error";
    }
    return { status: res.status, body: parseObject(text) };
  };
  /** A success needs the status and a JSON object; a refusal's code comes from the body when it has one. */
  const codeFrom = (r: Posted, okStatus: number): string =>
    typeof r === "string" ? r
      : r.status === okStatus ? (r.body !== null ? "ok" : "malformed_response")
      : typeof r.body?.code === "string" ? r.body.code : `http_${r.status}`;
  return {
    kind: "http",
    hold: async (input) => {
      const r = await post(`/v1/venues/${input.venueId}/holds`, input.traceId, {
        party_size: input.partySize, starts_at: input.startsAt, duration_minutes: input.durationMinutes, assignment: input.assignment,
      }, { "idempotency-key": input.idempotencyKey });
      if (typeof r === "string" || r.status !== 201) return { code: codeFrom(r, 201), reservationId: null, phases: null };
      // a 201 claims a receipt; a body that does not carry one, whatever the reason, is no answer a healthy run produces
      const receipt = r.body?.receipt;
      const reservationId = receipt !== null && typeof receipt === "object" && !Array.isArray(receipt) && typeof (receipt as Record<string, unknown>).reservation_id === "string"
        ? ((receipt as Record<string, unknown>).reservation_id as string) : null;
      return reservationId !== null ? { code: "ok", reservationId, phases: null } : { code: "malformed_response", reservationId: null, phases: null };
    },
    confirm: async (reservationId, _venueId, traceId) => codeFrom(await post(`/v1/reservations/${reservationId}/confirm`, traceId, {}), 200),
    cancel: async (reservationId, _venueId, traceId) => codeFrom(await post(`/v1/reservations/${reservationId}/cancel`, traceId, { reason: "load run" }), 200),
    close: async () => undefined,
  };
}

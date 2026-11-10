import { randomUUID } from "node:crypto";
import type { DastarClient, components } from "@dastar/client";
import type { ToolName } from "./tools.js";
import {
  cancelled,
  foundSlots,
  holdMade,
  holdReplayed,
  isRepeatable,
  noAnswer,
  notCreatedInSession,
  otherVenue,
  problemOf,
  refused,
  reservationRead,
  transportReason,
  type ProblemDetails,
  type ToolResult,
} from "./result.js";

type Schemas = components["schemas"];

export type SearchArgs = Schemas["AvailabilityRequest"];
export type HoldArgs = Schemas["HoldRequest"];
export type CancelArgs = { reservation_id: string } & Schemas["CancelRequest"];
export type GetReservationArgs = { reservation_id: string };

/**
 * A hold request in the API's canonical form, and the string that names it. `intent` is what the API hashes for
 * idempotency (core's `canonicalHoldRequest`, minus the venue, which a session fixes), so two requests that
 * differ only in id case or in how the start time is spelled share one idempotency key.
 */
export function normalizeHold(args: HoldArgs): { body: HoldArgs; intent: string } {
  const instant = Date.parse(args.starts_at);
  const startsAt = Number.isNaN(instant) ? args.starts_at : new Date(instant).toISOString();
  const assignment = { kind: args.assignment.kind, id: args.assignment.id.toLowerCase() };
  const body: HoldArgs = {
    party_size: args.party_size,
    starts_at: startsAt,
    duration_minutes: args.duration_minutes,
    assignment,
    ...(args.external_ref !== undefined ? { external_ref: args.external_ref } : {}),
  };
  const intent = JSON.stringify({
    assignment: { id: assignment.id, kind: assignment.kind },
    durationMinutes: args.duration_minutes,
    externalRef: args.external_ref ?? null,
    partySize: args.party_size,
    startsAt,
  });
  return { body, intent };
}

export type ToolSessionOptions = {
  client: DastarClient;
  venueId: string;
  /** The clock, in epoch milliseconds; a hold is live while its expiry is after it. */
  now?: () => number;
  /** How long one request may take before it counts as unanswered. */
  timeoutMs?: number;
};

export type ToolSession = {
  readonly venueId: string;
  searchAvailability(args: SearchArgs): Promise<ToolResult>;
  hold(args: HoldArgs): Promise<ToolResult>;
  cancel(args: CancelArgs): Promise<ToolResult>;
  getReservation(args: GetReservationArgs): Promise<ToolResult>;
  /** Runs the named tool; the caller has checked `args` against that tool's input schema. */
  call(name: ToolName, args: unknown): Promise<ToolResult>;
};

/** What one request came to: the API's answer, a refusal in Problem Details, or no answer at all. */
type Attempt<T> =
  | { kind: "answer"; data: T }
  | { kind: "refusal"; problem: ProblemDetails }
  | { kind: "silence"; reason: string };

/** What the last attempt at a hold request came to, as far as reusing its idempotency key goes. */
type Outcome =
  | { kind: "unanswered" }
  | { kind: "refused" }
  | { kind: "held"; reservationId: string; status: string; expiresAt: number };

type KeyEntry = { key: string; last: Outcome | undefined };

const UNANSWERED: Outcome = { kind: "unanswered" };
const REFUSED: Outcome = { kind: "refused" };
/** A reservation in one of these statuses holds nothing, so asking for the same hold again must start a new one. */
const ENDED = new Set(["cancelled", "expired", "completed"]);

/**
 * The four tools for one venue, run over HTTP through the typed client. A session remembers what it created, so
 * it cancels only that, and which idempotency key each hold request is on, so asking again is safe. No method throws.
 */
export function createToolSession(opts: ToolSessionOptions): ToolSession {
  const { client } = opts;
  const venueId = opts.venueId.toLowerCase();
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const created = new Set<string>();
  const cancelledIds = new Set<string>();
  const entries = new Map<string, KeyEntry>();

  /** Runs one request under its own deadline. A rejection is a timeout when the deadline passed, whatever error it carries. */
  async function send<T>(
    run: (signal: AbortSignal) => Promise<{ data?: T | undefined; error?: unknown; response: Response }>,
  ): Promise<Attempt<T>> {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const { data, error, response } = await run(signal);
      return data !== undefined ? { kind: "answer", data } : { kind: "refusal", problem: problemOf(response.status, error) };
    } catch (error) {
      return { kind: "silence", reason: signal.aborted ? `no response within ${timeoutMs / 1000} seconds` : transportReason(error) };
    }
  }

  const failure = (attempt: Exclude<Attempt<unknown>, { kind: "answer" }>): ToolResult =>
    attempt.kind === "silence" ? noAnswer(attempt.reason) : refused(attempt.problem);

  /** The same request goes on the same key while its last attempt got no answer or its hold is still live; any other outcome starts afresh. */
  function reusable(last: Outcome | undefined): boolean {
    if (last === undefined || last.kind === "unanswered") return true;
    if (last.kind === "refused") return false;
    return !cancelledIds.has(last.reservationId) && !ENDED.has(last.status) && last.expiresAt > now();
  }

  function entryFor(intent: string): KeyEntry {
    const current = entries.get(intent);
    if (current !== undefined && reusable(current.last)) return current;
    const fresh: KeyEntry = { key: randomUUID(), last: undefined };
    entries.set(intent, fresh);
    return fresh;
  }

  async function readReservation(id: string): Promise<Schemas["Reservation"] | undefined> {
    const attempt = await send<Schemas["Reservation"]>((signal) =>
      client.GET("/v1/reservations/{id}", { params: { path: { id } }, signal }),
    );
    return attempt.kind === "answer" ? attempt.data : undefined;
  }

  async function searchAvailability(args: SearchArgs): Promise<ToolResult> {
    const attempt = await send<Schemas["Availability"]>((signal) =>
      client.POST("/v1/venues/{id}/availability", { params: { path: { id: venueId } }, body: args, signal }),
    );
    return attempt.kind === "answer" ? foundSlots(attempt.data, args.party_size) : failure(attempt);
  }

  async function hold(args: HoldArgs): Promise<ToolResult> {
    const { body, intent } = normalizeHold(args);
    // Read or made before the first await, so concurrent calls for one request send one key.
    const entry = entryFor(intent);
    const attempt = await send<Schemas["HoldResponse"]>((signal) =>
      client.POST("/v1/venues/{id}/holds", {
        params: { path: { id: venueId }, header: { "idempotency-key": entry.key } },
        body,
        signal,
      }),
    );
    if (attempt.kind === "silence") {
      entry.last = UNANSWERED;
      return failure(attempt);
    }
    if (attempt.kind === "refusal") {
      entry.last = isRepeatable(attempt.problem) ? UNANSWERED : REFUSED;
      return failure(attempt);
    }
    const made = attempt.data;
    const id = made.receipt.reservation_id.toLowerCase();
    created.add(id);
    const expiresAt = Date.parse(made.hold_expires_at);
    if (!made.replayed) {
      entry.last = { kind: "held", reservationId: id, status: made.receipt.status, expiresAt };
      return holdMade(made);
    }
    // A replay answers with the stored receipt; what the reservation is now takes a read.
    const current = (await readReservation(id))?.status;
    entry.last = { kind: "held", reservationId: id, status: current ?? made.receipt.status, expiresAt };
    return holdReplayed(made, current);
  }

  async function cancel(args: CancelArgs): Promise<ToolResult> {
    const id = args.reservation_id.toLowerCase();
    if (!created.has(id)) return notCreatedInSession(args.reservation_id);
    const attempt = await send<Schemas["ReceiptResponse"]>((signal) =>
      client.POST("/v1/reservations/{id}/cancel", {
        params: { path: { id } },
        body: { reason: args.reason, ...(args.expected_version !== undefined ? { expected_version: args.expected_version } : {}) },
        signal,
      }),
    );
    if (attempt.kind !== "answer") return failure(attempt);
    cancelledIds.add(id);
    return cancelled(attempt.data);
  }

  async function getReservation(args: GetReservationArgs): Promise<ToolResult> {
    const id = args.reservation_id.toLowerCase();
    const attempt = await send<Schemas["Reservation"]>((signal) =>
      client.GET("/v1/reservations/{id}", { params: { path: { id } }, signal }),
    );
    if (attempt.kind !== "answer") return failure(attempt);
    return attempt.data.venue_id.toLowerCase() === venueId ? reservationRead(attempt.data) : otherVenue();
  }

  function call(name: ToolName, args: unknown): Promise<ToolResult> {
    switch (name) {
      case "search_availability":
        return searchAvailability(args as SearchArgs);
      case "hold":
        return hold(args as HoldArgs);
      case "cancel":
        return cancel(args as CancelArgs);
      case "get_reservation":
        return getReservation(args as GetReservationArgs);
    }
  }

  return { venueId, searchAvailability, hold, cancel, getReservation, call };
}

import type { DastarErrorCode } from "./errors.js";

/** A reservation's stored status (system design, section 8). */
export const STATUSES = ["held", "confirmed", "seated", "completed", "cancelled", "expired"] as const;
export type ReservationStatus = (typeof STATUSES)[number];

/**
 * The state table: the only transitions the database's transition trigger allows (invariant 7). The
 * database is the enforcement; this copy lets a caller reason about a status without a round trip, and a
 * test in `@dastar/db` checks every one of the 36 pairs against the trigger.
 */
export const TRANSITIONS: Readonly<Record<ReservationStatus, readonly ReservationStatus[]>> = {
  held: ["confirmed", "cancelled", "expired"],
  confirmed: ["seated", "cancelled"],
  seated: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
  expired: [],
};

export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** A status no reservation leaves. */
export function isTerminal(status: ReservationStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export type Assignment = { kind: "unit" | "combo"; id: string };

export type HoldInput = {
  venueId: string;
  actor: string;
  traceId: string;
  idempotencyKey: string;
  partySize: number;
  startsAt: string;
  durationMinutes: number;
  assignment: Assignment;
  externalRef?: string;
};

export type Receipt = { reservationId: string; status: string; version: number; auditId: number; traceId: string };

export type HoldOutcome =
  | { ok: true; receipt: Receipt; holdExpiresAt: string; replayed: boolean }
  | { ok: false; error: { code: DastarErrorCode; message: string }; replayed: boolean };

/**
 * The canonical form of a hold request that its idempotency hash is taken over: the same request, however
 * its ids are cased or its start time spelled, hashes the same, and any change to what is booked does not.
 */
export function canonicalHoldRequest(i: HoldInput): string {
  const startsAt = new Date(i.startsAt).toISOString();
  return JSON.stringify({
    assignment: { id: i.assignment.id.toLowerCase(), kind: i.assignment.kind },
    durationMinutes: i.durationMinutes,
    externalRef: i.externalRef ?? null,
    partySize: i.partySize,
    startsAt,
    venueId: i.venueId.toLowerCase(),
  });
}

import type { components, DastarClient } from "@dastar/client";
import type { Dastar, SessionRef } from "@dastar/db";
import { openToken, sealToken } from "./tokens.js";

/** A hold the person can confirm with a button: what to show of it, and the token that button sends. */
export type HoldEntry = {
  reservation_id: string;
  party_size: number;
  starts_at: string;
  duration_minutes: number;
  hold_expires_at: string;
  confirm_token: string;
};

export type HoldsDeps = {
  dastar: Dastar;
  /** A client with the demo key (read, confirm) and no session: the answer to a mint holds the token, which must never become a recorded call. */
  demoClient: DastarClient;
  /** The 32 bytes the stored tokens are encrypted with. */
  tokenKey: Buffer;
  /** How long each read and each mint may take; 10 seconds when not given. */
  timeoutMs?: number;
};

type Reservation = components["schemas"]["Reservation"];

const DEFAULT_TIMEOUT_MS = 10_000;
const MICROS_PER_MINUTE = 60_000_000;

/** A timestamp as Postgres prints it with a zone: "2064-01-07 19:00:00.25+00", the offset as hours, hours:minutes or hours:minutes:seconds. */
const STAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?([+-])(\d{2})(?::(\d{2})(?::(\d{2}))?)?$/;
/** A tstzrange as Postgres prints it: both bounds, quoted because they hold a space, and the bracket or parenthesis of each end. */
const RANGE = /^[[(]"?([^",]+)"?,"?([^",]+)"?[\])]$/;

/** A time as whole seconds since the epoch in UTC, and the microseconds after them. */
function parseStamp(text: string): { seconds: number; micros: number } | null {
  const match = STAMP.exec(text);
  if (match === null) return null;
  const part = (index: number): number => Number(match[index] ?? "0");
  const at = new Date(0);
  at.setUTCFullYear(part(1), part(2) - 1, part(3));
  at.setUTCHours(part(4), part(5), part(6), 0);
  const offsetSeconds = (part(9) * 3600 + part(10) * 60 + part(11)) * (match[8] === "-" ? -1 : 1);
  return { seconds: at.getTime() / 1000 - offsetSeconds, micros: Number((match[7] ?? "").padEnd(6, "0")) };
}

/** The length of a range as the database prints a tstzrange, in minutes; null for `empty`, text that is not a range, an end that is not after the start, and a length that is not a whole number of minutes. */
export function rangeMinutes(during: string): number | null {
  const bounds = RANGE.exec(during);
  if (bounds === null) return null;
  const start = parseStamp(bounds[1] ?? "");
  const end = parseStamp(bounds[2] ?? "");
  if (start === null || end === null) return null;
  const length = (end.seconds - start.seconds) * 1_000_000 + (end.micros - start.micros);
  if (!Number.isSafeInteger(length) || length <= 0 || length % MICROS_PER_MINUTE !== 0) return null;
  return length / MICROS_PER_MINUTE;
}

/** The read's status is the effective one, computed by the database at the read (an expired hold reads `expired`), so no clock of the app's is compared. */
export function isLiveHold(read: { status: string }): boolean {
  return read.status === "held";
}

/** The reservation as the demo key reads it; null when it cannot be read, whatever the reason. */
async function readReservation(client: DastarClient, id: string, timeoutMs: number): Promise<Reservation | null> {
  try {
    const read = await client.GET("/v1/reservations/{id}", { params: { path: { id } }, signal: AbortSignal.timeout(timeoutMs) });
    return read.data ?? null;
  } catch {
    return null;
  }
}

/** A new confirm token for the reservation at the version just read, which replaces the one it had; null when the mint is refused or does not answer. */
async function mintToken(client: DastarClient, read: Reservation, timeoutMs: number): Promise<string | null> {
  try {
    const minted = await client.POST("/v1/reservations/{id}/confirm-token", {
      params: { path: { id: read.id } },
      body: { expected_version: read.version },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const token = minted.data?.confirm_token;
    return typeof token === "string" && token !== "" ? token : null;
  } catch {
    return null;
  }
}

/**
 * The entries for the reservations the agent created that are still held, in the order given. Each is read with the
 * demo key, all at once; one that cannot be read, is not held now, belongs to another venue or has a range that is not
 * whole minutes is left out. The session's stored token is opened and reused; when there is none, or it does not open,
 * a token is minted, kept encrypted for the session, and used. A refused or unanswered mint, or a token that could not
 * be kept, leaves that entry out. Nothing here logs or throws for a single reservation, and a token appears only in the
 * entries returned and, sealed, in the session's rows.
 */
export async function buildHolds(deps: HoldsDeps, ref: SessionRef, created: string[]): Promise<HoldEntry[]> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // two mints for one reservation would each replace the other's token, so every reservation is asked about once
  const ids = [...new Set(created.map((id) => id.toLowerCase()))];
  const reads = await Promise.all(ids.map((id) => readReservation(deps.demoClient, id, timeoutMs)));

  const live: { read: Reservation; minutes: number }[] = [];
  for (const read of reads) {
    if (read === null || !isLiveHold(read) || read.venue_id.toLowerCase() !== ref.venueId.toLowerCase()) continue;
    const minutes = rangeMinutes(read.during);
    if (minutes !== null) live.push({ read, minutes });
  }
  if (live.length === 0) return [];

  const rows = await deps.dastar.sessions.listSessionHolds(ref);
  const stored = new Map(rows.map((row): [string, Buffer] => [row.reservationId.toLowerCase(), row.tokenEnc]));

  const entries = await Promise.all(
    live.map(async ({ read, minutes }): Promise<HoldEntry | null> => {
      const tokenRef = { sessionId: ref.sessionId, reservationId: read.id };
      const sealed = stored.get(read.id.toLowerCase());
      let token = sealed === undefined ? null : openToken(deps.tokenKey, tokenRef, sealed);
      if (token === null) {
        token = await mintToken(deps.demoClient, read, timeoutMs);
        if (token === null) return null;
        const tokenEnc = sealToken(deps.tokenKey, tokenRef, token);
        try {
          await deps.dastar.sessions.putSessionHold({ ...ref, reservationId: read.id, tokenEnc });
        } catch {
          return null;
        }
      }
      return {
        reservation_id: read.id,
        party_size: read.party_size,
        starts_at: read.starts_at,
        duration_minutes: minutes,
        hold_expires_at: read.hold_expires_at,
        confirm_token: token,
      };
    }),
  );
  return entries.filter((entry): entry is HoldEntry => entry !== null);
}

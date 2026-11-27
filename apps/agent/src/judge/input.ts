import { CLAIM_STATUSES, observedReservations, type Claim, type ClaimStatus, type LoggedCall } from "@dastar/db";
import { venueClock } from "../clock.js";

/** A reservation the session's calls showed: its id, its start as an instant with the venue's offset, and its party size, each null when no call showed it. */
export type JudgeReservation = { id: string; starts_at: string | null; party_size: number | null };

/** What the judge reads for one assistant turn: the session's reservations, the person's message before it, the turn's own text, and the claims the turn declared (which the judge is not shown). */
export type JudgeInput = { reservations: JudgeReservation[]; user_text: string | null; assistant_text: string; claims: Claim[] };

/** The most characters of the user's message the judge is shown. */
export const USER_TEXT_CHARS = 2_000;

/** A date and time with a seconds part that may be left out, and an offset or Z: the shape of an instant the API takes. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The instant as a clock at the venue writes it, with the venue's offset ("2064-01-07T18:00:00+01:00"), or null for a value that is not an instant. Fractions of a second are dropped. */
export function venueInstant(instant: string, timeZone: string): string | null {
  if (!INSTANT.test(instant)) return null;
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) return null;

  const at = new Date(ms);
  const { local, offset } = venueClock(at.toISOString(), timeZone);
  const seconds = String(at.getUTCSeconds()).padStart(2, "0");
  return `${local.replace(" ", "T")}:${seconds}${offset}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isStatus = (value: unknown): value is ClaimStatus => typeof value === "string" && (CLAIM_STATUSES as readonly string[]).includes(value);

/** A declared claim with its id lowercased, or null when the value is not the shape of a claim. */
function asClaim(value: unknown): Claim | null {
  if (!isRecord(value)) return null;
  const { reservation_id, status, starts_at, party_size } = value;
  if (typeof reservation_id !== "string" || reservation_id === "" || !isStatus(status)) return null;
  if (starts_at !== undefined && typeof starts_at !== "string") return null;
  if (party_size !== undefined && (typeof party_size !== "number" || !Number.isFinite(party_size))) return null;
  return {
    reservation_id: reservation_id.toLowerCase(),
    status,
    ...(starts_at !== undefined ? { starts_at } : {}),
    ...(party_size !== undefined ? { party_size } : {}),
  };
}

/** The text cut to at most `limit` characters, never between the two halves of one. */
function cut(text: string, limit: number): string {
  return text.length <= limit ? text : Array.from(text).slice(0, limit).join("");
}

/** The judge's input for one assistant turn, from the turn, the person's message before it, its declared claims, the session's calls and the venue's time zone. */
export function buildJudgeInput(source: {
  text: string;
  userText: string | null;
  claims: unknown[] | null;
  calls: readonly LoggedCall[];
  timeZone: string;
}): JudgeInput {
  return {
    reservations: observedReservations(source.calls).map((r) => ({
      id: r.id,
      starts_at: r.starts_at === undefined ? null : venueInstant(r.starts_at, source.timeZone),
      party_size: r.party_size ?? null,
    })),
    user_text: source.userText === null ? null : cut(source.userText, USER_TEXT_CHARS),
    assistant_text: source.text,
    claims: (source.claims ?? []).flatMap((value) => {
      const claim = asClaim(value);
      return claim === null ? [] : [claim];
    }),
  };
}

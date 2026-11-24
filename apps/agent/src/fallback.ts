import { CLAIM_STATUSES } from "@dastar/db";
import { venueClock } from "./clock.js";
import type { ClaimStatus, Reply, ReplyClaim } from "./reply.js";

/** A reservation of the conversation as it was just read; null when it could not be read. */
export type FallbackRead = { reservationId: string; reservation: { status: string; starts_at: string; party_size: number } | null };

const isClaimStatus = (status: string): status is ClaimStatus => CLAIM_STATUSES.some((known) => known === status);

/** The time as `Monday 2064-01-07 19:00 (Europe/Berlin)`; the text as given when it is not a time. */
function venueTime(startsAt: string, timezone: string): string {
  try {
    const { weekday, local } = venueClock(startsAt, timezone);
    return `${weekday} ${local} (${timezone})`;
  } catch {
    return startsAt;
  }
}

/**
 * What the person is told when the agent could not produce a reply: where each reservation of the conversation stands,
 * from the reads alone. It claims only what was read, so it passes the same check a reply does.
 */
export function fallbackReply(reads: FallbackRead[], timezone: string): Reply {
  const sorry = "Sorry, I could not complete that request.";
  if (reads.length === 0) return { message: `${sorry} No reservation has been made in this conversation.`, claims: [] };

  const lines: string[] = [];
  const claims: ReplyClaim[] = [];
  for (const { reservationId, reservation } of reads) {
    if (reservation === null) {
      lines.push(`- ${reservationId}: could not be read just now.`);
      continue;
    }
    lines.push(
      `- ${reservationId}: ${reservation.status}, party of ${reservation.party_size}, ${venueTime(reservation.starts_at, timezone)}.`,
    );
    if (isClaimStatus(reservation.status)) {
      claims.push({
        reservation_id: reservationId,
        status: reservation.status,
        starts_at: reservation.starts_at,
        party_size: reservation.party_size,
      });
    }
  }
  return { message: [`${sorry} Here is where this conversation's reservations stand:`, ...lines].join("\n"), claims };
}

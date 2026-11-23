import { isRepeatable, type HoldArgs, type RestoredHold, type RestoredOutcome, type ToolSessionRestore } from "@dastar/agent-tools";
import type { RecordedCall } from "@dastar/db";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The hold request a recorded hold call carries, and the idempotency key it was sent on; null when a field is missing or of another type. */
function holdOf(input: unknown): { request: HoldArgs; key: string } | null {
  if (!isObject(input)) return null;
  const { party_size: partySize, starts_at: startsAt, duration_minutes: durationMinutes, assignment, idempotency_key: key } = input;
  if (typeof partySize !== "number" || typeof startsAt !== "string" || typeof durationMinutes !== "number") return null;
  if (typeof key !== "string" || key === "" || !isObject(assignment)) return null;
  const { kind, id } = assignment;
  if ((kind !== "unit" && kind !== "combo") || typeof id !== "string") return null;
  return {
    request: { party_size: partySize, starts_at: startsAt, duration_minutes: durationMinutes, assignment: { kind, id } },
    key,
  };
}

/** The reservation a recorded receipt names, lowercased, and its status; null when it names none. */
function receiptOf(receipt: unknown): { reservationId: string; status: string } | null {
  if (!isObject(receipt)) return null;
  const { reservation_id: id, status } = receipt;
  return typeof id === "string" && typeof status === "string" ? { reservationId: id.toLowerCase(), status } : null;
}

const answered = (status: number): boolean => status >= 200 && status < 300;

/** What a recorded hold call came to; null when its answer was recorded in a shape that cannot be read. */
function outcomeOf(call: RecordedCall): RestoredOutcome | null {
  const status: unknown = call.status;
  if (status === null) return { kind: "unanswered" };
  if (typeof status !== "number") return null;
  if (!answered(status)) {
    // a refusal records its code and nothing else; one without a code is named as the session names it
    const code: unknown = isObject(call.output) ? call.output["code"] : undefined;
    if (code !== undefined && typeof code !== "string") return null;
    return isRepeatable({ code: code ?? "unexpected_response", status }) ? { kind: "unanswered" } : { kind: "refused" };
  }
  const receipt = receiptOf(call.receipt);
  const expiresAt: unknown = isObject(call.output) ? call.output["hold_expires_at"] : undefined;
  if (receipt === null || typeof expiresAt !== "string") return null;
  return { kind: "held", reservationId: receipt.reservationId, status: receipt.status, expiresAt };
}

/**
 * What an earlier session did, read back from its recorded calls: the reservations its holds made and its cancels
 * ended, each once and lowercased in the order first seen, and each hold request with its idempotency key and what its
 * last attempt came to. Calls are read in the order they were begun. The log is data: a call whose recorded fields
 * are of the wrong type is skipped, and nothing here throws.
 */
export function restoreFromCalls(calls: RecordedCall[]): ToolSessionRestore {
  const created = new Set<string>();
  const cancelled = new Set<string>();
  const holds: RestoredHold[] = [];
  for (const call of [...calls].sort((a, b) => a.id - b.id)) {
    if (call.tool === "hold") {
      const made = holdOf(call.input);
      const outcome = made === null ? null : outcomeOf(call);
      if (made === null || outcome === null) continue;
      holds.push({ request: made.request, key: made.key, outcome });
      if (outcome.kind === "held") created.add(outcome.reservationId);
    } else if (call.tool === "cancel" && call.status !== null && answered(call.status)) {
      const receipt = receiptOf(call.receipt);
      if (receipt !== null) cancelled.add(receipt.reservationId);
    }
  }
  return { created: [...created], cancelled: [...cancelled], holds };
}

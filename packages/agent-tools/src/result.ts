import type { components } from "@dastar/client";

type Schemas = components["schemas"];

/** What a tool hands back to a model: one sentence and the data behind it, as `text` for a reader and `structured` for a program. */
export type ToolResult = { isError: boolean; text: string; structured: Record<string, unknown> };

/** The part of an error answer a model is shown: the code and HTTP status, and what the API said besides. */
export type ProblemDetails = { code: string; status: number; detail?: string; trace_id?: string; replayed?: boolean };

const REPEAT_IS_SAFE = "Repeating the same request is safe.";

function result(isError: boolean, sentence: string, structured: Record<string, unknown>): ToolResult {
  return { isError, text: `${sentence}\n${JSON.stringify(structured)}`, structured };
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** An error answer is Problem Details when its body is an object with a string `code`; anything else is named for its status alone. */
export function problemOf(status: number, body: unknown): ProblemDetails {
  const fields = asRecord(body);
  const code = fields?.["code"];
  if (fields === undefined || typeof code !== "string") {
    return { code: "unexpected_response", status, detail: `HTTP ${status} without Problem Details` };
  }
  const { detail, trace_id: traceId, replayed } = fields;
  return {
    code,
    status,
    ...(typeof detail === "string" ? { detail } : {}),
    ...(typeof traceId === "string" ? { trace_id: traceId } : {}),
    ...(typeof replayed === "boolean" ? { replayed } : {}),
  };
}

/** Whether the same request may be sent again: the server failed, or the engine lost a race it would not lose twice. */
export const isRepeatable = (problem: ProblemDetails): boolean => problem.status >= 500 || problem.code === "serialization_conflict";

export function refused(problem: ProblemDetails): ToolResult {
  const detail = problem.detail !== undefined ? ` (${problem.detail})` : "";
  const repeat = isRepeatable(problem) ? ` ${REPEAT_IS_SAFE}` : "";
  return result(true, `Refused: ${problem.code}${detail}.${repeat}`, problem);
}

/** The request got no answer: the connection failed or the venue's API was too slow. */
export function noAnswer(reason: string): ToolResult {
  return result(true, `No answer from the venue's API: ${reason}. ${REPEAT_IS_SAFE}`, { code: "transport_error", detail: reason });
}

/** Why a request got no answer: what the failure said, and the system error code under it when there is one. */
export function transportReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = asRecord(error instanceof Error ? error.cause : undefined);
  const code = cause?.["code"];
  return typeof code === "string" ? `${message} (${code})` : message;
}

export function notCreatedInSession(reservationId: string): ToolResult {
  return result(
    true,
    `Refused: not_created_in_session (this session did not create reservation ${reservationId}, so it cannot cancel it).`,
    { code: "not_created_in_session", reservation_id: reservationId },
  );
}

/** A reservation of another venue reads as absent, as it would to a key scoped to this venue. */
export const otherVenue = (): ToolResult =>
  refused({ code: "not_found", status: 404, detail: "no reservation with this id in this venue" });

export function foundSlots(availability: Schemas["Availability"], partySize: number): ToolResult {
  const n = availability.slots.length;
  if (n === 0) return result(false, `No slots found for a party of ${partySize} in that window.`, availability);
  const found = `Found ${n} ${n === 1 ? "slot" : "slots"}`;
  return result(false, availability.truncated ? `${found}; the search stopped at a limit, so more may exist.` : `${found}.`, availability);
}

export function holdMade(created: Schemas["HoldResponse"]): ToolResult {
  return result(
    false,
    `Held reservation ${created.receipt.reservation_id} until ${created.hold_expires_at}. It is not booked until a person confirms it through the venue; otherwise it expires then.`,
    created,
  );
}

/** A hold the API had already made for this key; `currentStatus` is the reservation's status now, when it could be read. */
export function holdReplayed(created: Schemas["HoldResponse"], currentStatus: string | undefined): ToolResult {
  const id = created.receipt.reservation_id;
  if (currentStatus === undefined) {
    return result(
      false,
      `This hold was already made: reservation ${id}, held until ${created.hold_expires_at}; its current status could not be read.`,
      created,
    );
  }
  const holdsNothing = currentStatus === "cancelled" || currentStatus === "expired" ? " It holds nothing; the same request again asks for a new hold." : "";
  return result(false, `This hold was already made: reservation ${id} is ${currentStatus} now.${holdsNothing}`, { ...created, current_status: currentStatus });
}

export const cancelled = (answer: Schemas["ReceiptResponse"]): ToolResult =>
  result(false, `Cancelled reservation ${answer.receipt.reservation_id}.`, answer);

export const reservationRead = (reservation: Schemas["Reservation"]): ToolResult =>
  result(false, `Reservation ${reservation.id} is ${reservation.status}.`, reservation);

import { z } from "zod";
import { CLAIM_STATUSES } from "@dastar/db";
import type { JsonSchema } from "./tools.js";

export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** A reservation the reply's message states something about: its status, start or party size, as of now. */
export type ReplyClaim = { reservation_id: string; status: ClaimStatus; starts_at: string; party_size: number };

/** What the agent says to the person, and the reservations it says it about. The app checks each claim against the reservation before the message is shown. */
export type Reply = { message: string; claims: ReplyClaim[] };

/** The reply's shape as the provider's structured output takes it: every field required, both objects closed. */
export const REPLY_JSON_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    message: { type: "string" },
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          reservation_id: { type: "string", format: "uuid" },
          status: { type: "string", enum: [...CLAIM_STATUSES] },
          starts_at: { type: "string", format: "date-time" },
          party_size: { type: "integer" },
        },
        required: ["reservation_id", "status", "starts_at", "party_size"],
        additionalProperties: false,
      },
    },
  },
  required: ["message", "claims"],
  additionalProperties: false,
};

const ReplySchema = z.strictObject({
  message: z.string(),
  claims: z.array(
    z.strictObject({
      reservation_id: z.guid().transform((id) => id.toLowerCase()),
      status: z.string().transform((status) => status.toLowerCase()).pipe(z.enum(CLAIM_STATUSES)),
      starts_at: z.iso.datetime({ offset: true }),
      party_size: z.int(),
    }),
  ),
});

/** The reply in `text`, with its statuses and ids lowercased, or null when it is not JSON or not the reply's shape. */
export function parseReply(text: string): Reply | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = ReplySchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

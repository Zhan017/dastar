import { z } from "zod";
import { CLAIM_STATUSES, type JudgeStatement } from "@dastar/db";

const JudgeReplySchema = z.strictObject({
  statements: z.array(
    z.strictObject({
      quote: z.string(),
      reservation_id: z.guid().transform((id) => id.toLowerCase()).nullable(),
      status: z.string().transform((status) => status.toLowerCase()).pipe(z.enum(CLAIM_STATUSES)),
      starts_at: z.iso.datetime({ offset: true }).nullable(),
      party_size: z.int().nullable(),
    }),
  ),
});

/** The statements in the judge's reply, with each status and id lowercased, or null when the text is not JSON or not the reply's shape. */
export function parseJudgeReply(text: string): JudgeStatement[] | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = JudgeReplySchema.safeParse(json);
  return parsed.success ? parsed.data.statements : null;
}

import { fileURLToPath } from "node:url";
import { CLAIM_STATUSES } from "@dastar/db";
import { promptHash, readPromptFile, renderTemplate } from "../prompt.js";
import type { JsonSchema } from "../tools.js";
import type { JudgeInput } from "./input.js";

export const JUDGE_PROMPT_FILE: string = fileURLToPath(new URL("../../prompts/judge-v1.md", import.meta.url));

/** The one line of the judge's prompt file that ends the system prompt and begins the message template. */
export const JUDGE_MARKER = "<!-- message template -->";

/** The judge's reply as the provider's structured output takes it: every field required, both objects closed. */
export const JUDGE_REPLY_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    statements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          quote: { type: "string" },
          reservation_id: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
          status: { type: "string", enum: [...CLAIM_STATUSES] },
          starts_at: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
          party_size: { anyOf: [{ type: "integer" }, { type: "null" }] },
        },
        required: ["quote", "reservation_id", "status", "starts_at", "party_size"],
        additionalProperties: false,
      },
    },
  },
  required: ["statements"],
  additionalProperties: false,
};

/** The system prompt, the template of the message, and a hash of everything that shapes what the judge is told: both texts, its tools (none) and its reply format. */
export type LoadedJudgePrompt = { system: string; template: string; hash: string };

/** Reads the judge's prompt file. */
export function loadJudgePrompt(file: string = JUDGE_PROMPT_FILE): LoadedJudgePrompt {
  const { system, template } = readPromptFile(file, JUDGE_MARKER, "message template");
  return { system, template, hash: promptHash(system, template, [], JUDGE_REPLY_SCHEMA) };
}

/**
 * A block's value as the message carries it: the JSON text of the value, with each `<` written as its JSON escape, so a
 * text that closes a block's tag stays inside the block. Only `<` is escaped beyond what JSON.stringify writes: the
 * statements' quotes are matched against the original text with that one escape undone.
 */
function block(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/** The message for one assistant turn: the template filled with the reservations, the user turn before it and the turn's text. */
export function renderJudgeMessage(template: string, input: JudgeInput): string {
  return renderTemplate(
    template,
    { reservations: block(input.reservations), user_turn: block(input.user_text), assistant_turn: block(input.assistant_text) },
    "message template",
  );
}

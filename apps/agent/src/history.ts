import type { StoredTurn } from "@dastar/db";
import type { ChatMessage } from "./provider.js";

/**
 * What the model is given for a turn: the earlier turns of the conversation as stored, then the person's new message,
 * then the app's context for this turn. A person's turn is its text; an assistant turn goes back as the reply's JSON,
 * the message and the claims it made, so the model sees its own earlier replies in the format it writes them.
 */
export function buildConversation(input: { turns: StoredTurn[]; message: string; context: string }): ChatMessage[] {
  const earlier = input.turns.map(
    (turn): ChatMessage =>
      turn.role === "user"
        ? { role: "user", text: turn.content }
        : { role: "assistant", text: JSON.stringify({ message: turn.content, claims: turn.claims ?? [] }) },
  );
  return [...earlier, { role: "user", text: input.message }, { role: "operator", text: input.context }];
}

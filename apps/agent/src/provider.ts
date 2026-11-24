import type { JsonSchema, ProviderTool } from "./tools.js";

/** A tool the model asked to call: the provider's id for the call, the tool's name and the arguments as the model wrote them. */
export type ToolCall = { id: string; name: string; input: unknown };

/** What a tool call came to, as it goes back to the model. */
export type ToolOutput = { id: string; text: string; isError: boolean };

/** The conversation as the turn keeps it, before it is put into a provider's request. */
export type ChatMessage =
  | { role: "user"; text: string } // the person
  | { role: "operator"; text: string } // the app
  | { role: "assistant"; text: string } // an earlier turn's delivered reply, as JSON text
  | { role: "provider"; content: unknown } // this turn's model output, passed back unchanged
  | { role: "tool_results"; results: ToolOutput[] };

/** Tokens a completion used: the input not served from the cache, the output, and the cache's reads and writes. */
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };

/**
 * What one model call came to. `assistant` is the model's output in the form to pass back as a `provider` message;
 * `truncated` is output cut short, `refused` a call the model declined.
 */
export type Completion = (
  | { kind: "tools"; calls: ToolCall[]; assistant: unknown }
  | { kind: "reply"; text: string; assistant: unknown }
  | { kind: "refused" }
  | { kind: "truncated" }
) & { usage: Usage; model: string };

export type CompletionRequest = {
  system: string;
  messages: ChatMessage[];
  tools: readonly ProviderTool[];
  replySchema: JsonSchema;
  signal: AbortSignal;
};

/** The model behind the agent: one call in, one completion out, and a rejection when the provider fails. */
export interface LLMProvider {
  complete(request: CompletionRequest): Promise<Completion>;
}

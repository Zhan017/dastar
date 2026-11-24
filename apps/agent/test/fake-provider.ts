import type { Completion, CompletionRequest, LLMProvider, Usage } from "../src/provider.js";
import type { Reply } from "../src/reply.js";

export type Step = Completion | ((request: CompletionRequest) => Completion | Promise<Completion>);

export const USAGE: Usage = { input: 100, output: 20, cacheRead: 10, cacheWrite: 5 };

/**
 * A provider that answers each call with the next step, in order: a completion as it is, or a function's answer to the request.
 * A call with no step left rejects. `requests` holds a deep copy of each request, so the turn changing its messages afterward
 * does not change what was recorded; the signal is kept as given, as an AbortSignal cannot be cloned.
 */
export function scripted(...steps: Step[]): LLMProvider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  let next = 0;
  return {
    requests,
    async complete(request: CompletionRequest): Promise<Completion> {
      const { signal, ...rest } = request;
      requests.push({ ...structuredClone(rest), signal });
      const step = steps[next];
      next += 1;
      if (step === undefined) throw new Error(`the scripted provider has no step for call ${next}`);
      return typeof step === "function" ? step(request) : step;
    },
  };
}

/** The model asks for one tool call. */
export const toolCall = (name: string, input: unknown, id: string = "toolu_fake"): Completion => ({
  kind: "tools",
  calls: [{ id, name, input }],
  assistant: [{ type: "tool_use", id, name, input }],
  usage: { ...USAGE },
  model: "fake-model",
});

/** The model replies: a reply is sent as its JSON, a string as the text unchanged. */
export const replyWith = (reply: Reply | string): Completion => {
  const text = typeof reply === "string" ? reply : JSON.stringify(reply);
  return { kind: "reply", text, assistant: [{ type: "text", text }], usage: { ...USAGE }, model: "fake-model" };
};

/** The JSON after the first line of the last tool result in the request. */
export function lastResult(request: CompletionRequest): Record<string, unknown> {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i];
    if (message?.role !== "tool_results") continue;
    const result = message.results.at(-1);
    if (result === undefined) continue;
    const newline = result.text.indexOf("\n");
    if (newline < 0) throw new Error("the last tool result has no line after its first");
    return JSON.parse(result.text.slice(newline + 1)) as Record<string, unknown>;
  }
  throw new Error("the request has no tool result");
}

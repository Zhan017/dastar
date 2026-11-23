import Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "./config.js";
import type { ChatMessage, Completion, CompletionRequest, LLMProvider, ToolCall, Usage } from "./provider.js";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type BetaToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type BetaToolInputSchema = Anthropic.Beta.Messages.BetaTool.InputSchema;
type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

/** The most tokens the model may write in one completion. */
export const MAX_TOKENS = 16_000;

/** The beta that lets the API retry a request the model declined on a substitute model, in the same call. */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** The models that take `fallbacks`: the others are sent neither the beta nor the field. */
export const FALLBACK_MODELS: ReadonlySet<string> = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

/** App text sent as a user message, marked as the app's and not the person's. */
export const APP_NOTICE = (text: string): string => `<app_notice>\n${text}\n</app_notice>`;

export type AnthropicProviderOptions = {
  apiKey: string;
  model: string;
  effort: Effort;
  /** The fetch the SDK sends its requests with: the runtime's own when absent. */
  fetch?: typeof fetch;
  /** The SDK's retries of a failed request: its own default when absent. */
  maxRetries?: number;
};

type Block = Record<string, unknown>;

const isBlock = (value: unknown): value is Block => typeof value === "object" && value !== null && !Array.isArray(value);

/** The index of the last `fallback` block in `content`, or -1 when the model never fell back. */
function lastFallback(content: readonly unknown[]): number {
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i];
    if (isBlock(block) && block["type"] === "fallback") return i;
  }
  return -1;
}

/**
 * The model's output as the next request carries it. After a fallback, the blocks before the last `fallback` block
 * are cut to the text and the server tools' paired calls and results: the thinking, tool calls and any other block
 * there were produced by the model that declined, and the API rejects a turn that carries them forward. The
 * `fallback` block stays where it is, and the blocks after it are unchanged. With no `fallback` block, the output is unchanged.
 */
export function echoContent(content: unknown[]): unknown[] {
  const cut = lastFallback(content);
  if (cut < 0) return content;

  const before = content.slice(0, cut);
  const serverCalls = new Set<string>();
  const answered = new Set<string>();
  for (const block of before) {
    if (!isBlock(block)) continue;
    if (block["type"] === "server_tool_use" && typeof block["id"] === "string") serverCalls.add(block["id"]);
    if (typeof block["tool_use_id"] === "string") answered.add(block["tool_use_id"]);
  }

  const kept = before.filter((block) => {
    if (!isBlock(block)) return false;
    if (block["type"] === "text") return true;
    if (block["type"] === "server_tool_use") return typeof block["id"] === "string" && answered.has(block["id"]);
    return typeof block["tool_use_id"] === "string" && serverCalls.has(block["tool_use_id"]);
  });
  return [...kept, ...content.slice(cut)];
}

const isPerson = (message: ChatMessage | undefined): boolean => message?.role === "user" || message?.role === "tool_results";
const isModel = (message: ChatMessage | undefined): boolean => message?.role === "assistant" || message?.role === "provider";

function buildMessages(messages: ChatMessage[]): BetaMessageParam[] {
  return messages.map((message, index): BetaMessageParam => {
    switch (message.role) {
      case "user":
        return { role: "user", content: message.text };
      case "assistant":
        return { role: "assistant", content: message.text };
      case "provider":
        return { role: "assistant", content: message.content as BetaContentBlockParam[] };
      case "tool_results":
        return {
          role: "user",
          content: message.results.map(
            (result): BetaToolResultBlockParam => ({ type: "tool_result", tool_use_id: result.id, content: result.text, is_error: result.isError }),
          ),
        };
      case "operator":
        // a system message goes where the model reads it as the app's: after the person's turn and before the model's.
        // Anywhere else (after model output, or before a user message, which a system message may not precede) it is a marked user message.
        return isPerson(messages[index - 1]) && (index === messages.length - 1 || isModel(messages[index + 1]))
          ? { role: "system", content: message.text }
          : { role: "user", content: APP_NOTICE(message.text) };
    }
  });
}

/** The conversation as the Messages API takes it. */
export function toRequestMessages(messages: ChatMessage[]): unknown[] {
  return buildMessages(messages);
}

function toCompletion(response: BetaMessage): Completion {
  const usage: Usage = {
    input: response.usage.input_tokens,
    output: response.usage.output_tokens,
    cacheRead: response.usage.cache_read_input_tokens ?? 0,
    cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
  };
  const common = { usage, model: response.model };

  // what the model that answered wrote: nothing before the last fallback block counts, as the call that declined is not the answer
  const after = response.content.slice(lastFallback(response.content) + 1);

  switch (response.stop_reason) {
    case "tool_use": {
      const calls = after.flatMap<ToolCall>((block) => (block.type === "tool_use" ? [{ id: block.id, name: block.name, input: block.input }] : []));
      if (calls.length === 0) throw new Error("the model stopped to use a tool but called none");
      return { kind: "tools", calls, assistant: echoContent(response.content), ...common };
    }
    case "end_turn": {
      const text = after.flatMap<string>((block) => (block.type === "text" ? [block.text] : [])).join("");
      return { kind: "reply", text, assistant: echoContent(response.content), ...common };
    }
    case "refusal":
      return { kind: "refused", ...common };
    case "max_tokens":
    case "model_context_window_exceeded":
      return { kind: "truncated", ...common };
    default:
      throw new Error(`the model stopped for a reason the agent does not handle: ${String(response.stop_reason)}`);
  }
}

/** The model behind the agent, reached through the Messages API with strict tools, a JSON reply and no thinking. */
export function createAnthropicProvider(opts: AnthropicProviderOptions): LLMProvider {
  const client = new Anthropic({ apiKey: opts.apiKey, fetch: opts.fetch, maxRetries: opts.maxRetries });
  const fallbacks = FALLBACK_MODELS.has(opts.model);

  return {
    async complete(request: CompletionRequest): Promise<Completion> {
      const body: CreateParams = {
        model: opts.model,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        messages: buildMessages(request.messages),
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as BetaToolInputSchema,
          strict: true,
        })),
        tool_choice: { type: "auto" },
        output_config: { effort: opts.effort, format: { type: "json_schema", schema: request.replySchema } },
        ...(fallbacks ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
      };
      return toCompletion(await client.beta.messages.create(body, { signal: request.signal }));
    },
  };
}

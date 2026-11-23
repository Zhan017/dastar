import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import type { ToolName } from "@dastar/agent-tools";
import { createDastarClient, type components } from "@dastar/client";
import { createDastar } from "@dastar/db";
import { createAnthropicProvider } from "../src/anthropic.js";
import { venueClock } from "../src/clock.js";
import { readAgentConfig } from "../src/config.js";
import { loadPrompt, renderContext, type LoadedPrompt } from "../src/prompt.js";
import type { ChatMessage, Completion, LLMProvider, ToolCall, ToolOutput, Usage } from "../src/provider.js";
import { REPLY_JSON_SCHEMA, parseReply } from "../src/reply.js";
import { capResult } from "../src/results.js";
import { checkStartup } from "../src/startup.js";
import { AGENT_INPUT_SCHEMAS, AGENT_TOOLS, validateArgs } from "../src/tools.js";
import type { AgentDeps } from "../src/turn.js";
import { runConversations, type ConversationReport } from "./conversations.js";

type Schemas = components["schemas"];

/** What one run of the probe came to: whether it passed, why not when it did not, and the requests it made, failed runs included. */
export type ProbeReport = { passed: boolean; reason?: string; requests: { kind: string; model: string; usage: Usage }[] };

/** The most requests a probe makes: the most calls to the model one turn makes. */
const MAX_REQUESTS = 6;

/** The longest a probe may take in all. */
const PROBE_TIMEOUT_MS = 10 * 60_000;

const VENUE = "Dastarkhan";
const ZONE = "Asia/Almaty";
const UNIT = "0199a000-0000-7000-8000-000000000103";
const VENUE_ID = "0199a000-0000-7000-8000-000000000001";
const RESERVATION = "0199a000-0000-7000-8000-0000000000f1";
const SLOT_MINUTES = 90;
const HOLD_MINUTES = 10;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isTool = (name: string): name is ToolName => Object.hasOwn(AGENT_INPUT_SCHEMAS, name);

/** 19:00 tomorrow at the venue as an instant: the venue's local date of `local` ("2026-11-23 15:00") plus one day, at `offset` ("+05:00") from UTC. */
function tomorrowEvening(local: string, offset: string): string {
  const day = new Date(`${local.slice(0, 10)}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return new Date(`${day.toISOString().slice(0, 10)}T19:00:00${offset}`).toISOString();
}

/** A range as the database writes it: "2064-01-07 16:00:00+00". */
const databaseTime = (instant: string): string => instant.replace("T", " ").replace(".000Z", "+00");

/** What a tool's result looks like to the model, built as the tools build theirs: a sentence, then the data behind it as JSON. */
const result = (sentence: string, structured: object): string => capResult(`${sentence}\n${JSON.stringify(structured)}`);

/** The probe's tools, answered without a database: one slot tomorrow at 19:00 at the venue, and one reservation held for ten minutes. */
function cannedAnswers(now: Date): (call: ToolCall) => ToolOutput {
  const clock = venueClock(now.toISOString(), ZONE);
  const startsAt = tomorrowEvening(clock.local, clock.offset);
  const endsAt = new Date(Date.parse(startsAt) + SLOT_MINUTES * 60_000).toISOString();
  const expiresAt = new Date(now.getTime() + HOLD_MINUTES * 60_000).toISOString();
  const assignment = { kind: "unit" as const, id: UNIT };
  const receipt = (status: string, version: number): Schemas["Receipt"] => ({ reservation_id: RESERVATION, status, version, audit_id: version, trace_id: "live-probe" });

  const text = (call: ToolCall): string => {
    switch (call.name) {
      case "search_availability": {
        const availability: Schemas["Availability"] = { slots: [{ starts_at: startsAt, duration_minutes: SLOT_MINUTES, assignment }], truncated: false };
        return result("Found 1 slot.", availability);
      }
      case "hold": {
        const created: Schemas["HoldResponse"] = { receipt: receipt("held", 1), hold_expires_at: expiresAt, replayed: false };
        return result(
          `Held reservation ${RESERVATION} until ${expiresAt}. It is not booked until a person confirms it through the venue; otherwise it expires then.`,
          created,
        );
      }
      case "get_reservation": {
        const reservation: Schemas["Reservation"] = {
          id: RESERVATION,
          venue_id: VENUE_ID,
          status: "held",
          stored_status: "held",
          party_size: 2,
          starts_at: startsAt,
          during: `["${databaseTime(startsAt)}","${databaseTime(endsAt)}")`,
          assignment: { kind: "unit", id: UNIT },
          hold_expires_at: expiresAt,
          version: 1,
          external_ref: null,
          history: [{ action: "hold", actor: "agent", at: now.toISOString() }],
        };
        return result(`Reservation ${RESERVATION} is held.`, reservation);
      }
      case "cancel": {
        const answer: Schemas["ReceiptResponse"] = { receipt: receipt("cancelled", 2) };
        return result(`Cancelled reservation ${RESERVATION}.`, answer);
      }
      default:
        throw new Error(`the probe has no canned answer for ${call.name}`);
    }
  };

  return (call) => ({ id: call.id, text: text(call), isError: false });
}

/** One short conversation with canned tool results and no database: every request accepted, at least one tool call whose arguments pass the full schema, a reply that parses, and a second reply after an app notice. */
export async function runProbe(provider: LLMProvider, prompt: LoadedPrompt, now: Date = new Date()): Promise<ProbeReport> {
  const clock = venueClock(now.toISOString(), ZONE);
  const messages: ChatMessage[] = [
    { role: "user", text: "Please hold a table for 2 tomorrow at 19:00." },
    { role: "operator", text: renderContext(prompt.contextTemplate, { utc: now.toISOString(), ...clock, zone: ZONE, venue: VENUE }) },
  ];
  const answer = cannedAnswers(now);
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const requests: ProbeReport["requests"] = [];
  const fail = (reason: string): ProbeReport => ({ passed: false, reason, requests });

  let toolCalled = false;
  let replied = false;
  for (let n = 0; n < MAX_REQUESTS; n++) {
    let completion: Completion;
    try {
      completion = await provider.complete({ system: prompt.system, messages: [...messages], tools: AGENT_TOOLS, replySchema: REPLY_JSON_SCHEMA, signal });
    } catch (error) {
      return fail(`the request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    requests.push({ kind: completion.kind, model: completion.model, usage: completion.usage });

    switch (completion.kind) {
      case "refused":
        return fail("the model refused");
      case "truncated":
        return fail("the model's output was cut off at its token limit");
      case "tools": {
        for (const { name, input } of completion.calls) {
          if (!isTool(name)) return fail(`a tool call named an unknown tool: ${name}`);
          const problem = validateArgs(AGENT_INPUT_SCHEMAS[name], input);
          if (problem !== null) return fail(`a tool call broke its schema: ${problem}`);
        }
        toolCalled = true;
        messages.push({ role: "provider", content: completion.assistant }, { role: "tool_results", results: completion.calls.map(answer) });
        break;
      }
      case "reply": {
        if (!replied && !toolCalled) return fail("no tool was called");
        if (parseReply(completion.text) === null) return fail("the reply did not parse");
        if (replied) return { passed: true, requests };
        replied = true;
        messages.push({ role: "provider", content: completion.assistant }, { role: "operator", text: "Reply again in one sentence." });
        break;
      }
    }
  }
  return fail(`no reply within ${MAX_REQUESTS} requests`);
}

/** What the API's answer to one request comes to, with nothing of the request and none of what the model wrote or called. */
export type ResponseRecord = {
  status: number;
  model?: string;
  stop_reason?: string | null;
  usage?: unknown;
  /** The `type` of each content block, in order. */
  blocks?: string[];
  error?: { type?: string; message?: string };
};

async function describeResponse(response: Response): Promise<ResponseRecord> {
  const record: ResponseRecord = { status: response.status };
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    return record;
  }
  if (!isRecord(body)) return record;

  if (response.ok) {
    const { model, stop_reason: stopReason, usage, content } = body;
    if (typeof model === "string") record.model = model;
    if (typeof stopReason === "string" || stopReason === null) record.stop_reason = stopReason;
    if (isRecord(usage)) record.usage = usage;
    if (Array.isArray(content)) record.blocks = content.flatMap((block): string[] => (isRecord(block) && typeof block["type"] === "string" ? [block["type"]] : []));
  } else {
    const failure = body["error"];
    if (isRecord(failure)) {
      const { type, message } = failure;
      const error: NonNullable<ResponseRecord["error"]> = {};
      if (typeof type === "string") error.type = type;
      if (typeof message === "string") error.message = message;
      record.error = error;
    }
  }
  return record;
}

/**
 * A fetch that keeps what each answer says about the model and the tokens, in `into`, and passes the answer on whole.
 * It reads a copy of the body, and never looks at the request: the API key travels in its headers.
 */
export function recordingFetch(base: typeof fetch, into: ResponseRecord[]): typeof fetch {
  return async (input, init) => {
    const response = await base(input, init);
    into.push(await describeResponse(response.clone()));
    return response;
  };
}

/** The model the live check asks when AGENT_MODEL is not set; the agent's own default. */
const DEFAULT_MODEL = "claude-opus-5-5";

/** What one turn cost, as one line. */
function turnLine(turn: ConversationReport["turns"][number], n: number): string {
  const { model, providerCalls, regenerations, fellBack, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = turn.record;
  return `  turn ${n} model=${model} provider_calls=${providerCalls} regenerations=${regenerations} fell_back=${fellBack} input=${inputTokens} output=${outputTokens} cache_read=${cacheReadTokens} cache_write=${cacheWriteTokens}`;
}

/** One conversation's line, and for each of its turns what it cost. */
function printConversation({ name, passed, reason, turns }: ConversationReport): void {
  console.log(`${name} ${passed ? "passed" : `failed: ${reason ?? "no reason given"}`}`);
  turns.forEach((turn, i) => {
    console.log(turnLine(turn, i + 1));
  });
}

/** The five conversations against the running API and the real model: one line for each, and for each turn what it cost. */
async function runConversationsMode(env: Record<string, string | undefined>): Promise<number> {
  const configured = readAgentConfig(env);
  if (!configured.ok) {
    console.error(`dastar-agent: ${configured.line}`);
    return 1;
  }
  const { config } = configured;
  const startedAt = new Date().toISOString();

  // pg-pool requires a listener for an idle client's error, or the process dies with it
  const pool = new Pool({ connectionString: config.databaseUrl, application_name: "dastar-agent-live" });
  pool.on("error", (error) => {
    console.error(`pool error: ${error.message}`);
  });
  const dastar = createDastar({ pool, cancellerConnectionString: config.databaseUrl });
  try {
    const checked = await checkStartup({ config, dastar });
    if (!checked.ok) {
      console.error(`dastar-agent: ${checked.line}`);
      return 1;
    }

    const responses: ResponseRecord[] = [];
    const deps: AgentDeps = {
      dastar,
      provider: createAnthropicProvider({ apiKey: config.anthropicApiKey, model: config.model, effort: config.effort, fetch: recordingFetch(globalThis.fetch, responses) }),
      agentClient: (sessionId) => createDastarClient({ baseUrl: config.dastarUrl, key: config.agentKey, session: sessionId }),
      demoClient: createDastarClient({ baseUrl: config.dastarUrl, key: config.demoConfirmKey }),
      venue: checked.venue,
      agentKeyId: config.agentKeyId,
      tokenKey: config.tokenKey,
      prompt: loadPrompt(),
    };
    const writeReport = (conversations: ConversationReport[]): void => {
      writeFileSync("agent-live.json", `${JSON.stringify({ mode: "conversations", model: config.model, started_at: startedAt, conversations, responses }, null, 2)}\n`);
    };
    // the artifact is rewritten and the lines printed as each conversation finishes, so a job cut off keeps every finished one
    const done: ConversationReport[] = [];
    const conversations = await runConversations(deps, { dastarUrl: config.dastarUrl }, (report) => {
      done.push(report);
      writeReport(done);
      printConversation(report);
    });

    writeReport(conversations);
    return conversations.every((conversation) => conversation.passed) ? 0 : 1;
  } finally {
    await dastar.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

async function main(args: string[], env: Record<string, string | undefined>): Promise<number> {
  const [mode] = args;
  if (mode === "conversations") return await runConversationsMode(env);
  if (mode !== "probe") {
    console.error("usage: live.ts probe | conversations");
    return 2;
  }

  const apiKey = (env["ANTHROPIC_API_KEY"] ?? "").trim();
  if (apiKey === "") {
    console.error("set ANTHROPIC_API_KEY");
    return 1;
  }
  const model = (env["AGENT_MODEL"] ?? "").trim() || DEFAULT_MODEL;

  const responses: ResponseRecord[] = [];
  const provider = createAnthropicProvider({ apiKey, model, effort: "medium", fetch: recordingFetch(globalThis.fetch, responses) });
  const report = await runProbe(provider, loadPrompt());

  writeFileSync("agent-live.json", `${JSON.stringify({ ...report, responses }, null, 2)}\n`);
  for (const { kind, model: answered, usage } of report.requests) {
    console.log(`${kind} ${answered} input=${usage.input} output=${usage.output} cache_read=${usage.cacheRead} cache_write=${usage.cacheWrite}`);
  }
  if (!report.passed) console.log(report.reason);
  return report.passed ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2), process.env);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}

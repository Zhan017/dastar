import { checkConfirmKey, checkCredential, keyCommand } from "@dastar/agent-tools";
import { createDastarClient, type DastarClientOptions } from "@dastar/client";
import type { Dastar, VenueProfile } from "@dastar/db";
import type { AgentConfig } from "./config.js";

export type StartupResult = { ok: true; venue: VenueProfile } | { ok: false; line: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The line for an API that cannot be reached: where, why, and the error's own code when it has one. */
function unreachable(origin: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && isObject(error.cause) ? error.cause : undefined;
  const code = cause?.["code"];
  return `could not reach ${origin}: ${message}${typeof code === "string" ? ` (${code})` : ""}`;
}

/** The line for a status the check does not expect, with the Problem's code when the API sent one. */
function unexpected(status: number, error: unknown): string {
  const code = isObject(error) ? error["code"] : undefined;
  return `checking the key failed: POST /v1/sessions answered HTTP ${status}${typeof code === "string" ? ` ${code}` : ""}`;
}

/**
 * The checks the agent makes before it serves, in order, each of which names what to fix: the venue exists; the agent's
 * key reads the venue's holds and can neither confirm nor administer; the demo key reads them and can confirm; the agent's
 * key opens a session, and AGENT_KEY_ID is that key's id. Returns the venue, or the first refusal line. A failure of the
 * database is not a refusal and is not caught.
 */
export async function checkStartup(input: { config: AgentConfig; dastar: Dastar; fetch?: DastarClientOptions["fetch"]; timeoutMs?: number }): Promise<StartupResult> {
  const { config, dastar } = input;
  const timeoutMs = input.timeoutMs ?? 10_000;
  const venueId = config.venueId;
  const viaFetch = input.fetch !== undefined ? { fetch: input.fetch } : {};

  const venue = await dastar.venueProfile(venueId);
  if (venue === null) return { ok: false, line: `venue ${venueId} does not exist` };

  const agent = createDastarClient({ baseUrl: config.dastarUrl, key: config.agentKey, ...viaFetch });
  const demo = createDastarClient({ baseUrl: config.dastarUrl, key: config.demoConfirmKey, ...viaFetch });

  const agentRefusal = await checkCredential(agent, { url: config.dastarUrl, venueId, fix: keyCommand(venueId, "agent") }, timeoutMs);
  if (agentRefusal !== null) return { ok: false, line: agentRefusal };
  const demoRefusal = await checkConfirmKey(demo, { url: config.dastarUrl, venueId, fix: keyCommand(venueId, "demo", "read,confirm") }, timeoutMs);
  if (demoRefusal !== null) return { ok: false, line: demoRefusal };

  // the session the key opens is the proof of whose key it is: the database says which key owns it
  const origin = new URL(config.dastarUrl).origin;
  const signal = AbortSignal.timeout(timeoutMs);
  let status: number;
  let problem: unknown;
  let sessionId: string | undefined;
  try {
    const opened = await agent.POST("/v1/sessions", { body: { venue_id: venueId }, signal });
    status = opened.response.status;
    problem = opened.error;
    sessionId = opened.data?.id;
  } catch (error) {
    if (signal.aborted) return { ok: false, line: `no answer from ${origin} within ${timeoutMs / 1000} seconds` };
    if (error instanceof SyntaxError) return { ok: false, line: "checking the key failed: POST /v1/sessions answered with a body that is not JSON" };
    return { ok: false, line: unreachable(origin, error) };
  }
  if (status !== 201) return { ok: false, line: unexpected(status, problem) };
  if (sessionId === undefined) return { ok: false, line: "checking the key failed: POST /v1/sessions answered HTTP 201 without a session id" };

  const owner = await dastar.sessions.sessionVenue({ sessionId, apiKeyId: config.agentKeyId });
  if (owner !== venueId) return { ok: false, line: "AGENT_KEY_ID is not the id of AGENT_KEY" };
  return { ok: true, venue };
}

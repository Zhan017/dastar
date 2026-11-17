import type { DastarClient } from "@dastar/client";

export type CredentialTarget = { url: string; venueId: string };

/** The reservation the confirm-token probe asks about: no reservation has this id, so a key that may confirm is told 404. */
const NO_RESERVATION = "00000000-0000-0000-0000-000000000000";

export const keyCommand = (venueId: string): string => `pnpm keys:create --label mcp --capabilities read,hold,cancel --venues ${venueId}`;

type Reply = { data?: unknown; error?: unknown; response: Response };

/** One request the start-up checks make. */
type Question = {
  method: string;
  /** The path as the OpenAPI document writes it. */
  path: string;
  run: (signal: AbortSignal) => Promise<Reply>;
};

type Probe = Question & {
  /** The one status that lets the key serve. */
  pass: number;
  /** What a status other than `pass` says when it is a known refusal, before the fix is appended. */
  refusals: Record<number, string>;
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function codeOf(error: unknown): string | undefined {
  const code = isObject(error) ? error["code"] : undefined;
  return typeof code === "string" ? code : undefined;
}

function unreachable(origin: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && isObject(error.cause) ? error.cause : undefined;
  const code = cause?.["code"];
  return `could not reach ${origin}: ${message}${typeof code === "string" ? ` (${code})` : ""}`;
}

/** What the check is about, as its failure lines name it. */
type Subject = "key" | "session";

function unexpected(subject: Subject, question: Question, status: number, error: unknown): string {
  const code = codeOf(error);
  return `checking the ${subject} failed: ${question.method} ${question.path} answered HTTP ${status}${code !== undefined ? ` ${code}` : ""}`;
}

/** Sends one question and gives its reply, or the line for an API that does not answer, answers with something that is not JSON, or cannot be reached. */
async function ask(origin: string, timeoutMs: number, subject: Subject, question: Question): Promise<{ reply: Reply } | { line: string }> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return { reply: await question.run(signal) };
  } catch (error) {
    if (signal.aborted) return { line: `no answer from ${origin} within ${timeoutMs / 1000} seconds` };
    if (error instanceof SyntaxError) return { line: `checking the ${subject} failed: ${question.method} ${question.path} answered with a body that is not JSON` };
    return { line: unreachable(origin, error) };
  }
}

function probesFor(client: DastarClient, venueId: string): Probe[] {
  return [
    {
      method: "GET",
      path: "/v1/venues/{id}/holds",
      run: (signal) => client.GET("/v1/venues/{id}/holds", { params: { path: { id: venueId } }, signal }),
      pass: 200,
      refusals: {
        401: "the key was not accepted: it is unknown or revoked",
        403: "the key lacks the read capability",
        404: `venue ${venueId} is not among the key's venues`,
      },
    },
    {
      method: "POST",
      path: "/v1/reservations/{id}/confirm-token",
      run: (signal) => client.POST("/v1/reservations/{id}/confirm-token", { params: { path: { id: NO_RESERVATION } }, body: {}, signal }),
      pass: 403,
      refusals: { 404: "the key can confirm reservations, and this server takes only keys that cannot" },
    },
    {
      method: "GET",
      path: "/admin/venues/{id}/keys",
      run: (signal) => client.GET("/admin/venues/{id}/keys", { params: { path: { id: venueId } }, signal }),
      pass: 403,
      refusals: { 200: "the key has the admin capability, and this server takes only keys without it" },
    },
  ];
}

/**
 * Asks the API three questions to learn whether the key may serve this venue: it must read the venue's holds,
 * be refused a confirm token, and be refused the venue's key listing. Returns `null` when it may, else the refusal line.
 */
export async function checkCredential(client: DastarClient, target: CredentialTarget, timeoutMs = 10_000): Promise<string | null> {
  const origin = new URL(target.url).origin;
  const fix = `create one with: ${keyCommand(target.venueId)}`;
  for (const probe of probesFor(client, target.venueId)) {
    const asked = await ask(origin, timeoutMs, "key", probe);
    if ("line" in asked) return asked.line;
    const { reply } = asked;
    const status = reply.response.status;
    if (status === probe.pass) continue;
    const refusal = probe.refusals[status];
    return refusal !== undefined ? `${refusal}; ${fix}` : unexpected("key", probe, status, reply.error);
  }
  return null;
}

export type SessionTarget = { url: string; venueId: string; sessionId: string };

/**
 * Asks the API whether the session is one of the key's own, opened for this venue. Returns `null` when it is, else the refusal line;
 * the API answers 404 for a session the key does not own, so a session of another key and one that does not exist read the same.
 */
export async function checkSession(client: DastarClient, target: SessionTarget, timeoutMs = 10_000): Promise<string | null> {
  const origin = new URL(target.url).origin;
  const question: Question = {
    method: "GET",
    path: "/v1/sessions/{id}",
    run: (signal) => client.GET("/v1/sessions/{id}", { params: { path: { id: target.sessionId } }, signal }),
  };
  const asked = await ask(origin, timeoutMs, "session", question);
  if ("line" in asked) return asked.line;
  const { reply } = asked;
  const status = reply.response.status;
  const refusal = `session ${target.sessionId} is not one of the key's sessions for venue ${target.venueId}`;
  if (status === 404) return refusal;
  if (status !== 200) return unexpected("session", question, status, reply.error);
  const venueId = isObject(reply.data) ? reply.data["venue_id"] : undefined;
  return venueId === target.venueId ? null : refusal;
}

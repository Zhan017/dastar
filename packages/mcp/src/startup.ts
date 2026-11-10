import type { DastarClient } from "@dastar/client";

export type CredentialTarget = { url: string; venueId: string };

/** The reservation the confirm-token probe asks about: no reservation has this id, so a key that may confirm is told 404. */
const NO_RESERVATION = "00000000-0000-0000-0000-000000000000";

export const keyCommand = (venueId: string): string => `pnpm keys:create --label mcp --capabilities read,hold,cancel --venues ${venueId}`;

type Reply = { error?: unknown; response: Response };

type Probe = {
  method: string;
  /** The path as the OpenAPI document writes it. */
  path: string;
  run: (signal: AbortSignal) => Promise<Reply>;
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

function unexpected(probe: Probe, status: number, error: unknown): string {
  const code = codeOf(error);
  return `checking the key failed: ${probe.method} ${probe.path} answered HTTP ${status}${code !== undefined ? ` ${code}` : ""}`;
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
    const signal = AbortSignal.timeout(timeoutMs);
    let reply: Reply;
    try {
      reply = await probe.run(signal);
    } catch (error) {
      return signal.aborted ? `no answer from ${origin} within ${timeoutMs / 1000} seconds` : unreachable(origin, error);
    }
    const status = reply.response.status;
    if (status === probe.pass) continue;
    const refusal = probe.refusals[status];
    return refusal !== undefined ? `${refusal}; ${fix}` : unexpected(probe, status, reply.error);
  }
  return null;
}

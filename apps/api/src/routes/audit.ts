import { createRoute, type OpenAPIHono, type z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { auditSession, scrubText, summarizeJudgments, type AuditReport, type AuditTurn, type Claim, type StoredTurn } from "@dastar/db";
import type { Deps, Env } from "../env.js";
import { requireCapability, requireKey, ownSessionVenue } from "../auth.js";
import { ApiProblem, bodyTooLarge } from "../problem.js";
import { AuditRequestSchema, AuditSchema, IdParam, problemResponses, type ClaimSchema, type TranscriptTurnSchema } from "../schemas.js";

type PostedClaim = z.infer<typeof ClaimSchema>;
type PostedTurn = z.infer<typeof TranscriptTurnSchema>;

/** A claim as the audit reads and the session stores it: its id in lower case and its quote scrubbed; the other fields as posted. */
function intakeClaim(c: PostedClaim): Claim {
  return {
    reservation_id: c.reservation_id.toLowerCase(),
    status: c.status,
    ...(c.starts_at !== undefined ? { starts_at: c.starts_at } : {}),
    ...(c.party_size !== undefined ? { party_size: c.party_size } : {}),
    ...(c.quote !== undefined ? { quote: scrubText(c.quote) } : {}),
  };
}

function intakeTurn(t: PostedTurn): AuditTurn {
  return {
    role: t.role,
    text: scrubText(t.text),
    ...(t.at !== undefined ? { at: t.at } : {}),
    ...(t.claims !== undefined ? { claims: t.claims.map(intakeClaim) } : {}),
  };
}

function storedTurn(t: AuditTurn, seq: number): StoredTurn {
  return { seq, role: t.role, content: t.text, claims: t.claims === undefined || t.claims.length === 0 ? null : t.claims, at: t.at ?? null };
}

export function register(app: OpenAPIHono<Env>, deps: Deps): void {
  const json = <S>(schema: S) => ({ "application/json": { schema } });

  const post = createRoute({
    method: "post", path: "/v1/sessions/{id}/audit",
    summary: "Post a transcript to an audit session of the calling key. The text and quotes are scrubbed of emails and numbers, stored in place of any earlier post's turns, and set against what the session's calls observed. Takes a body of up to 1 MiB. A reference session's transcript is written by the agent app alone, so it is refused. With judge: true, each assistant turn's text, the user turn before it, and the session's reservation ids, times and party sizes are sent to the operator's model provider to find statements no claim declared; the audit's undeclared is then \"pending\" until every assistant turn has a result, and a read reports what was found.",
    security: [{ Bearer: [] }], middleware: [requireCapability(deps, "read"), bodyLimit({ maxSize: 1024 * 1024, onError: bodyTooLarge })] as const,
    request: { params: IdParam, body: { required: true, content: json(AuditRequestSchema) } },
    responses: { 200: { description: "The audit of the transcript", content: json(AuditSchema) }, ...problemResponses },
  });
  app.openapi(post, async (c) => {
    const key = requireKey(c);
    const sessionId = c.req.valid("param").id.toLowerCase();
    const venueId = await ownSessionVenue(deps, key, sessionId);
    const session = await deps.dastar.sessions.getSession({ sessionId, venueId });
    if (session === null || session.kind === "reference") throw new ApiProblem(404, "not_found", "no such session");
    const body = c.req.valid("json");
    const judge = body.judge === true;
    const turns = body.turns.map(intakeTurn);
    const claimed = [...new Set(turns.flatMap((t) => (t.claims ?? []).map((claim) => claim.reservation_id)))];
    const inputs = await deps.dastar.sessions.auditInputs({ sessionId, venueId, reservationIds: claimed });
    const audited = auditSession({ sessionId, auditedAt: inputs.readAt, calls: inputs.calls, turns, current: inputs.current });
    const result: AuditReport = { ...audited, undeclared: judge ? "pending" : "not checked" };
    await deps.dastar.sessions.storeAudit({ sessionId, venueId, turns: turns.map(storedTurn), result, auditedAt: result.audited_at, judgeRequested: judge });
    return c.json(result, 200);
  });

  const read = createRoute({
    method: "get", path: "/v1/sessions/{id}/audit", summary: "Read the latest audit of a session of the calling key. When its post asked for the judge, undeclared is read from the assistant turns' results as they stand.",
    security: [{ Bearer: [] }], middleware: [requireCapability(deps, "read")] as const,
    request: { params: IdParam },
    responses: { 200: { description: "The latest audit", content: json(AuditSchema) }, ...problemResponses },
  });
  app.openapi(read, async (c) => {
    const key = requireKey(c);
    const sessionId = c.req.valid("param").id.toLowerCase();
    const venueId = await ownSessionVenue(deps, key, sessionId);
    const record = await deps.dastar.sessions.getAudit({ sessionId, venueId });
    if (record === null) throw new ApiProblem(404, "not_found", "the session has no audit yet");
    // stored by the post above, as an `AuditReport`
    const stored = record.audit as AuditReport;
    return c.json(record.judgeRequested ? { ...stored, undeclared: summarizeJudgments(record.judgments) } : stored, 200);
  });
}

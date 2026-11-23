import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { messageOf, runTurn, writeErrorLine, type AgentDeps, type LogError } from "./turn.js";

/** One line per request: what was asked and how it went, never a body. */
export type AgentLogEntry = { ts: string; method: string; path: string; status: number; duration_ms: number; trace_id: string };

type Env = { Variables: { traceId: string } };

type ProblemStatus = 400 | 404 | 409 | 422 | 500;
type ProblemCode = "validation" | "not_found" | "turn_in_progress" | "conversation_full" | "internal";

const TRACE_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_MESSAGE_CHARS = 2000;

/** A string with a surrogate half that has no other half: what `String.prototype.isWellFormed` refuses. */
const UNPAIRED_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** The only failure shape the app renders. Handlers throw it; `onError` turns it into Problem Details. */
class Problem extends Error {
  constructor(
    public readonly status: ProblemStatus,
    public readonly code: ProblemCode,
    detail?: string,
  ) {
    super(detail ?? code);
    this.name = "Problem";
  }
}

const refused = (detail: string): Problem => new Problem(400, "validation", detail);

/** RFC 9457 Problem Details in the reference API's shape; a 500 carries no detail. */
function problemResponse(c: Context<Env>, problem: Problem): Response {
  const body = {
    type: `https://dastar.dev/errors/${problem.code}`,
    title: problem.code.replaceAll("_", " "),
    status: problem.status,
    code: problem.code,
    ...(problem.status === 500 ? {} : { detail: problem.message }),
    trace_id: c.get("traceId"),
  };
  return c.newResponse(JSON.stringify(body), problem.status, { "content-type": "application/problem+json" });
}

/** The media type of a content-type header is `application/json`, whatever its case and parameters. */
function isJson(contentType: string | undefined): boolean {
  return contentType !== undefined && (contentType.split(";")[0] ?? "").trim().toLowerCase() === "application/json";
}

const ChatBody = z.strictObject({
  session_id: z.guid().optional(),
  message: z.string().max(MAX_MESSAGE_CHARS),
});

/** The refusals of a message the schema lets through. */
function messageRefusal(message: string): string | null {
  if (message.trim() === "") return "message: must not be empty";
  if (message.includes("\u0000")) return "message: must not contain U+0000";
  if (UNPAIRED_SURROGATE.test(message)) return "message: must be well-formed text";
  return null;
}

/**
 * The agent's HTTP face: `POST /demo/chat` takes one message (and the session it belongs to, once there is one) and
 * answers with the turn. Every failure is Problem Details with the request's trace id; the log line has no body.
 */
export function createAgentApp(deps: AgentDeps, opts: { log?: (entry: AgentLogEntry) => void; logError?: LogError } = {}): Hono<Env> {
  const log =
    opts.log ??
    ((entry: AgentLogEntry): void => {
      console.log(JSON.stringify(entry));
    });
  const logError = opts.logError ?? writeErrorLine;
  const app = new Hono<Env>();

  // trace id first, so every response and every log line carries one; never log a body
  app.use("*", async (c, next) => {
    const started = Date.now();
    const given = c.req.header("x-trace-id");
    c.set("traceId", given !== undefined && TRACE_RE.test(given) ? given : randomUUID());
    await next();
    c.res.headers.set("x-trace-id", c.get("traceId"));
    log({
      ts: new Date().toISOString(),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Date.now() - started,
      trace_id: c.get("traceId"),
    });
  });

  // the bound is applied before anything reads the body
  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => {
        throw refused("request body too large");
      },
    }),
  );

  // anything but a Problem is a fault of the agent's own: 500, traced by its id and message, and nothing about it reaches the person
  app.onError((error, c) => {
    if (error instanceof Problem) return problemResponse(c, error);
    logError("request failed", { trace_id: c.get("traceId"), error: messageOf(error) });
    return problemResponse(c, new Problem(500, "internal"));
  });
  app.notFound((c) => problemResponse(c, new Problem(404, "not_found", "no such route")));

  app.post("/demo/chat", async (c) => {
    if (!isJson(c.req.header("content-type"))) throw refused("the request body must be application/json");
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw refused("the request body is not valid JSON");
    }

    const parsed = ChatBody.safeParse(raw);
    if (!parsed.success) throw refused(parsed.error.issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`).join("; "));
    const { message } = parsed.data;
    const refusal = messageRefusal(message);
    if (refusal !== null) throw refused(refusal);
    const sessionId = parsed.data.session_id?.toLowerCase();

    const outcome = await runTurn(deps, { message, ...(sessionId !== undefined ? { sessionId } : {}) });
    if (!outcome.ok) return problemResponse(c, new Problem(outcome.status, outcome.code, outcome.detail));
    return c.newResponse(JSON.stringify(outcome.response), 200, { "content-type": "application/json" });
  });

  return app;
}

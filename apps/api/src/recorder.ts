import type { Context, Next } from "hono";
import type { RouteConfig, RouteHandler } from "@hono/zod-openapi";
import { MAX_SESSION_CALLS } from "@dastar/db";
import type { Deps, Env } from "./env.js";
import { assertVenueInScope, ownSessionVenue } from "./auth.js";
import { ApiProblem, fromUnknown } from "./problem.js";
import { recordedInput, recordedOutcome, type RecordedTool } from "./recorded-fields.js";

/** Where a call's venue comes from: the venue in its path, or the venue of the reservation it names. */
export type VenueSource = "path-venue" | "reservation";

type Plain = (c: Context<Env>, next: Next) => Response | Promise<Response>;
type Valid = (target: "param" | "json" | "header") => unknown;

/**
 * A route's handler that also records the call in the audit session the request names. A request without a
 * `dastar-session` header runs the handler and nothing else. One with it is checked against the key's own sessions
 * and the session's venue before the handler runs, recorded as started, and recorded as completed with its status,
 * its stored fields, and its receipt once the handler has answered; the completion is awaited, and its failure leaves the
 * response as it was. A refusal by validation or by a key's capability never reaches the handler, so it is not recorded.
 */
export function recorded<R extends RouteConfig>(deps: Deps, _route: R, tool: RecordedTool, source: VenueSource, handler: RouteHandler<R, Env>): RouteHandler<R, Env> {
  // the framework types a handler by its route; the wrapper runs it, and answers with its response, whatever the route
  const run = handler as unknown as Plain;
  const wrapped = async (c: Context<Env>, next: Next): Promise<Response> => {
    // a target the route does not declare reads as undefined
    const valid: Valid = (target) => (c.req as unknown as { valid: Valid }).valid(target);
    const sessionHeader = (valid("header") as { "dastar-session"?: string } | undefined)?.["dastar-session"];
    if (sessionHeader === undefined) return await run(c, next);

    const key = c.get("key");
    if (key === null) throw new ApiProblem(400, "validation", "Dastar-Session needs a bearer key");
    const sessionId = sessionHeader.toLowerCase();
    const sessionVenue = await ownSessionVenue(deps, key, sessionId);

    let venueId: string;
    const id = (valid("param") as { id: string }).id.toLowerCase();
    if (source === "path-venue") {
      assertVenueInScope(key, id);
      venueId = id;
    } else {
      // a reservation that is absent or outside the key's venues is the handler's 404, and is recorded in the session's venue
      const found = await deps.dastar.findReservationVenue(id);
      venueId = found !== null && (key.venueIds === null || key.venueIds.includes(found)) ? found : sessionVenue;
    }
    if (venueId !== sessionVenue) throw new ApiProblem(422, "session_venue_mismatch", "the call's venue is not the session's");

    const begun = await deps.dastar.sessions.beginCall({
      sessionId, venueId, tool, input: recordedInput(tool, { param: valid("param"), json: valid("json"), header: valid("header") }),
    });
    if (!begun.ok) {
      if (begun.reason === "full") throw new ApiProblem(422, "session_full", `the session has recorded ${MAX_SESSION_CALLS} calls, its limit`);
      throw new ApiProblem(404, "not_found", "no such session");
    }

    const finish = async (status: number, body: unknown): Promise<void> => {
      try {
        const { output, receipt } = recordedOutcome(tool, status, body);
        await deps.dastar.sessions.completeCall({ sessionId, venueId, callId: begun.callId, status, output, receipt });
      } catch {
        // the call stays pending, which the audit counts as an unknown outcome; the response is not changed by it
      }
    };

    let res: Response;
    try {
      res = await run(c, next);
    } catch (e) {
      const p = fromUnknown(e);
      await finish(p.status, { code: p.code });
      throw e;
    }
    await finish(res.status, await res.clone().json().catch(() => null));
    return res;
  };
  return wrapped as unknown as RouteHandler<R, Env>;
}

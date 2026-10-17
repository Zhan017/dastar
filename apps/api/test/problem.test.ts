import { describe, it, expect } from "vitest";
import { HTTPException } from "hono/http-exception";
import { DastarError } from "@dastar/db";
import { ApiProblem, STATUS_BY_CODE, problemFor, fromUnknown, problemBody } from "../src/problem.js";

describe("problem details", () => {
  it("maps every engine error code to a status", () => {
    const byStatus = (s: number) => Object.entries(STATUS_BY_CODE).filter(([, m]) => m.status === s).map(([c]) => c).sort();
    expect(byStatus(409)).toEqual(["assignment_in_use", "blackout", "blackout_conflict", "capacity_conflict", "hold_conflict", "hold_expired", "invalid_transition", "reservation_in_progress", "serialization_conflict", "token_requires_held", "version_conflict"]);
    expect(byStatus(422)).toEqual(["assignment_inactive", "assignment_mismatch", "combo_too_large", "duration_out_of_range", "force_too_large", "idempotency_mismatch", "invalid_input", "invalid_timezone", "outside_schedule", "party_does_not_fit", "range_mismatch", "window_too_large"]);
    expect(byStatus(403)).toEqual(["forbidden", "forbidden_write"]);
    expect(byStatus(404)).toEqual(["not_found"]);
    expect(byStatus(429)).toEqual(["too_many_live_holds"]);
    expect(byStatus(503)).toEqual(["overlap_set_too_large", "pool_timeout", "timeout"]);
    expect(byStatus(500)).toEqual(["actor_required", "audit_immutable", "combo_immutable", "idempotency_replay", "internal", "unit_rows_immutable", "venue_scope_violation"]);
  });

  it("adds Retry-After where the mapping says so", () => {
    expect(problemFor("serialization_conflict").headers).toEqual({ "Retry-After": "0" });
    expect(problemFor("too_many_live_holds").headers).toEqual({ "Retry-After": "1" });
    expect(problemFor("pool_timeout").headers).toEqual({ "Retry-After": "1" });
    expect(problemFor("hold_conflict").headers).toEqual({});
  });

  it("renders a body with type, code, status, trace id, and extensions; 500 omits detail", () => {
    const p = problemFor("hold_conflict", "taken", { replayed: true });
    expect(problemBody(p, "t1")).toEqual({ type: "https://dastar.dev/errors/hold_conflict", title: "hold conflict", status: 409, code: "hold_conflict", detail: "the assignment is already taken for an overlapping time range", trace_id: "t1", replayed: true });
    expect(problemBody(problemFor("internal", "secret cause"), "t2")).toEqual({ type: "https://dastar.dev/errors/internal", title: "internal", status: 500, code: "internal", trace_id: "t2" });
  });

  it("answers a venue scope violation as 500 with text the API owns, never the database's sentence", () => {
    const p = fromUnknown(new DastarError("venue_scope_violation", 'new row violates row-level security policy for table "reservation"', undefined, false, "42501"));
    expect(p).toMatchObject({ status: 500, code: "venue_scope_violation", message: "the operation reached outside its venue" });
    expect(problemBody(p, "t3")).toEqual({ type: "https://dastar.dev/errors/venue_scope_violation", title: "venue scope violation", status: 500, code: "venue_scope_violation", trace_id: "t3" });
  });

  it("converts unknown failures", () => {
    expect(fromUnknown(new DastarError("version_conflict", "v"))).toMatchObject({ status: 409, code: "version_conflict" });
    const own = new ApiProblem(401, "unauthorized");
    expect(fromUnknown(own)).toBe(own);
    expect(fromUnknown(new Error("boom"))).toMatchObject({ status: 500, code: "internal" });
    expect(fromUnknown(new HTTPException(415, { message: "unsupported" }))).toMatchObject({ status: 400, code: "validation" });
    expect(fromUnknown(new DastarError("party_does_not_fit", "party of 9 does not fit"))).toMatchObject({ status: 422, message: "party of 9 does not fit" });
  });
});

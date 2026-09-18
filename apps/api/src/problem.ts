import { DastarError, type DastarErrorCode } from "@dastar/db";

export type ProblemStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503;
export type ApiCode = DastarErrorCode | "validation" | "unauthorized" | "not_ready";

/** The only failure shape the API renders. Handlers throw it; `onError` turns it into Problem Details. */
export class ApiProblem extends Error {
  constructor(
    public readonly status: ProblemStatus,
    public readonly code: ApiCode,
    detail?: string,
    public readonly headers: Record<string, string> = {},
    public readonly extensions: Record<string, unknown> = {},
  ) {
    super(detail ?? code);
    this.name = "ApiProblem";
  }
}

type Mapping = { status: ProblemStatus; retryAfter?: string };

/** Exhaustive by construction: a new engine error code fails the type check until it is mapped. */
export const STATUS_BY_CODE = {
  hold_conflict: { status: 409 },
  hold_expired: { status: 409 },
  invalid_transition: { status: 409 },
  version_conflict: { status: 409 },
  blackout: { status: 409 },
  token_requires_held: { status: 409 },
  capacity_conflict: { status: 409 },
  serialization_conflict: { status: 409, retryAfter: "0" },
  idempotency_mismatch: { status: 422 },
  party_does_not_fit: { status: 422 },
  duration_out_of_range: { status: 422 },
  combo_too_large: { status: 422 },
  range_mismatch: { status: 422 },
  assignment_inactive: { status: 422 },
  assignment_mismatch: { status: 422 },
  forbidden: { status: 403 },
  forbidden_write: { status: 403 },
  not_found: { status: 404 },
  too_many_live_holds: { status: 429, retryAfter: "1" },
  overlap_set_too_large: { status: 503, retryAfter: "1" },
  pool_timeout: { status: 503, retryAfter: "1" },
  timeout: { status: 503, retryAfter: "1" },
  internal: { status: 500 },
  idempotency_replay: { status: 500 },
  audit_immutable: { status: 500 },
  unit_rows_immutable: { status: 500 },
  actor_required: { status: 500 },
  combo_immutable: { status: 500 },
} as const satisfies Record<DastarErrorCode, Mapping>;

export function problemFor(code: DastarErrorCode, detail?: string, extensions: Record<string, unknown> = {}): ApiProblem {
  const m: Mapping = STATUS_BY_CODE[code];
  return new ApiProblem(m.status, code, detail, m.retryAfter === undefined ? {} : { "Retry-After": m.retryAfter }, extensions);
}

export function fromUnknown(e: unknown): ApiProblem {
  if (e instanceof ApiProblem) return e;
  if (e instanceof DastarError) return problemFor(e.code, e.message);
  return new ApiProblem(500, "internal");
}

export function problemBody(p: ApiProblem, traceId: string): Record<string, unknown> {
  return {
    type: `https://dastar.dev/errors/${p.code}`,
    title: p.code.replaceAll("_", " "),
    status: p.status,
    code: p.code,
    ...(p.status === 500 ? {} : { detail: p.message }),
    trace_id: traceId,
    ...p.extensions,
  };
}

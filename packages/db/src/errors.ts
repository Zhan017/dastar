export type DastarErrorCode =
  | "hold_conflict" | "hold_expired" | "idempotency_replay" | "idempotency_mismatch"
  | "party_does_not_fit" | "audit_immutable" | "invalid_transition" | "unit_rows_immutable"
  | "actor_required" | "range_mismatch" | "blackout" | "assignment_mismatch" | "combo_immutable"
  | "capacity_conflict" | "token_requires_held" | "forbidden_write" | "serialization_conflict"
  | "timeout" | "duration_out_of_range" | "combo_too_large" | "version_conflict" | "not_found"
  | "forbidden" | "too_many_live_holds" | "overlap_set_too_large" | "assignment_inactive";

export class DastarError extends Error {
  constructor(
    public readonly code: DastarErrorCode,
    message: string,
    public readonly detail?: string,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "DastarError";
  }
}

const BY_SQLSTATE: Record<string, DastarErrorCode> = {
  "23P01": "hold_conflict",
  DA001: "hold_expired",
  DA002: "idempotency_mismatch",
  DA003: "party_does_not_fit",
  DA004: "audit_immutable",
  DA005: "invalid_transition",
  DA006: "unit_rows_immutable",
  DA007: "actor_required",
  DA008: "range_mismatch",
  DA009: "blackout",
  DA010: "assignment_mismatch",
  DA011: "combo_immutable",
  DA012: "capacity_conflict",
  DA013: "token_requires_held",
  "42501": "forbidden_write",
};

/** Domain outcomes that are stored under the idempotency key (spec D30). */
export const STORED_OUTCOMES: ReadonlySet<DastarErrorCode> = new Set<DastarErrorCode>([
  "hold_conflict", "party_does_not_fit", "blackout", "duration_out_of_range",
]);

export function mapPgError(e: unknown): DastarError | null {
  const pe = e as { code?: string; message?: string; detail?: string; constraint?: string };
  if (!pe || typeof pe.code !== "string") return null;
  if (pe.code === "40P01" || pe.code === "40001") return new DastarError("serialization_conflict", pe.message ?? pe.code, pe.detail, true);
  if (pe.code === "57014") return new DastarError("timeout", pe.message ?? pe.code, pe.detail, true);
  if (pe.code === "23514") {
    if (pe.constraint === "duration_out_of_range") return new DastarError("duration_out_of_range", pe.message ?? "", pe.detail);
    if (pe.constraint === "combo_too_large") return new DastarError("combo_too_large", pe.message ?? "", pe.detail);
  }
  const code = BY_SQLSTATE[pe.code];
  return code ? new DastarError(code, pe.message ?? pe.code, pe.detail) : null;
}

export function asDastarError(e: unknown): DastarError {
  if (e instanceof DastarError) return e;
  return mapPgError(e) ?? (e instanceof Error ? Object.assign(new DastarError("forbidden_write", e.message), { cause: e }) : new DastarError("forbidden_write", String(e)));
}

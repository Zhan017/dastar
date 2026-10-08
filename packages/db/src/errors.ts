import { DastarError, type DastarErrorCode } from "@dastar/core";

export { DastarError, STORED_OUTCOMES, type DastarErrorCode } from "@dastar/core";

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

export function mapPgError(e: unknown): DastarError | null {
  const pe = e as { code?: string; message?: string; detail?: string; constraint?: string };
  if (!pe || typeof pe.code !== "string") return null;
  if (pe.code === "40P01" || pe.code === "40001") return new DastarError("serialization_conflict", pe.message ?? pe.code, pe.detail, true, pe.code);
  if (pe.code === "57014") return new DastarError("timeout", pe.message ?? pe.code, pe.detail, true, pe.code);
  if (pe.code === "23514") {
    if (pe.constraint === "duration_out_of_range") return new DastarError("duration_out_of_range", pe.message ?? "", pe.detail, false, pe.code);
    if (pe.constraint === "combo_too_large") return new DastarError("combo_too_large", pe.message ?? "", pe.detail, false, pe.code);
  }
  // the first statement of a hold claims an idempotency row that references the venue
  if (pe.code === "23503" && pe.constraint === "idempotency_venue_id_fkey") return new DastarError("not_found", "venue not found", pe.detail, false, pe.code);
  const code = BY_SQLSTATE[pe.code];
  return code ? new DastarError(code, pe.message ?? pe.code, pe.detail, false, pe.code) : null;
}

export function asDastarError(e: unknown): DastarError {
  if (e instanceof DastarError) return e;
  return mapPgError(e) ?? (e instanceof Error ? Object.assign(new DastarError("internal", e.message), { cause: e }) : new DastarError("internal", String(e)));
}

export type DastarErrorCode =
  | "hold_conflict" | "hold_expired" | "idempotency_replay" | "idempotency_mismatch"
  | "party_does_not_fit" | "audit_immutable" | "invalid_transition" | "unit_rows_immutable"
  | "actor_required" | "range_mismatch" | "blackout" | "assignment_mismatch" | "combo_immutable"
  | "capacity_conflict" | "token_requires_held" | "forbidden_write" | "serialization_conflict"
  | "timeout" | "duration_out_of_range" | "combo_too_large" | "version_conflict" | "not_found"
  | "forbidden" | "too_many_live_holds" | "overlap_set_too_large" | "assignment_inactive"
  | "pool_timeout" | "internal";

export class DastarError extends Error {
  constructor(
    public readonly code: DastarErrorCode,
    message: string,
    public readonly detail?: string,
    public readonly retryable: boolean = false,
    public readonly sqlstate?: string,
  ) {
    super(message);
    this.name = "DastarError";
  }
}

/** Domain outcomes that are stored under the idempotency key (spec D30). */
export const STORED_OUTCOMES: ReadonlySet<DastarErrorCode> = new Set<DastarErrorCode>([
  "hold_conflict", "party_does_not_fit", "blackout",
]);

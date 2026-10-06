/**
 * The workload bounds of the system design, section 6.5. The database enforces the ones it can with CHECK
 * constraints, and the hold command the policy checks; these values are what both enforce, stated once.
 */
export const BOUNDS = {
  /** Units in a combination; `combo_too_large` outside it. */
  comboUnits: { min: 2, max: 6 },
  /** Booking duration; `duration_out_of_range` outside it. */
  durationMinutes: { min: 5, max: 720 },
  /** Occupying reservations one hold may lock; `overlap_set_too_large` above it. */
  overlapSet: 64,
  /** A venue's hold TTL. */
  holdTtlSeconds: { min: 60, max: 3_600 },
  /** A venue's live-holds cap per actor; `too_many_live_holds` above it. */
  liveHoldsPerActor: { default: 5, max: 100 },
} as const;

# ADR 2: Per-unit advisory locks and one outer hold transaction

Status: accepted. Design decisions D20 and D39.

## Context

The exclusion constraint (ADR 1) makes a double booking impossible, but it does not make concurrent holds well behaved. A hold must also clear expired holds that overlap it, honor its idempotency key across retries, and coexist with confirmations and capacity edits on the same units. Early designs locked rows phase by phase, or expired dead holds with `skip locked`; reviews found deadlocks between holds sharing a combo, false conflicts, and a retained expiry lock waiting on a fresh insert.

## Decision

- **One outer transaction per hold** (D20). It claims the idempotency key, takes the unit locks, locks every occupying reservation that overlaps the requested units in reservation-id order, expires the dead ones among them, makes a single booking attempt under a savepoint, and stores the outcome under the still-owned key before committing. A deadlock or serialization failure retries the whole transaction once.
- **A transaction-level advisory lock per unit** (D39), keyed by unit id and taken in sorted unit order: by the hold command at the start of its transaction, by the fit trigger on reservation insert, and by the capacity trigger on unit update. Confirmation takes the same locks before its row lock (`0006_confirm_fit.sql`).

## Alternatives considered

- **Lock ordering argued per phase or per discovering unit.** Each review found an interleaving the argument missed.
- **Skip-locked inline expiry.** Produced false conflicts and could deadlock two holds sharing units.
- **Accepting deadlocks as normal and retrying.** Turns a correctness question into a latency tail.

## Consequences

- Two holds that share a unit never run concurrently, so the overlap set a hold reads cannot change under it, and the booking insert should never wait. The named interleavings (`packages/db/test/interleavings.test.ts`), a real two-connection deadlock exercising the retry (`hold-retry.test.ts`), and the capacity-versus-confirmation races (`capacity-expiry.test.ts`) cover the protocol; the harness asserts zero deadlocks under mixed load.
- **The cost is real and accepted:** holds on the same unit for different, non-overlapping dates are serialized for the length of a hold transaction. The provisional run (`docs/design/results-2026-09-28-provisional.md`) measured the unit-lock phase at a p99 of 6 ms at the target rate and 9 ms at twice it, against a limit of 100 ms; the target-hardware run decides whether it stands.
- A finer lock, by unit and time bucket for instance, is not a drop-in replacement: it must keep coordination for overlapping ranges, multi-unit bookings, the overlap lock set, expiry, and capacity edits. It is considered only if measurements show the cost matters (6.5).
- The overlap set is bounded (64 rows, `overlap_set_too_large`), so a hold's lock footprint cannot grow without limit.

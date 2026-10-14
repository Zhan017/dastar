# Correctness

What the database enforces, how, and which test would show it broken. Guarantees are properties the schema is designed to enforce and the tests confirm or falsify. Hypotheses are runtime properties that only measurement settles.

## Invariants

| # | Invariant | Enforcement | Error | Tests |
|---|---|---|---|---|
| 1 | No unit is occupied by two reservations with overlapping ranges | Exclusion constraint on active unit rows (`reservation_unit_no_overlap`) | `hold_conflict` (23P01) | `attack.test.ts`, `hold.test.ts`, harness race |
| 2 | An expired hold cannot be confirmed | Expiry guard trigger, judged by database time at the confirming transaction's start | `hold_expired` (DA001) | `guards.test.ts`, `attack.test.ts`, `lifecycle.test.ts` |
| 3 | Same venue, actor, key, and payload returns the same outcome within 24 hours and creates nothing; a different payload is rejected | Primary key on (venue, actor, key), payload hash, key owned by one transaction from claim to stored outcome | `idempotency_mismatch` (DA002) | `idempotency.test.ts` |
| 4 | The assignment fits the party and keeps fitting while the reservation is live | Fit trigger on insert and on the transition to confirmed; capacity guard on unit updates, both under the unit's advisory lock; combo capacities immutable | `party_does_not_fit` (DA003), `capacity_conflict` (DA012) | `guards.test.ts`, `capacity-expiry.test.ts`, `interleavings.test.ts` |
| 5 | The audit log is append-only and written only by its trigger | Row and statement triggers; SELECT-only grant; definer-rights writer | `audit_immutable` (DA004), 42501 | `attack.test.ts` |
| 6 | Every transition writes an audit row | After trigger on reservation | none | `lifecycle.test.ts`, `transitions.test.ts` |
| 7 | Only transitions in the state table happen | Transition trigger | `invalid_transition` (DA005) | `transitions.test.ts`, every pair |
| 8 | A unit row is active exactly while its reservation occupies the unit; completed rows stay active as history | Definer-rights sync trigger is the only writer of `active`; no UPDATE or DELETE for the application role | `unit_rows_immutable` (DA006), 42501 | `attack.test.ts`, `lifecycle.test.ts` |
| 9 | A reservation's unit rows are exactly its assignment's members and never change | Deferred membership trigger at commit, composite foreign keys, combo immutability | `assignment_mismatch` (DA010), `combo_immutable` (DA011) | `guards.test.ts`, `attack.test.ts`, `venue-isolation.test.ts` |
| 10 | A transaction bound to one venue reads and writes only that venue's rows, and a transaction bound to none reads and writes nothing, apart from the two owner-run lookups of a reservation's venue | Row-level security on every venue-scoped table for the application role, keyed on the transaction-local `dastar.venue_id` | A write is refused, usually as `venue_scope_violation` (42501); a read or update sees no rows | `venue-isolation.test.ts` |
| 11 | A live reservation never overlaps an active blackout of its venue | Owner-run guards under a venue-level advisory lock: a reservation insert and a hold's confirmation take it shared and are refused inside an active blackout; a blackout write takes it exclusively and is refused while a live reservation's active unit row overlaps it | `blackout` (DA009) on a hold, stored as its outcome, and on a confirmation; `blackout_conflict` (DA014) on a blackout write | `schedules-blackouts.test.ts` |

Supporting guards: `actor_required` (DA007), `range_mismatch` (DA008), `token_requires_held` (DA013), `forbidden_write` (42501).

## Venue isolation

Invariant 10 sits behind boundary B ([SECURITY.md](SECURITY.md)): the caller declares the venue, and the database confines the transaction to it without being able to tell a true declaration from a false one. Invariants 1, 2, 4, 5, 7, 8, 9, and 11 sit behind boundary A and do not depend on that declaration. The triggers that read other rows to enforce them (the fit check, the capacity guard, the unit-row insert guard, the membership check, and the two blackout guards) run with the owner's rights, so row-level security, which follows a setting the caller controls, never changes what they see; `venue-isolation.test.ts` clears the setting before commit and still gets `assignment_mismatch`. The hold's overlap query reads `dastar.occupancy`, an owner view with the policies' own filter, because row-level security would otherwise keep the range index out of the plan; the same test pins the index condition.

## Effective status

Reads return `expired` for a stored `held` row whose expiry has passed by database time, whether or not the sweeper has reached it. The stored column catches up when the sweeper or a hold's overlap pass expires the row.

## Confirmation near expiry

Postgres evaluates `now()` at transaction start. A confirmation that begins before a hold's expiry and then waits on a lock is judged by its start time, so it succeeds even if the wall clock passed the expiry during the wait. The wait can include the unit lock as well as the row lock. This is a bounded grace, not a defect. A capacity edit cannot exploit it: an edit and a confirmation on the same unit serialize on the unit lock, and whichever runs second sees the other's committed state, so the edit is refused or the confirmation is refused (`capacity-expiry.test.ts`). A blackout write judges a hold by its own clock, so it can admit a blackout over a hold that a confirmation begun before the expiry still sees as held. The confirmation therefore takes the venue lock shared and checks the blackouts under it, and whichever of the two runs second sees the other: the confirmation is refused (`blackout`), or the blackout write sees a confirmed reservation (`blackout_conflict`) (`schedules-blackouts.test.ts`).

## Lock order

| Writer | Locks, in order |
|---|---|
| hold | venue advisory lock (shared) → unit advisory locks (sorted) → overlapping reservation rows (`order by id for update`) → own inserts |
| confirm | venue advisory lock (shared) → unit advisory locks (sorted) → own reservation row |
| capacity edit | the unit row itself (held by the UPDATE) → unit advisory lock → reads of reservations, no reservation row locks → the venue row (config version) |
| cancel, seat, complete, token mint | own reservation row only |
| batch expiry | reservation rows in batch, `skip locked`, no unit locks |
| blackout write | on an update, the blackout row itself (held by the UPDATE) → venue advisory lock (exclusive) → reads of unit rows and reservations, no locks on them → the venue row (config version) |

Every command acquires resources in this order and never returns to an earlier stage, which is why the reference paths are designed not to deadlock. This is a hypothesis with named tests (`interleavings.test.ts`, `capacity-expiry.test.ts`, and for the venue lock `schedules-blackouts.test.ts`), not a proof; a mixed-load run is not yet part of the suite. Deadlock and serialization errors stay mapped to `serialization_conflict`, and the hold command retries once (`hold-retry.test.ts`). The assignment columns are immutable for the application role, which is what lets confirm look up the units to lock before it locks the row.

A hold's foreign-key checks take only a key-share lock on the venue row, which the config-version update does not conflict with, so a blackout write waits on no lock a hold holds once it has the venue lock. A transaction that writes more than one blackout, or a unit, combo, or schedule before a blackout, must take the venue lock exclusively before its first write; otherwise it can wait on the venue lock while holding a row that a holder of that lock waits on, directly or through another writer. No command writes configuration yet; the admin routes will take the venue lock first.

## Guarantees and hypotheses

Guarantees G1 to G4 and hypotheses H1 to H6 are defined in the system design, section 7.1. Their measured status is recorded in the results files under `docs/design/`.

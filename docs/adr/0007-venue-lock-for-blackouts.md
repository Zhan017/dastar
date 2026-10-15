# ADR 7: A venue-level lock for blackouts

Status: accepted. Invariant 11; design section 6 (schedule and blackout), 10.1, and 10.2.

## Context

A blackout closes a whole venue for a range. A reservation must never be live inside an active blackout, which takes two checks: a reservation insert must see the blackouts, and a blackout write must see the live reservations. Each check alone misses a concurrent writer of the other kind. A hold in flight cannot see a blackout that has not committed, and a blackout write cannot see a hold that has not committed, so both can commit and leave a live reservation inside a closure. Confirmation adds a third case: a blackout write judges a hold by its own clock, while a confirmation is judged by its own start time, so a confirmation begun just before a hold's expiry can follow a blackout write that judged the same hold expired.

The per-unit locks of ADR 2 do not help. A blackout covers every unit of its venue, including units created while it is being written.

## Decision

- **One advisory lock per venue,** keyed by `dastar.venue_lock_key(venue)`. A hold and a confirmation take it shared, before their unit locks; a blackout write takes it exclusively. Holds and confirmations never block each other on it.
- **Two owner-run guards under that lock.** A reservation insert, and a reservation's transition from held to confirmed, take the shared lock (a no-op for a command that already holds it) and are refused inside an active blackout of the venue (`blackout`, DA009, stored as a hold's outcome). A blackout write takes the exclusive lock and is refused while a live reservation of the venue has an active unit row overlapping it (`blackout_conflict`, DA014).
- **Whichever commits second sees the other.** A blackout write waits for every hold and confirmation in flight in its venue, then sees the reservations they made or confirmed. A hold or confirmation that starts behind a blackout write waits for it, then sees the blackout.
- **Lock order:** venue lock, then unit locks, then reservation rows. A blackout write in reject mode takes no unit lock and no reservation row lock. Its row locks are the blackout row an update holds, taken before the venue lock, and the venue row its config-version trigger updates, taken after it; a hold's foreign-key checks take only a key-share lock on the venue row, which does not conflict, so a single blackout write is designed not to form a cycle with a hold. A transaction that writes more than one blackout, or a unit, combo, or schedule before a blackout, takes the venue lock exclusively before its first write.

## Alternatives considered

- **Lock every unit of the venue on a blackout write.** No change to the hold, but a unit created during the write is not covered, and a large venue needs one lock per unit.
- **Check only in the command that writes blackouts.** A writer that bypasses the command could still strand a reservation, and a hold would still not see an uncommitted blackout.
- **Serializable isolation for blackout writes.** Holds run at read committed, and serializable conflict detection only works between serializable transactions.

## Consequences

- Every hold and every confirmation takes one more advisory lock, shared, before its unit locks.
- A blackout write waits for the holds and confirmations in flight in its venue and holds up new ones there until it commits. Blackouts are rare administrative writes.
- Force mode for blackouts (admin routes) will cancel the stranded reservations under the exclusive lock before writing; holds and confirmations take the venue lock before any row lock, so they wait without holding anything a cancellation needs.
- The lock-order argument is a hypothesis with named two-connection tests in `schedules-blackouts.test.ts`: a blackout write behind a hold in flight, a hold behind a blackout write, a hold holding its venue and unit locks with a blackout write waiting (no deadlock, no retry), two holds sharing the venue lock, a blackout write behind a confirmation and a confirmation behind a blackout write, both with the blackout written on a clock past the hold's expiry, and an insert that bypasses the hold waiting on the guard's own lock.

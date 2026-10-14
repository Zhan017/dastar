# ADR 7: A venue-level lock for blackouts

Status: accepted. Invariant 11; design section 6 (schedule and blackout) and 10.1 step 6.

## Context

A blackout closes a whole venue for a range. A reservation must never be live inside an active blackout, which takes two checks: a reservation insert must see the blackouts, and a blackout write must see the live reservations. Each check alone misses a concurrent writer of the other kind. A hold in flight cannot see a blackout that has not committed, and a blackout write cannot see a hold that has not committed, so both can commit and leave a live reservation inside a closure.

The per-unit locks of ADR 2 do not help. A blackout covers every unit of its venue, including units created while it is being written.

## Decision

- **One advisory lock per venue,** keyed by `dastar.venue_lock_key(venue)`. A hold takes it shared, before its unit locks; a blackout write takes it exclusively. Holds never block each other on it.
- **Two owner-run guards under that lock.** A reservation insert takes the shared lock (a no-op for a hold that already holds it) and is refused inside an active blackout of its venue (`blackout`, DA009, stored as the hold's outcome). A blackout write takes the exclusive lock and is refused while a live reservation of the venue has an active unit row overlapping it (`blackout_conflict`, DA014).
- **Whichever commits second sees the other.** A blackout write waits for every hold in flight in its venue, then sees the reservations they made. A hold that starts behind a blackout write waits for it, then sees the blackout.
- **Lock order:** venue lock, then unit locks, then reservation rows. A blackout write in reject mode takes no unit lock and no row lock, so it cannot form a cycle with a hold.

## Alternatives considered

- **Lock every unit of the venue on a blackout write.** No change to the hold, but a unit created during the write is not covered, and a large venue needs one lock per unit.
- **Check only in the command that writes blackouts.** A writer that bypasses the command could still strand a reservation, and a hold would still not see an uncommitted blackout.
- **Serializable isolation for blackout writes.** Holds run at read committed, and serializable conflict detection only works between serializable transactions.

## Consequences

- Every hold takes one more advisory lock, shared, before its unit locks.
- A blackout write waits for the holds in flight in its venue and holds up new holds there until it commits. Blackouts are rare administrative writes.
- Force mode for blackouts (admin routes) will cancel the stranded reservations under the exclusive lock before writing; holds take the venue lock before any row lock, so they wait without holding anything a cancellation needs.
- The lock-order argument is a hypothesis with named two-connection tests in `schedules-blackouts.test.ts`: a blackout write behind a hold in flight, a hold behind a blackout write, a hold holding its venue and unit locks with a blackout write waiting (no deadlock, no retry), and two holds sharing the venue lock.

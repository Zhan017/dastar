# ADR 1: The database enforces the invariants

Status: accepted. Design decisions D2 and D37.

## Context

Dastar's claim is that two reservations can never hold the same unit over overlapping time, however its callers behave. A check made in application code can be skipped by a second code path, raced by a concurrent request, or bypassed by anyone with a SQL connection. The plain check-then-insert pattern shows the race directly: the harness's `naive` command lets 50 workers each confirm a slot is free and then insert, and all 50 commit.

## Decision

Every invariant is a constraint or a trigger in Postgres; TypeScript orchestrates and maps errors, and is never the last line of defense.

- An assignment is one reservation with one `reservation_unit` row per unit. No two active rows for the same unit may overlap: `exclude using gist (unit_id with =, during with &&) where (active)`, with half-open ranges so back-to-back bookings fit.
- A deferred constraint trigger checks at commit that a reservation's unit rows are exactly its assignment's members.
- Triggers enforce the state table, the expiry guard, party fit, append-only audit, the actor requirement, and combo immutability; each failure has its own SQLSTATE (`DA001` to `DA013`), which the engine maps to a stable error code.
- The application role `dastar_app` gets table and column privileges narrow enough that it cannot drop the constraint, edit audit rows, or flip a unit row's `active` flag; only security-definer triggers write those.

The model is exclusive units, a table, a room, a vehicle, and fixed combinations of them (D37). Quantity inventory, fifty seats sold from one pool, is out of scope: an exclusion constraint cannot express a sum of quantities.

## Alternatives considered

- **Guards in TypeScript.** Simple to write, but they hold only for callers that go through them, and the race between check and insert remains.
- **PL/pgSQL commands.** Moves the logic into the database without making it a constraint; a second function or a raw statement can still violate it.

## Consequences

- The guarantee holds against an adversarial application role, which is what lets the attack suite exist: `packages/db/test/attack.test.ts` connects as `dastar_app` and checks that each violation is refused with its SQLSTATE. `CORRECTNESS.md` lists every invariant with its guard and its test.
- The boundary is stated, not implied: database owners remain trusted (`SECURITY.md`), and invariants 3 and 10 depend on context the host declares.
- Schema changes need care: every guard is SQL, and a migration that weakens one weakens the product. The migration runner refuses an applied migration whose checksum changed, and restricts nontransactional files to validated concurrent index builds (D47), partly for this reason.
- Ticketing-style inventory needs a different model, not a flag on this one.

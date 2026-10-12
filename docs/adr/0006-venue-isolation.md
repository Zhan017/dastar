# ADR 6: Venue isolation with row-level security

Status: accepted. Design decision D26, section 6.1, invariant 10.

## Context

Every venue-scoped table is shared by all venues, and the application role can address every venue. Invariant 10 asks the database to contain a bug that mixes venues inside one transaction: bound to one venue, a transaction reads and writes only that venue's rows; bound to none, it reads and writes nothing. The design binds the venue through a transaction-local setting, `dastar.venue_id`, which the engine sets at the start of every command.

Three things the design left open came up when the policies were written:

- Routes addressed by a reservation id carry no venue, a key may be scoped to several venues or to all of them, and confirmation by token has no key. Something has to find the venue before a transaction can bind it.
- Postgres lets a query condition run ahead of a row-level security policy only if its operator is leakproof, and the range-overlap operator is not. Measured with 200 bookings on one unit, the hold's overlap query lost its range index under row-level security and read every active row of that unit, and a venue-wide occupancy query fell from an index-only scan to a sequential scan.
- The triggers that enforce invariants 4 and 9 read other rows. Under row-level security they would see what the caller's setting allows, and the membership check runs at commit, after a hostile caller could have cleared the setting.

## Decision

- **Policies.** Each venue-scoped table enables row-level security with one policy for `dastar_app` that compares its venue with `nullif(current_setting('dastar.venue_id', true), '')::uuid` for reads and writes, and a read policy for `dastar_readonly` over every venue. `dastar_worker` keeps `BYPASSRLS` for the sweeper. Security is not forced, so the owner's migrations and definer-rights functions are unaffected. A role without a policy reads nothing.
- **Venue lookups.** Two owner-run functions answer what the reference API read before row-level security: `dastar.reservation_venue(id)`, a reservation's venue, and `dastar.reservation_token(id)`, its venue and token hash in one call, so an absent reservation and a wrong token still do the same work. The caller checks the key's scope, then binds the venue it found. Every engine entry point declares its venue: `getReservation` takes one, and `findReservationVenue` serves a host that holds only an id.
- **Range reads through an owner view.** `dastar.occupancy` is the bound venue's active unit rows, filtered by the policies' own rule and read with the owner's rights, so the planner can use the range index again. The hold's overlap query reads it.
- **Invariant triggers read as the owner.** The fit check, the capacity guard, the unit-row insert guard, and the membership check run with definer rights, so the setting a caller controls never changes what they see.
- **One table per migration.** Each migration holds one table's lock at a time. The runner retries a lock timeout, not a deadlock, and a file that locked several tables in one transaction could deadlock against a live hold.
- **No function is executable by PUBLIC.** Postgres checks EXECUTE when a trigger is created, not when it fires, so the owner-run trigger functions are granted to no role; the helper functions and the lookups are granted by name (`0016_function_privileges.sql`).

## Alternatives considered

- **Venue in every route path.** Breaks the published v1 routes and every confirm link, for no gain in containment.
- **Keys scoped to exactly one venue.** Removes keys for several venues or all of them, and does not help the token path.
- **A read that finds its own venue.** Every other engine entry point takes the venue as a declaration; a read that looks it up hides the declaration row-level security exists to check.
- **Marking the range operator leakproof.** Needs a superuser and changes a system function in the host's database.
- **Accepting the scan.** Its cost grows with every unit's future bookings, on the engine's busiest path.

## Consequences

- A path that forgets to bind its venue reads nothing instead of another venue's rows. A write outside the bound venue is refused, usually as `venue_scope_violation`, recognised by Postgres's English message text (a translated `lc_messages` reports it as `forbidden_write`, and a BEFORE trigger can refuse first with its own code). A read or update of another venue's rows sees no rows.
- Row-level security sits behind boundary B: it cannot tell a caller that declares the wrong venue on purpose from a truthful one. Authorization stays with the host, or with the key's scope in the reference API.
- Apart from the invariant triggers, which read only to decide whether to raise, the lookups and the view are the only owner-run reads, and they return nothing a `dastar_app` session could not read by declaring that venue.
- An API from before these migrations answers 404 on reservation-id routes and refuses every confirm token once row-level security is on, and readiness does not take it out of service. A deployment stops the old API, migrates, then starts the new one; `compose.yml` runs the migration before the API starts.
- `venue-isolation.test.ts` proves the policies, the lookups, the view's plan, and the membership attack, and fails if a table with a venue column lacks a policy.

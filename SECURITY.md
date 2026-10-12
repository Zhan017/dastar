# Security

Dastar's protection model has two boundaries. This document says what each one guarantees, what it assumes, and how to report a problem.

## Boundary A: the application role against the database

The application connects as `dastar_app`. Migrations run as `dastar_owner`, which owns every object. Within boundary A the database enforces its invariants even against an application that issues arbitrary SQL as `dastar_app`. The attack suite in `packages/db/test/attack.test.ts` runs as that role and expects every case to be refused with a named SQLSTATE.

What `dastar_app` cannot do:

- Change or drop any constraint, trigger, or function. It owns nothing.
- Delete or truncate any table. It has no DELETE or TRUNCATE grant.
- Write the audit log. The audit trigger is the only writer; direct inserts, updates, deletes, and truncates are refused.
- Flip a unit row's `active` flag or delete a unit row. Only the sync trigger writes that column.
- Change a reservation's assignment, party size, range, venue, or version. The update grant on `reservation` covers `status`, `cancel_reason`, `confirm_token_hash`, `external_ref`, and `updated_at` only.
- Confirm an expired hold, or set a confirm token on anything but a live hold.
- Move the clock. `dastar.dastar_now()` is `now()` in every migrated database. The test suite installs an override in its own template database only, and `dastar_app` cannot replace functions.
- Attach a trigger function to a table of its own. Postgres checks EXECUTE when a trigger is created, not when it fires, so EXECUTE on the schema's functions is revoked from PUBLIC; the trigger functions are granted to no role, the helper functions to the application, worker, and reporting roles, and the venue lookups to the application role alone.
- Prove trust through a session setting. Custom settings such as `dastar.actor` are user-settable, so nothing treats one as evidence of origin.

Seven trigger functions run with the owner's rights (`SECURITY DEFINER` with a fixed `search_path`). Three write a row other than the one in flight: the audit insert, the unit-row flip, and the venue config-version bump. Four read other rows to enforce an invariant: the fit check, the capacity guard, the unit-row insert guard, and the membership check at commit. Reading as the owner means row-level security, which follows a setting the caller controls, never changes what they see. Every other trigger runs with the caller's rights and touches only the row in flight.

## Boundary B: declared context

Who the actor is, which venue a call belongs to, and which capability a key holds are declared by the host application. The database records the declared actor and applies per-venue rules to it, but it cannot tell a truthful host from a lying one.

Row-level security confines each transaction to the venue it declares in `dastar.venue_id`. Bound to one venue, `dastar_app` reads and writes only that venue's rows; bound to none, it reads and writes nothing except through the two lookups below. This contains a bug that mixes venues and fails closed when the declaration is missing. It does not stop a caller that declares the wrong venue on purpose: the setting is user-settable, so which venues a caller may act for is decided by the host, or in the reference API by the key's venue scope.

Two owner-run functions let a caller that holds only a reservation id find the venue to declare: `dastar.reservation_venue` returns the venue, and `dastar.reservation_token` returns the venue and the confirm token's hash for the token check. `dastar.occupancy`, the bound venue's active unit rows, is an owner view with the policies' own filter, so range queries keep their index. None of the three returns anything a `dastar_app` session could not read by declaring that venue. The view is not a security barrier, so a query whose own conditions have side effects could observe other venues' active unit rows through it; that stays within boundary B, where the caller can declare any venue anyway.

## Roles

| Role | Purpose | Beyond the application role |
|---|---|---|
| `dastar_owner` | Migrations | Owns everything |
| `dastar_app` | Commands | Statement timeout 10 s, idle-in-transaction timeout 30 s |
| `dastar_worker` | Sweeper, publisher, retention | UPDATE and DELETE on the outbox, DELETE on idempotency rows, bypasses row-level security |
| `dastar_readonly` | Reporting | SELECT only, on every venue through a read-only policy |

## Confirm tokens

A token is 32 random bytes; the database stores its SHA-256. A token is minted only through a caller with confirm authority, is single-use, is cleared on confirmation and on every transition out of held, and never appears in a hold response.

## Connections

Commands run on connections they check out from the pool the host supplies and return them only after the command has settled. A command that exceeds its deadline is cancelled in the database through a bounded request, and its connection is discarded rather than reused, whether or not the command settles in time. A connection whose state is uncertain is discarded. Commands never join a host transaction.

## Reference API

Keys are 32 random bytes shown once at creation; the database stores their SHA-256, a capability list (`hold`, `confirm`, `cancel`, `read`, and `admin`, which is reserved for the admin routes of M2 and grants nothing yet), and an optional venue list. A revoked key stops working at the next request. Authorization is declared per route, never as one blanket rule. A venue or reservation outside a key's venues reads as absent. Confirmation accepts either a key with `confirm` or a single-use token. With a token no key is needed; a presented key is checked for validity and then ignored. The token is checked with one read, through the token lookup, before the engine is involved, and again by the engine under the row lock before anything that describes the reservation. An absent reservation and a token that is wrong, replaced, already used, or cleared by a cancellation or an expiry do the same work and receive the same refusal, so the response tells a caller without a valid token nothing about a reservation, and such a caller never takes a lock. Key callers receive state-specific errors. A valid token for an expired but unswept hold can receive `hold_expired`; invalid or cleared tokens receive the generic refusal. No response other than token minting carries a token, and no log entry carries a token or a key.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository. If it is unavailable, open an issue stating only that you have a security report and how to reach you; do not put details in the public issue.

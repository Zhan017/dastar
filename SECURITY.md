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
- Prove trust through a session setting. Custom settings such as `dastar.actor` are user-settable, so nothing treats one as evidence of origin.

Three trigger functions run with the owner's rights (`SECURITY DEFINER` with a fixed `search_path`): the audit insert, the unit-row flip, and the venue config-version bump. Each writes a row other than the one being written. Every other trigger runs with the caller's rights and edits only the row in flight.

## Boundary B: declared context

Who the actor is, which venue a call belongs to, and which capability a key holds are declared by the host application. The database records the declared actor and applies per-venue rules to it, but it cannot tell a truthful host from a lying one. Row-level security for venue isolation is planned; until then, tenant isolation is the host's responsibility.

## Roles

| Role | Purpose | Beyond the application role |
|---|---|---|
| `dastar_owner` | Migrations | Owns everything |
| `dastar_app` | Commands | Statement timeout 10 s, idle-in-transaction timeout 30 s |
| `dastar_worker` | Sweeper, publisher, retention | UPDATE and DELETE on the outbox, DELETE on idempotency rows, will bypass row-level security once it is enabled |
| `dastar_readonly` | Reporting | SELECT only |

## Confirm tokens

A token is 32 random bytes; the database stores its SHA-256. A token is minted only through a caller with confirm authority, is single-use, is cleared on confirmation and on every transition out of held, and never appears in a hold response.

## Connections

Commands run on connections they check out from the pool the host supplies and return them only after the command has settled. A command that exceeds its deadline is cancelled in the database through a bounded request, and its connection is discarded rather than reused, whether or not the command settles in time. A connection whose state is uncertain is discarded. Commands never join a host transaction.

## Reference API

Keys are 32 random bytes shown once at creation; the database stores their SHA-256, a capability list (`hold`, `confirm`, `cancel`, `read`), and an optional venue list. A revoked key stops working at the next request. Authorization is declared per route, never as one blanket rule. A venue or reservation outside a key's venues reads as absent. Confirmation accepts either a key with `confirm` or a single-use token. With a token no key is needed; a presented key is checked for validity and then ignored. While a reservation is held, an absent reservation and a wrong token answer identically. Once it is no longer held, a caller who knows its id and sends any token learns that status. Reservation ids are random and unguessable, and a version cannot be probed this way. No response other than token minting carries a token, and no log entry carries a token or a key.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository. If it is unavailable, open an issue stating only that you have a security report and how to reach you; do not put details in the public issue.

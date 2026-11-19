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
- Reserve or confirm inside an active blackout, or activate a blackout over a live reservation.
- Reserve, or confirm a hold on, an inactive unit or combination or a combination over an inactive unit, or deactivate one that a live reservation uses.
- Move the clock. `dastar.dastar_now()` is `now()` in every migrated database. The test suite installs an override in its own template database only, and `dastar_app` cannot replace functions.
- Attach a trigger function to a table of its own. Postgres checks EXECUTE when a trigger is created, not when it fires, so EXECUTE on the schema's functions is revoked from PUBLIC; the trigger functions are granted to no role, the helper functions to the application, worker, and reporting roles, and the venue lookups to the application role alone.
- Prove trust through a session setting. Custom settings such as `dastar.actor` are user-settable, so nothing treats one as evidence of origin.

Eleven trigger functions run with the owner's rights (`SECURITY DEFINER` with a fixed `search_path`). Three write a row other than the one in flight: the audit insert, the unit-row flip, and the venue config-version bump. Eight read other rows to enforce an invariant: the fit check, the capacity guard, the unit-row insert guard, the membership check at commit, the two blackout guards, which take the venue-level lock, and the two deactivation guards, which take the unit locks. Reading as the owner means row-level security, which follows a setting the caller controls, never changes what they see. The guards that fire on an insert run before row-level security checks the new row, so an insert that carries another venue's id is refused either way, but it can be refused by that venue's guard, with an error that names that venue's row, and a blackout guard takes that venue's lock until the transaction ends. A caller that can declare any venue, or take the advisory lock directly, gains nothing from this, so it stays within boundary B. Every other trigger runs with the caller's rights and touches only the row in flight.

## Boundary B: declared context

Who the actor is, which venue a call belongs to, and which capability a key holds are declared by the host application. The database records the declared actor and applies per-venue rules to it, but it cannot tell a truthful host from a lying one.

Row-level security confines each transaction to the venue it declares in `dastar.venue_id`. Bound to one venue, `dastar_app` reads and writes only that venue's rows; bound to none, it reads and writes nothing except through the owner-run lookups below. This contains a bug that mixes venues and fails closed when the declaration is missing. It does not stop a caller that declares the wrong venue on purpose: the setting is user-settable, so which venues a caller may act for is decided by the host, or in the reference API by the key's venue scope.

Two owner-run functions let a caller that holds only a reservation id find the venue to declare: `dastar.reservation_venue` returns the venue, and `dastar.reservation_token` returns the venue and the confirm token's hash for the token check. A third, `dastar_agent.session_venue`, does the same for a caller that holds only an audit session's id, and returns the venue only for a live session that the caller's key owns. `dastar.occupancy`, the bound venue's active unit rows, is an owner view with the policies' own filter, so range queries keep their index. None of these returns anything a `dastar_app` session could not read by declaring that venue. The view is not a security barrier, so a query whose own conditions have side effects could observe other venues' active unit rows through it; that stays within boundary B, where the caller can declare any venue anyway.

## Roles

| Role | Purpose | Beyond the application role |
|---|---|---|
| `dastar_owner` | Migrations | Owns everything |
| `dastar_app` | Commands | Statement timeout 10 s, idle-in-transaction timeout 30 s |
| `dastar_worker` | Sweeper, publisher, retention | UPDATE and DELETE on the outbox, DELETE on idempotency rows, SELECT and DELETE on the audit session tables, bypasses row-level security |
| `dastar_readonly` | Reporting | SELECT only, on every venue through a read-only policy, the audit session tables included |

## Confirm tokens

A token is 32 random bytes; the database stores its SHA-256. A token is minted only through a caller with confirm authority, is single-use, is cleared on confirmation and on every transition out of held, and never appears in a hold response.

## Connections

Commands run on connections they check out from the pool the host supplies and return them only after the command has settled. A command that exceeds its deadline is cancelled in the database through a bounded request, and its connection is discarded rather than reused, whether or not the command settles in time. A connection whose state is uncertain is discarded. Commands never join a host transaction.

## Reference API

Keys are 32 random bytes shown once at creation; the database stores their SHA-256, a capability list (`hold`, `confirm`, `cancel`, `seat`, `read`, and `admin`, which grants the admin routes: listing and changing the units, combinations, schedules, and blackouts of the key's venues, including forced changes that cancel live reservations with an outbox event each, and the keys scoped to exactly one of its venues: an admin key creates such keys with any of the six capabilities, lists them, and revokes them, and the secret of a new key appears once, in the response that creates it; keys of several venues or of all venues are created and revoked by the host, never through a venue's routes). A key with `admin` cannot use the other capabilities itself, but it can create a key of its venue with any of them, so on that venue it holds them all in effect, and an optional venue list. A revoked key stops working at the next request. Authorization is declared per route, never as one blanket rule. A venue or reservation outside a key's venues reads as absent, and the holds listing returns only the calling key's own live holds. Availability needs `read` as well and answers for a venue in the key's scope only. Confirmation accepts either a key with `confirm` or a single-use token. With a token no key is needed; a presented key is checked for validity and then ignored. The token is checked with one read, through the token lookup, before the engine is involved, and again by the engine under the row lock before anything that describes the reservation. An absent reservation and a token that is wrong, replaced, already used, or cleared by a cancellation or an expiry do the same work and receive the same refusal, so the response tells a caller without a valid token nothing about a reservation, and such a caller never takes a lock. Key callers receive state-specific errors. A valid token for an expired but unswept hold can receive `hold_expired`; invalid or cleared tokens receive the generic refusal. No response other than token minting carries a confirm token, and no log entry carries a token or a key.

The docs page at `/docs` needs no key and shows only what `/openapi.json` already publishes. It serves Swagger UI from the installed package, not from a CDN, under a content security policy that admits scripts, styles, and requests from the API's own origin only, and it makes no request to a third party. A key typed into its Authorize dialog stays in the page's memory and is sent only to the API.

## Audit sessions

An audit session records what an agent's calls observed, so that the claims in its transcript can be set against it. The tables are `dastar_agent.session`, `tool_call`, and `turn`.

- **The agent's key cannot confirm.** `POST /v1/sessions` refuses a key that can confirm or administer with 403, so a session belongs to a key that holds neither. A confirm token that someone gives the agent still confirms: the agent sends it with its own key and the session header, the confirm is recorded, and the audit counts it in `confirmations`. A confirm the agent makes without the header is not recorded; the reservation's current status in the result shows it.
- **A session is its key's and its venue's.** Another key's session, one that does not exist, and one not seen for 30 days all answer 404 `no such session`, so they cannot be told apart. A call whose venue is not the session's is refused with 422. The three tables carry the same row-level security as the engine's, and `dastar_agent.session_venue`, an owner-run lookup like the reservation lookups above, returns the venue of a live session only to the key that owns it.
- **The session log is written by the API's role.** `dastar_app` inserts and completes calls, and updates a session's `last_seen_at`, call count, and audit; it cannot change a session's key, venue, or kind, a call's tool or input, or delete a session or call. It can still write a call's output and receipt, and the verdicts read the recorded calls as written. The receipts are checked separately: a receipt is verified only when the venue's audit log, which `dastar_app` cannot write, holds the row the receipt names: that reservation, the audit id, and the same status, version, and trace id. Every other receipt is listed as unverified in the result, and a claim its call backs stays backed, so an unverified receipt is a reason to distrust the whole result. Only `dastar_worker` deletes sessions, once they are past retention.
- **The log stores no free text.** A call keeps ids, numbers, times, statuses, and error codes. It never keeps the key, a confirm token, `external_ref`, a cancel reason, or a problem detail, whatever the request or response carries. The one string a client chooses is a hold's idempotency key. The transcript is the exception by design: its turns and quotes are stored, scrubbed.
- **The scrubber runs before a transcript is stored.** It masks email addresses and numbers of seven digits or more, keeping ids, dates, and times. It does not detect names; [LIMITATIONS.md](LIMITATIONS.md) lists what else it misses.
- **The audit's size is bounded.** The audit post takes up to 1 MiB, after the key check, so a request without a valid key is refused before its body is read; every other route takes 64 KB. The result is not bounded by the body: each claim's result carries its observation and up to 10 receipts, so a 1 MiB transcript can produce a stored and returned result of tens of megabytes. A session records at most 10,000 calls, a transcript has at most 500 turns, and an external session is gone 30 days after it was last seen and purged 10 minutes later.

## Agent tools and MCP

No agent tool reaches a confirm route: there is no confirm tool, hold responses carry no token, and a test fails if the tools' source names a confirm or token route. The MCP server checks its key before it serves: the key must read its venue and be refused both confirm-token minting and the venue's key listing, so a key that can confirm or administer stops it with exit code 1. With `DASTAR_SESSION_ID` set it then checks that the session is its key's, for its venue, and stops with one line otherwise; those start-up checks are sent without the session, so they are not recorded. Neither the key nor any user name or password in `DASTAR_URL` appears in its output. Over plain HTTP the key crosses the network in clear; use HTTPS for an API on another machine.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository. If it is unavailable, open an issue stating only that you have a security report and how to reach you; do not put details in the public issue.

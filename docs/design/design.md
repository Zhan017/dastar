# Dastar: System Design

Status: v0.11, 2026-09-10. Design frozen pending prototype results; section 20 records the review findings that shaped it, and `results-2026-09-10-prototype.md` records what the prototype showed. Estimates assume a part-time solo maintainer.

---

## 0. Summary

Dastar is an open-source reservation engine for exclusive inventory: indivisible units with capacity ranges, fixed combinations of units, holds that expire, party sizes that must fit, and many clients racing for the same slot. A unit is booked by at most one reservation at a time; that is the property the database enforces. Quantity-based or pooled inventory, such as fifty tickets to one show, is a different problem with a different constraint and is out of scope. Restaurant tables are the first adapter; rooms, specific rental items, and vehicles or guides on tours fit the same model. Its one promise is that it never oversells, and that promise is enforced by Postgres, not by application code.

It is library-first: host apps import `@dastar/core` and `@dastar/db` into their own Node process and Postgres and keep auth, tenancy, and payments. A reference deployment (Hono API, worker, Postgres, Docker Compose) serves the public demo, the test harness, and non-Node hosts. Above the engine sits an agent layer whose tools derive from the same Zod schemas as the HTTP API, with a booking agent that can hold but never confirm, a guardrail that rejects uncited declared claims and constrains what the agent can do, a deterministic auditor, and an eval suite that runs in CI.

Target readers of the repo: engineers deciding whether to trust the engine, and teams deciding whether to adopt it. Both are first-class actors in this design. A third audience is agent builders: Dastar is also a deterministic, self-hostable booking backend for developing and testing reservation agents, and it can audit any agent's claims against the receipts it issued, over plain HTTP, with no SDK.

---

## 1. Principles

1. **Postgres enforces.** Every invariant is a constraint or trigger, and the application connects as a role that cannot remove them. TypeScript orchestrates transactions and maps errors. A raw-SQL attack suite, run as the application role, proves the database refuses violations on its own.
2. **One schema, four surfaces.** Zod definitions generate the OpenAPI document, the typed client, the LLM tool definitions, and the MCP server. CI fails on drift.
3. **Agents hold, humans confirm.** Agent keys cannot confirm. Confirmation needs a confirm-capable key or a single-use confirm token that is handed to a human, and the human confirms a reservation whose details were read back from the server, never described by the model.
4. **Every claim has a receipt.** Every mutation returns a receipt. Every agent statement about booking state must cite one. The auditor checks, and the auditor's own accuracy is measured and published. The guardrail checks declared claims and constrains actions; it does not detect every false statement and is not a general solution to hallucination.
5. **Every bug gets a replay.** Property-test sequences, harness histories, and agent transcripts are recorded and replayable.

---

## 2. Decision log

| # | Decision | Chosen | Rejected | Why |
|---|---|---|---|---|
| D1 | System boundary | Library first; Hono API as reference deployment | Standalone service only; both equal | Matches the "enforced by Postgres" story and the package layout |
| D2 | Invariant enforcement | Constraints and triggers for every invariant; TS orchestrates | TS guards; PL/pgSQL commands | Makes the tagline literally true; attack tests become possible |
| D3 | Hosting | One VPS, Docker Compose, Postgres on the box, Cloudflare in front | PaaS plus managed Postgres; Vercel plus Neon | Same compose as quickstart; chaos and benchmarks are real; free managed tiers sleep |
| D4 | Traces and logs | Grafana Cloud free tier, OTLP exported directly from api and worker | Self-hosted Jaeger; Honeycomb; a collector container | Alerting and retention for free; one fewer moving part on a single box |
| D5 | Query layer | Kysely with plain SQL migrations and generated types | Drizzle | Constraints and triggers are hand-written SQL anyway. Superseded by D46: the query layer is `pg` directly. |
| D6 | Confirm authorization | A confirm-capable key, or a single-use confirm token minted through a confirm-capable key and handed to a human channel. The hold response never contains a token | Token in the hold response; key only | A token in the hold response hands every hold-only agent a confirm credential. Minting requires confirm authority, so "agents hold, humans confirm" holds for any hold-only key, not only the reference agent |
| D7 | Assignment representation | `assignment_kind` and `assignment_id` on reservation; unit rows derived and verified by a deferred trigger | Unit rows only | Fit trigger reads one row; membership trigger closes the gap between the two tables |
| D8 | Migrations | In-house runner, ordered SQL files, checksums, forward-only, lock timeout with retry, advisory lock, per-file transactional or concurrent mode, expand-then-contract from migration 002. Reconsidered in v0.10 and kept for v0.1, bounded to those five behaviors; a sixth need means adopting an existing tool | dbmate, node-pg-migrate, graphile-migrate | No single tool covers checksums, an advisory run lock, and non-transactional files together; a bounded runner is less surface than a dependency plus workarounds. Safety under load is a hypothesis (H6) with a named test |
| D9 | Reference server API keys | Table with hashed keys, capabilities, venue scope | Env vars | Several keys and revocation for the demo |
| D10 | Optimistic concurrency | Optional `expected_version` on confirm and cancel | Status guards only | Receipt already carries version |
| D11 | Queueing | Postgres only: `FOR UPDATE SKIP LOCKED` for sweeper and outbox | Redis, SQS | No second datastore |
| D12 | Consistency boundary | Venue. No transaction spans venues | Global | Sharding by venue stays possible |
| D13 | Clock | `dastar_now()` owned by the owner role. In production it is `now()`. Test databases replace its body with a version that reads a transaction-local setting | A GUC gate; app clock | Custom GUCs are settable by any session, so a gate on them is not a gate |
| D14 | Workers | Separate `@dastar/worker` package and container; importable in-process | Bin inside API | Chaos test kills it independently |
| D15 | Identifiers | UUID v7 via native `uuidv7()` on Postgres 18 | Hand-rolled on 17; bigint | One less function in the attack surface |
| D16 | Outbox writes | Commands write outbox rows through a typed, versioned payload builder | Audit trigger writes them | Public payloads shaped in TypeScript, tested and versioned; no accidental column leaks |
| D17 | Availability caching | Static snapshot cached by a venue config version bumped only on config writes; occupancy read live | Version bump on reservation writes | A bump per reservation would serialize a venue's bookings on one hot row |
| D18 | Actor on writes | Trigger rejects any reservation write without `dastar.actor` set | Default actor | Audit rows are never anonymous |
| D19 | Database roles | `dastar_owner` (migrations, owns everything), `dastar_app` (DML grants only, no ownership, no TRUNCATE, statement and idle timeouts), `dastar_readonly` | One role | Without this, the app can disable every guard and the attack suite proves nothing |
| D20 | Hold transaction shape | One outer transaction claims the idempotency key, takes the per-unit advisory locks (D39), locks every occupying reservation that overlaps the requested units in reservation-id order, expires the dead ones, then makes a single booking attempt under a savepoint and stores the outcome under the still-owned key before committing. A deadlock or serialization error retries the whole outer transaction once | Skip-locked inline expiry; conflict-then-expire-then-retry; lock ordering per phase or per discovering unit | The key is owned from claim to stored outcome. The overlap lock set is time-independent and canonically ordered, so two holds on disjoint units that meet the same combo reservations lock them in the same order, and by construction nothing should be flipping a row on the requested units while the insert runs |
| D21 | Judge model | Runs asynchronously over stored transcripts; inline guardrail is the deterministic citation check only; judge precision and recall are measured against a labeled set and published | Inline judge in the request path | Cost and latency; an unmeasured judge cannot back a published number |
| D22 | Backups | Nightly logical dump to object storage, one executed and documented restore drill | None | A trust-themed repo without a restore drill reads badly; it costs two hours |
| D23 | Scope | Correctness fixes, naive mode, deterministic auditor, model-based tests, crash test, architecture group, guardrails and evals, MCP | Stretch group | Stretch parked as M6 |
| D24 | Bring-your-own-agent audit | Any agent calls the API with a session header; Dastar records receipts under the session; the agent posts its transcript; the auditor matches claims to receipts | Auditor limited to the reference agent | Gives the audit report a reason to exist beyond this repo's own agent; two days in M3 over plain HTTP |
| D25 | Hosted sandbox with free keys | Built in M5 only if the M1 launch produces signals: clones, issues, anyone asking for keys | Build it unconditionally | Abuse surface, LLM bill, and support load; the ten-dollar floor-plan demo is enough without signal |
| D26 | Venue isolation | Row-level security on every venue-scoped table, keyed on a transaction-local `dastar.venue_id`, enforced for `dastar_app`; a separate `dastar_worker` role bypasses it for cross-venue loops. Context set in M1, policies on in M2 as invariant 10 | Host-only isolation; an unset context meaning all venues | A host bug passing the wrong venue id is the failure class the design claims to prevent; fail-closed is the only safe default. This is a bug-containment boundary, not an authentication one: the app role declares the context and can declare it wrongly; the API key check in the API process is what authenticates |
| D27 | Transcript scrubbing | Pattern-based masking of emails, phone numbers, and long digit runs at intake for every stored turn; names not attempted; redact-first ask stays | Trust builders to redact; model-based name detection | Cheap, deterministic, and honest about its limits |
| D28 | Live floor plan transport | Server-sent events carrying outbox ids as refresh hints, with periodic reconciliation (D36); listen-notify only as an optional wake-up on a dedicated connection | Listen-notify as the mechanism; polling occupancy alone | The event stream already exists; pooler-safe; no new moving part |
| D30 | Idempotency outcomes | Domain outcomes are stored under the key inside the same outer transaction that claimed it, whether the booking savepoint succeeded or rolled back: success, hold_conflict, party_does_not_fit, blackout. Transport and validation failures are not | Store successes only; store the conflict in a follow-up transaction | Invariant 3 holds unconditionally within the retention window; a client that wants to try again uses a new key |
| D31 | Unit-row churn | Per-table autovacuum settings on `reservation_unit` from the first migration; a sustained churn benchmark in M2; list-partitioning by venue documented as the escape hatch | Trust defaults; partition now | Flipping `active` is a non-HOT update, one dead index entry per terminal hold; measure it before designing for it |
| D32 | Estimation policy | Milestone estimates carry a 30 percent buffer; re-baseline after M1 against actual hours; a written cut line applies if behind after M2 | Point estimates | Solo estimates miss; the cut line protects the minimum credible release |
| D33 | Trust boundary | Two boundaries, stated in 6.1. Boundary A holds against an adversarial `dastar_app`: constraints, check-and-raise triggers, table and column grants, and three security-definer triggers that are the only writers of `active`, audit rows, and `version`. Boundary B is declared context (actor, trace id, venue) that the database checks for presence and consistency but cannot authenticate | A transaction-local internal flag as proof of trusted origin | Custom settings are user-settable, so a flag proves nothing; grants and definer functions do |
| D34 | Combo immutability | `unit_combo.unit_ids` and capacities never change after insert; operators deactivate and recreate. Column grants enforce it for the app role and a trigger backstops it for the owner | Versioned combos; assignment snapshots on the reservation | An existing reservation's assignment can never change meaning, and invariant 9 stays checkable without a second copy of the member set |
| D35 | Claim matching | A claim is matched against the latest recorded state of that reservation as of the turn, on status, start time, and party size; matching an older receipt is a violation | Any receipt in the session | "Was confirmed" and "is confirmed" are different statements; only the second is a safe thing to tell a guest |
| D36 | Live events | Outbox ids on the stream are refresh hints; the client reconciles from a full snapshot on connect, on every hint, and every thirty seconds | A delivery cursor over identity ids | Identity ids are assigned at insert, not commit, so a cursor can skip a row that commits late |
| D37 | Product boundary | Exclusive reservation of indivisible units and fixed combinations. Quantity and pooled inventory are out of scope | "Capacity-based inventory" as a broad claim | The exclusion constraint cannot express a sum of quantities; claiming ticketing would be false |
| D39 | Unit lock protocol | A transaction-level advisory lock per unit, keyed by unit id, acquired in sorted unit order: by the hold command at the start of its outer transaction, by the fit trigger on reservation insert, and by the capacity trigger on unit update | Lock-order arguments across phases; skip-locked expiry; accepting deadlocks as normal | Two holds that share a unit never run concurrently. This has a real cost: holds on the same unit for different, non-overlapping dates could otherwise commit concurrently and are instead serialized for the duration of a hold transaction, which is unmeasured until the prototype runs (H2). Accepted as the initial trade and as the prototype baseline; serialization across unrelated dates is a documented cost, not a defect. Any future refinement, such as a lock keyed by unit and time bucket, is not a drop-in replacement: it must preserve coordination for overlapping ranges, multi-unit bookings, the overlap lock set, expiry, and capacity edits, and it is considered only if the prototype's non-overlapping-dates measurements show the cost matters (6.5). The third review's interleaving, a retained expiry lock waiting on a fresh insert, is designed not to occur. Deadlock errors stay mapped and retried once as defense in depth, and the harness asserts zero (H1) |
| D40 | Unit capacity | Capacities are current values. A capacity change that would leave a live reservation assigned directly to the unit outside the new range is rejected by trigger DA012, which takes the unit's advisory lock first; the admin route offers reject-or-force | Immutable capacities with deactivate-and-recreate; app-level check only | Recreating a unit cascades into layouts and immutable combos; a trigger holding the unit lock closes the race against concurrent holds at boundary A. Confirm takes the same unit locks before its row lock and the fit check runs on the transition to confirmed (D45 area, section 10.2), so an edit and a confirmation on one unit serialize and the second sees the first's committed state. |
| D41 | Transitions versus metadata | The transition trigger evaluates the allowlist only when status changes. Same-status updates are metadata updates limited by column grants; token minting is one, requires a held unexpired reservation (DA013), replaces the previous hash, bumps version, and is audited with the hash redacted | A literal allowlist on every update | A literal reading would reject minting and external-reference updates |
| D42 | Claim verdicts | Reference agent: present-tense claims are checked against a fresh read at guardrail time. External audits: the verdict is "supported by the latest session observation as of the builder-supplied timestamp", and current state at audit time is reported alongside | Session observation only, for both | Operator cancellations and silent expiry never appear in a session's tool log |
| D43 | Effective status | Reads, tool results, the floor plan, capacity and liveness checks, and claim matching use `effective_status`: `expired` when a stored `held` row is past `hold_expires_at` by database time, otherwise the stored status. Receipts and the audit log record stored transitions | Stored status only | A hold that the sweeper has not reached is still expired; a fresh read that says held would let a guardrail approve a false claim |
| D44 | Token hash lifecycle | Setting a non-null hash requires a held, unexpired reservation before and after the update. Clearing the hash is always allowed. Every transition out of held clears it | A single guard on the new row's status | A guard on the new status would reject the confirmation that consumes the token |
| D45 | Connection ownership | Commands run only through a handle built from a host-supplied pool; each checks out a client, runs, and releases it after settlement, with an acquire timeout, a deadline with backend cancellation, and discard of any connection whose state is uncertain. No host transactions | A transaction-state guard on caller-supplied clients; composing inside host transactions with savepoints | A command's `begin` and `commit` on a client inside a host transaction would commit or discard the host's work; the retry in hold cannot run inside a host transaction |
| D46 | Query layer | `pg` directly with hand-written SQL | Kysely (D5) | Every statement is already hand-written; a query builder would add a layer without removing any |
| D47 | Nontransactional migrations | A `transaction: no` file is exactly one concurrent index statement in canonical spelling; the runner validates any existing index of that name by table, definition, and validity before recording, dropping, or applying | Free-form nontransactional files; removing the mode | A failed concurrent build leaves an invalid index and a re-run must neither trust a name match nor rebuild a finished index |
| D48 | Time zone math | Postgres converts local times: service periods are computed per request in SQL with the venue's zone, and core's availability functions take instants. A local time in a spring gap takes the offset before the transition; an ambiguous autumn time takes the offset after it | A Temporal-compatible library in core (deferred in section 18); hand-written `Intl` offset math | The database that stores and judges every range is the only time zone authority, core keeps no runtime dependency, and the gap and overlap rules are Postgres's, pinned by tests |
| D49 | Reject-or-force | A configuration write that would strand live reservations is refused with their ids unless forced; force cancels them, each with a reason and an outbox event, in the same transaction as the write, only when none is seated or past its start and at most 200 are stranded. Every admin write takes the venue lock exclusively first. Unit and combination deactivation are refused in the database while a live reservation uses them (invariant 12) | Forcing through started reservations; batching cancellations over several transactions; deactivation checked only by the command | One atomic batch leaves no state where the change is half applied or a new booking lands between batches; a party already seated is closed by the operator, not by a configuration change; a guard in the database holds for every writer, as D40 does for capacity |
| D29 | Partitioning | Deferred with named trigger conditions: audit_log past tens of millions of rows, or vacuum duration visible in monitoring. Outbox is bounded by retention | Partition audit_log and outbox now | Partition keys in every unique constraint and ongoing partition upkeep are real costs; point lookups do not degrade with size; the named bottleneck is GiST churn, which partitioning does not touch |

---

## 3. System context, C4 level 1

Two deployment modes, one boundary. Embedded: the host app imports the packages and owns Postgres; API and worker collapse into the host's process. Reference: Dastar ships them. Dastar owns availability, holds, confirmation, seating state, audit, outbox events, agent tools, and the auditor. The host owns auth, tenancy, payments, guest notifications, and guest identity. Venue is the unit of isolation; mapping tenants to venues is the host's job.

Guest personal data never enters the engine schema. Hosts correlate through `external_ref`. This is a hard rule because the audit log is append-only and cannot honor an erasure request.

| Actor | Who | Touches Dastar through |
|---|---|---|
| Guest | Wants a table | Host app UI, or the chat agent in the demo |
| Venue operator | Manager or host | Admin API, demo floor plan |
| Integrator | Developer on the host app, or an agent builder testing against Dastar; also wears the SRE hat | npm packages, migrations, API, webhooks, compose, session header and audit endpoint |
| Evaluator | Prospective adopter, reviewer | README, race command, demo site, audit file, benchmarks |

```mermaid
C4Context
  title Dastar system context, reference deployment
  Person(guest, "Guest", "Wants a table.")
  Person(operator, "Venue operator", "Defines units, combos, schedules, blackouts. Seats guests.")
  Person(integrator, "Integrator", "Installs, migrates, wires webhooks, runs the service.")
  Person(evaluator, "Evaluator", "Reads the repo, runs the race, opens the demo.")
  System(dastar, "Dastar", "Reservation engine. Packages, reference service, demo, harness.")
  System_Ext(host, "Host application", "Owns auth, tenancy, payments, notifications, guest identity.")
  System_Ext(llm, "LLM provider", "Chat completion with tool use, behind a provider interface.")
  System_Ext(grafana, "Grafana Cloud", "Traces, logs, public dashboards.")
  System_Ext(ci, "CI", "GitHub Actions.")
  System_Ext(objstore, "Object storage", "Nightly dumps.")
  System_Ext(phone, "Telephony", "Optional, M5.")
  Rel(guest, host, "Searches, holds, confirms, cancels")
  Rel(guest, dastar, "Chats with the agent", "demo")
  Rel(operator, dastar, "Manages floor plan, seats guests")
  Rel(integrator, dastar, "Installs, migrates, deploys, calls")
  Rel(evaluator, dastar, "Runs the race, opens demo, reads reports")
  Rel(host, dastar, "Calls library or HTTP API")
  Rel(dastar, host, "Webhooks from the outbox", "HTTPS, HMAC")
  Rel(dastar, llm, "Tool-use completions")
  Rel(dastar, grafana, "OTLP")
  Rel(dastar, objstore, "pg_dump nightly")
  Rel(ci, dastar, "Runs harness and migrations")
  Rel(phone, dastar, "Voice to agent", "optional")
```

---

## 4. Containers, C4 level 2

| Container | Tech | Responsibility |
|---|---|---|
| Library distribution | npm: `@dastar/core`, `@dastar/db`, `@dastar/worker`, `@dastar/agent-tools`, `@dastar/mcp` | What host apps embed |
| API | Node 26, Hono, Zod | v1, admin, demo routes. Capability keys, per-key rate limits, idempotency, receipts, OTLP export. Exported as an app factory |
| Agent | Node 26, Hono, `apps/agent` | The reference agent: `POST /demo/chat`, the turn, the model calls, the guardrail, the confirm tokens. A process of its own that calls the API over HTTP with a hold-only key and writes its own tables through the engine as `dastar_app`. Its second process, the judge (`pnpm --filter @dastar/agent judge`), connects as `dastar_judge` and calls the model provider. Neither is part of `compose.yml` |
| Worker | Node 26, same image | Sweeper, outbox publisher, retention (idempotency, outbox), backup trigger, demo reset |
| Migrate | Node 26, one-shot, connects as `dastar_owner` | Applies SQL migrations then exits; API and worker wait on it |
| Postgres | 18, btree_gist | Constraints, triggers, audit, outbox. The only state |
| Demo web | React, Vite, static | Floor plan, chat, race button |
| Caddy | Caddy 2 | TLS, static files, reverse proxy |
| Harness | CLI, `apps/harness` | Race, naive mode, mixed load, chaos, crash, bench. Laptop or CI |
| MCP server | stdio, `@dastar/mcp` | Same tools for any MCP client |

Only migrate connects as `dastar_owner`. API, agent, harness, and the attack suite connect as `dastar_app`, which is subject to row-level security from M2. The worker connects as `dastar_worker`, which bypasses row-level security because sweeping, publishing, and retention run across venues. The judge connects as `dastar_judge`, which bypasses it for the same reason: it reads every venue's sessions and writes one column.

```mermaid
C4Container
  title Dastar containers, reference deployment
  Person(guest, "Guest")
  Person(operator, "Venue operator")
  System_Ext(host, "Host application")
  System_Ext(llm, "LLM provider")
  System_Ext(grafana, "Grafana Cloud")
  System_Ext(objstore, "Object storage")
  Container_Boundary(dastar, "Dastar") {
    Container(lib, "Library distribution", "npm", "core, db, worker, agent-tools, mcp")
    Container(web, "Demo web", "React, static", "Floor plan, chat, race")
    Container(caddy, "Caddy", "Caddy 2", "TLS, static, proxy")
    Container(api, "API", "Node 26, Hono", "v1, admin, demo. Receipts, keys, limits")
    Container(agent, "Agent", "Node 26, Hono", "Demo chat, guardrail, confirm tokens")
    Container(worker, "Worker", "Node 26", "Sweeper, publisher, retention, backup, reset")
    Container(migrate, "Migrate", "one-shot, owner role", "SQL migrations")
    ContainerDb(pg, "Postgres", "18, btree_gist", "Constraints, triggers, audit, outbox")
    Container(harness, "Harness", "CLI", "Race, naive, chaos, crash, bench")
  }
  Rel(guest, caddy, "Uses demo", "HTTPS")
  Rel(operator, caddy, "Admin via demo", "HTTPS")
  Rel(caddy, web, "Serves")
  Rel(caddy, api, "Proxies")
  Rel(host, lib, "Embeds")
  Rel(host, api, "Calls", "HTTPS")
  Rel(api, pg, "Transactions, app role")
  Rel(worker, pg, "Sweeps, drains outbox, app role")
  Rel(migrate, pg, "Migrates, owner role")
  Rel(worker, host, "Webhooks", "HTTPS, HMAC")
  Rel(worker, objstore, "Nightly dump")
  Rel(agent, api, "Tool calls and token mints", "HTTP, hold-only and confirm keys")
  Rel(agent, pg, "Its own tables, app role")
  Rel(agent, llm, "Completions")
  Rel(api, grafana, "OTLP")
  Rel(worker, grafana, "OTLP")
  Rel(harness, api, "Fires races")
  Rel(harness, pg, "Kills, restarts, verifies")
```

---

## 5. Components, C4 level 3

**Dependency rule, enforced by dependency-cruiser in CI.** core imports nothing from the repo. db imports core. api and worker import db and core. agent-tools imports only the typed client, and mcp imports agent-tools and the client. demo and harness sit on top. Two rules bound the reference agent, `apps/agent`: it imports the client, the agent tools, and the engine, and no other host, neither the API, the worker, the harness, nor the MCP server (`agent-on-the-contract-and-engine`); and nothing imports it (`nothing-imports-the-agent`).

```mermaid
flowchart TB
  subgraph core["@dastar/core (pure)"]
    dom["domain types, TimeRange half-open"]
    sm["state machine as data"]
    avail["availability: slots, fit, assign"]
    rank["RankingStrategy + restaurantHost"]
    errs["error taxonomy, stable codes"]
    events["outbox payload builders, versioned"]
    claims["claim matcher, transcript scrubber, judge screening and assembly"]
  end
  subgraph db["@dastar/db"]
    mig["SQL migrations + runner"]
    cmd["commands: hold (unit locks, overlap set, one attempt), confirm, cancel, seat, complete, expire"]
    idem["idempotency: actor + key + payload hash + stored receipt"]
    snap["queries: loadSnapshot, occupancy, getReservation, floorPlan"]
    outbox["outbox: claim SKIP LOCKED, markPublished, deadLetter"]
    map["SQLSTATE to core error mapper, retry classifier"]
    crypto["secretbox: encrypt webhook secrets at rest"]
    asess["audit sessions: begin and complete calls, store and read audits, purge"]
  end
  subgraph api["@dastar/api"]
    routes["v1, admin, demo routers"]
    mw["auth keys, per-key rate limit, idempotency, problem details, tracing, redaction"]
    oapi["OpenAPI from Zod"]
    rec["recorder: dastar-session on nine routes; session and audit routes"]
  end
  subgraph worker["@dastar/worker"]
    sweep["sweeper"]
    pub["publisher: HMAC, backoff, DLQ"]
    retention["retention: idempotency, outbox, transcripts"]
    backup["nightly dump"]
    reset["demo reset"]
  end
  subgraph atools["@dastar/agent-tools"]
    tools["tool schemas from the contract; tool session over HTTP"]
    keycheck["start-up key checks"]
  end
  subgraph agent["apps/agent, the reference agent"]
    route["POST /demo/chat"]
    prov["LLMProvider interface + Anthropic adapter"]
    loop["turn: claim, rebuild, loop, versioned prompt, structured reply"]
    guard["claim guardrail, regenerate, fallback"]
    sess["persisted turns, encrypted confirm tokens"]
    judge["judge process: due turns, one model call each, stored result"]
  end
  mcp["@dastar/mcp"]
  client["@dastar/client"]
  db --> core
  api --> db
  worker --> db
  atools --> client
  agent --> atools
  agent --> client
  agent --> db
  mcp --> atools
  mcp --> client
```

**core.** Domain types with a half-open `TimeRange`. State machine as a data table, hand-written into the SQL trigger, with an exhaustive test over every from-to pair. Availability is pure functions over instants: candidate slots from service periods, fitting assignments from units and combos, ranking through a `RankingStrategy` with `restaurantHost` as default, and one pass that combines them. Error taxonomy with stable codes reused by every surface. Versioned outbox payload builders. The claim matcher, `auditSession`, which sets the claims of a transcript against a session's recorded calls and the claimed reservations' current statuses, and the transcript scrubber, `scrubText`, are pure functions here, with no database and no clock of their own. So are the judge's parts that decide (section 13): the check that a statement's quote is in the turn's text, the test of whether a declared claim covers a statement, the assembly of a turn's result over `auditSession`, and the summary the audit read gives. Time zone math is Postgres's (D48): the database computes service periods as instants, and the availability functions take instants.

**db.** Migrations and runner. Commands, one transaction each, returning a receipt, with a retry classifier for deadlock and serialization errors. Idempotency stores actor, key, payload hash, and the exact response. Snapshot and occupancy queries. Outbox claim and ack. The audit session store: open a session, begin a call under the session's row lock and complete it once, read a session's calls with their receipt checks and the claimed reservations' current statuses in one snapshot, store and read an audit, and purge expired external sessions; core's matcher and scrubber are re-exported for the API and the reference agent. The reference session commands: open a reference session, claim a turn, store the assistant turn with its record, read a session's turns, keep and read the encrypted token of a session's hold, and read a venue's name and time zone. The judge commands, which run as `dastar_judge` and name the venue in their own predicates, since that role bypasses row-level security: the assistant turns that are due, a turn's source read in one snapshot (the turn, the user turn before it, the session's turns without their text, its calls in id order with no receipt check, and the venue's time zone), the current status of listed reservations, the write of a result to a turn that has none, the count of the day's provider calls, and the check that the role may write `judge_result`. SQLSTATE mapper. A secretbox helper for encrypting webhook secrets at rest with a key from the environment. Every command sets `dastar.actor`, `dastar.trace_id`, and `dastar.venue_id` as transaction-local settings at the start; from M2 the venue setting is what row-level security keys on, so a transaction that forgets it reads nothing and inserts nothing.

**api.** Routers for v1 and admin, and the race demo route (flagged); the chat route is the reference agent's. Middleware: capability keys, per-key token buckets in memory, idempotency header handling, Problem Details, tracing with the trace id echoed in receipts, and log redaction so a confirm token never appears in a log line or span. The recorder wraps the nine v1 routes an agent calls: a request that carries `Dastar-Session` is checked against the key's own sessions and the session's venue, recorded as started, answered by the route itself, and recorded as completed with its status, the fields section 6 lists, and its receipt. The session routes open and read a session; the audit routes take a transcript, scrub it, read the session's calls in one snapshot, run the matcher, store the turns, the result, and whether the post asked for the judge, and read the latest result back, with `undeclared` read from the assistant turns' judge results when it did; a reference session is not the audit post's to replace, so it answers 404 for one. OpenAPI from Zod, committed as `apps/api/openapi.json`; Swagger UI at `/docs`; the typed client `@dastar/client` is generated from the committed document, and a test fails while the document or the client's types differ from what the routes generate.

**worker.** Sweeper expires due holds through the same command path in small batches. Publisher signs, delivers with backoff, dead-letters. Retention purges idempotency rows past their purge time, published outbox rows older than seven days, external audit sessions with their calls and turns from ten minutes after they stop being live (section 6). Reference sessions are not purged. Backup runs the nightly dump. Demo reset reseeds nightly when flagged.

**agent-tools.** Tool definitions from the shared schemas, executed over HTTP through the typed client, and the start-up key checks the MCP server and the reference agent share. A tool session remembers the reservations it created and cancelled and the idempotency key of each hold request, and can be rebuilt from plain data, which the reference agent reads from its session's recorded calls. It imports only the client.

**agent.** The reference agent, `apps/agent` (`@dastar/agent`), is an app of its own, built on Hono like the API and run as its own process on its own port. It imports the client, the agent tools, and the engine. Its tools call the API over HTTP with a key that has `read`, `hold`, and `cancel` and the reference session's `Dastar-Session`, so the API records its calls as it records an outside agent's, under actor `key:<agent key id>`; the API holds no model code (ADR 8). It writes its own tables through `@dastar/db` as `dastar_app`, the API's role. It holds the `LLMProvider` interface and an Anthropic adapter; the turn loop with a versioned prompt file whose hash goes on every stored turn, forcing a structured reply; the inline guardrail, which sets every declared claim against the session's own calls and the reservation's current status, regenerates a failing reply at most twice, then falls back to a message built from reads; the token store, which seals each confirm token and keeps it in `dastar_agent.session_hold`; the start-up checks of its two keys; and `POST /demo/chat`. The tool-result cap and the control-character removal are applied here, so the MCP server's output does not change. Not built yet: the OpenAI-compatible adapter; the evals (golden conversations, recorded cassettes on PR, a live nightly run under a spend cap, a basic prompt-injection set, and a report that writes `AUDIT.md`, which publishes the judge's measured precision and recall beside the hallucination rate); and the parser that turns free text into a structured search request.

**judge.** The async auditor is the agent app's second process, `src/judge/`, started with `pnpm --filter @dastar/agent judge`, where `--once` judges what is due and exits. It reuses the `LLMProvider` interface and the Anthropic adapter, and connects through `@dastar/db` as `dastar_judge`, not as `dastar_app`. Its loop has the shape of the worker's, `{ everyMs, limit, drain }` with stats and a `stop()`. It takes the assistant turns that are due oldest first and judges one at a time: it builds the model's input from the turn's stored text, the user turn before it, and the reservations the session's calls showed, asks for the turn's statements in one request with no tools, and stores the result once, stamped with the model that answered, the hash of its prompt, and the accuracy entry that was measured for exactly that model, effort, and prompt. The decisions that follow the model's reply are core's pure functions above, so the judge and the audit cannot disagree about what a call showed. Section 13 gives its rules, section 6 its role.

**mcp.** stdio MCP server over the tool definitions, bound to one venue by its configuration. It checks its key before serving and refuses one that can confirm or administer. An optional `DASTAR_SESSION_ID` makes it send `Dastar-Session` with every tool call; it then checks, with the key and without the header, that the session is the key's and belongs to its venue, and refuses to start with one line otherwise.

---

## 6. Data model

Schema `dastar` for the engine, schema `dastar_agent` for transcripts. All timestamps `timestamptz`. All ranges `tstzrange` with `[)` bounds. Everything is owned by `dastar_owner`.

```
venue             id uuid pk default uuidv7(), name, timezone text,
                  hold_ttl_seconds int check (between 60 and 3600) default 600,
                  slot_minutes int check (in (5,10,15,20,30,60)) default 15,
                  availability_window_days int check (between 1 and 90) default 14,
                  max_live_holds_per_actor int check (between 1 and 100) default 5,
                  config jsonb default '{}', config_version bigint default 0, created_at
unit              id, venue_id, label, capacity_min int, capacity_max int, active bool, layout jsonb, created_at
                  unique (venue_id, id)
unit_combo        id, venue_id, label, unit_ids uuid[], capacity_min, capacity_max, active bool
                  unique (venue_id, id)
schedule          id, venue_id, day_of_week smallint (ISO, Monday = 1), opens time, closes time,
                  closes_next_day bool default false (true exactly when closes <= opens),
                  duration_by_size jsonb (largest party size -> minutes, 5 to 720), gap_minutes int, active bool
blackout          id, venue_id, during tstzrange (bounded, half-open, fixed once written), reason, active bool
reservation       id uuid pk default uuidv7(), venue_id, party_size int, during tstzrange,
                  status reservation_status, assignment_kind assignment_kind, assignment_id uuid,
                  hold_expires_at timestamptz, version int not null default 1,
                  confirm_token_hash bytea null, cancel_reason text null, external_ref text null,
                  created_at, updated_at
                  unique (venue_id, id); index (venue_id, external_ref) where external_ref is not null
reservation_unit  venue_id, reservation_id, unit_id, during tstzrange, active bool
                  pk (reservation_id, unit_id)
                  fk (venue_id, reservation_id) -> reservation (venue_id, id)
                  fk (venue_id, unit_id) -> unit (venue_id, id)
                  EXCLUDE USING gist (unit_id WITH =, during WITH &&) WHERE (active)
idempotency       venue_id, actor text, key text, request_hash bytea, response jsonb null,
                  created_at, purge_at timestamptz, pk (venue_id, actor, key)
audit_log         id bigint identity, venue_id, entity, entity_id uuid, action, before jsonb, after jsonb,
                  actor text, trace_id text, at timestamptz
outbox            id bigint identity, venue_id, topic, payload jsonb, payload_version int, created_at,
                  attempts int default 0, next_attempt_at timestamptz, published_at null, dead_lettered_at null
webhook_endpoint  id, venue_id null (null = all venues), url, secret_enc bytea, active bool, created_at
api_key           id uuid, label, key_hash bytea unique, capabilities text[], venue_ids uuid[] null (null = all),
                  created_at, revoked_at null
schema_migration  version int pk, name, checksum bytea, applied_at

dastar_agent.session       id uuid pk default uuidv7(), venue_id fk venue, api_key_id fk api_key,
                           kind session_kind (reference | external), started_at, last_seen_at,
                           call_count int not null default 0 check (>= 0), audit jsonb null, audited_at null,
                           judge_requested bool not null default false
                           unique (venue_id, id)
dastar_agent.tool_call     id bigint identity pk, session_id, venue_id, turn_id bigint null (no foreign key),
                           tool text, input jsonb, status int null, output jsonb null, receipt jsonb null,
                           started_at, completed_at null
                           fk (venue_id, session_id) -> session (venue_id, id) on delete cascade
dastar_agent.turn          id bigint identity pk, session_id, venue_id, seq int check (>= 0),
                           role (user | assistant), content text, claims jsonb null,
                           guardrail_fired bool default false, judge_result jsonb null, at null,
                           model text null, prompt_hash text null, provider_calls smallint null,
                           regenerations smallint null, fell_back bool null, input_tokens int null,
                           output_tokens int null, cache_read_tokens int null, cache_write_tokens int null,
                           latency_ms int null, judge_due bool not null default false
                           unique (session_id, seq)
                           fk (venue_id, session_id) -> session (venue_id, id) on delete cascade
dastar_agent.session_hold  session_id uuid, venue_id, reservation_id uuid, confirm_token_enc bytea not null,
                           created_at default dastar_now()
                           pk (session_id, reservation_id)
                           fk (venue_id, session_id) -> session (venue_id, id) on delete cascade
dastar_agent.judge_day     day date pk, calls int not null
```

The judge adds `session.judge_requested`, `turn.judge_due` and `dastar_agent.judge_day`, in migration 0028, the partial index below, in 0029, and a backfill of `judge_due`, in 0030. `judge_requested` is set by each audit post, true when the post asked for the judge, and read back with the audit; for a reference session it stays false. `turn.judge_due` is what makes a turn due, and the application sets it as it writes the turn: true on every reply of a reference session, and, for an external post, true on each assistant turn when the post asked for the judge and false otherwise, so the turns of a post that did not ask are never in the judge's scan. A post replaces a session's turns, so the latest post decides it. The application has the column in its insert grant. 0030 marks the reference assistant turns that already existed when 0028 was applied; it is a file of its own because 0028's `alter table` holds an exclusive lock on `turn` until its transaction ends, and an update of every reference turn there would keep every reader and writer of `turn` waiting, where its own update takes row locks only. External turns need no backfill, since before 0028 no post could ask for the judge. `turn.judge_result` is the judge's own column, and null until it has judged the turn. A judged result is `{ outcome: "judged", judged_at, model, effort, prompt_hash, mode, statements: [{ quote, claim, declared }], dropped, results, accuracy, usage }` and a failed one `{ outcome: "failed", judged_at, model?, prompt_hash, reason }`, with a `reason` of `too_long`, `refused`, `truncated`, `unparsable`, `provider_error`, or `provider_rejected` (section 13). `judge_day` holds the provider calls the judge has made on each UTC day, the count behind its daily cap, in a table that row-level security and no policy keep from every role without the bypass.

The reference agent adds `dastar_agent.session_hold` and the ten columns after `at` on `turn`, which are its turn record: the model that answered, a hash of the prompt, the provider calls and regenerations the turn took, whether it ended in the fallback, its tokens, and its latency in milliseconds. It writes them on its assistant turns only; every other turn has them null. They belong to the turn and not to the session, because a fallback model can answer a turn. `session_hold` keeps, for each reservation a session holds, the confirm token encrypted by the agent (section 10.6). For a reference session `tool_call.turn_id` stays null: a call belongs to a turn by time, which is exact because a session's turns are answered one at a time, and the matcher's timed mode reads it that way. The first three tables are what the audit of an external agent uses.

Enums: `reservation_status` = held, confirmed, seated, completed, cancelled, expired. `assignment_kind` = unit, combo. `session_kind` = reference, external.

Indexes.
- `reservation (hold_expires_at) WHERE status = 'held'` for the sweeper and conflict-time expiry.
- `reservation_unit` gist `(venue_id, during) WHERE active` for occupancy, via btree_gist.
- `outbox (next_attempt_at, id) WHERE published_at IS NULL AND dead_lettered_at IS NULL`.
- `outbox (published_at) WHERE published_at IS NOT NULL` for retention.
- `api_key (key_hash)` unique.
- `idempotency (purge_at)`.
- `audit_log (entity_id, at)`.
- `dastar_agent.tool_call (session_id, id)` for a session's calls in order, and the unique `(session_id, seq)` on `dastar_agent.turn` for its turns.
- `dastar_agent.turn (id) WHERE judge_due AND judge_result IS NULL` for the judge's scan for the due turns that have no result, in order of turn id; a turn nobody asked to have judged is not in it, so a tick with nothing due reads nothing. It is built concurrently in its own file, 0029, spelled as `pg_get_indexdef` prints it (D47).
- `dastar_agent.session (api_key_id)` for a key's sessions, and `dastar_agent.session (last_seen_at) WHERE kind = 'external'` for the purge of external sessions by the time they were last seen.

Notes.
- `reservation_unit.during` is the source of truth for the exclusion constraint. `reservation.during` is kept for queries; DA008 asserts equality.
- `reservation_unit.venue_id` is denormalized and immutable. The two composite foreign keys make a cross-venue attachment impossible.
- Booking a combo inserts one `reservation_unit` row per member. A deferred constraint trigger (DA010) asserts at commit that the sorted set of unit rows, active or not, equals the member set implied by the assignment.
- `unit.capacity_min` and `capacity_max` are current values (D40). Trigger DA012 on a capacity update acquires the unit's advisory lock, then rejects the change if any live reservation, by effective status, with `assignment_kind = 'unit'` on this unit would fall outside the new range.
- `effective_status` (D43) is a derived value, `expired` when `status = 'held' and hold_expires_at <= dastar_now()`, otherwise `status`. It is what every read path returns and what liveness means everywhere in this document; the stored column catches up when the sweeper or a hold's overlap pass expires the row. Completed, cancelled, and expired reservations are history and unaffected. The admin route's force option cancels the conflicting reservations through the cancel command before updating. Combos carry their own capacities and are immutable (D34).
- `active` is flipped to false by the sync trigger when status becomes cancelled or expired. The sync trigger is `SECURITY DEFINER`, and `dastar_app` has no UPDATE or DELETE privilege on `reservation_unit`, so nothing but that trigger can change `active` or remove a row; a direct attempt fails with 42501. Rows are inserted only at hold time with `active = true`, which the insert guard (DA008) checks along with the range.
- `unit_combo.unit_ids`, `capacity_min`, and `capacity_max` are immutable after insert (D34): `dastar_app` may update only `label` and `active`, and trigger DA011 backstops the rule for the owner role. Operators change a combo by deactivating it and creating a new one.
- `confirm_token_hash` stores sha256 of a 32-byte random token. Tokens are minted on demand through `POST /v1/reservations/:id/confirm-token`, which requires the `confirm` capability; the hold response never contains one. Minting again replaces the previous token. Confirm with a token nulls the hash.
- `version` is bumped by trigger on every update of `reservation`; client-supplied version changes are rejected.
- `venue.config_version` is bumped by trigger on writes to unit, unit_combo, schedule, blackout, and venue. It is never bumped by reservation writes.
- Idempotency: `actor` is `key:<api_key_id>` in API mode and the caller-supplied actor in library mode. `purge_at` is `created_at + 24h`; stored responses contain no secrets because hold responses carry no token. `request_hash` is computed over the parsed, canonicalized body, not raw bytes. The outcome is written under the key inside the same outer transaction that claimed it (D30, section 10.1), so a retry within the retention window returns the same outcome, and after purge the key is simply fresh.
- `reservation_unit` carries per-table autovacuum settings (`autovacuum_vacuum_scale_factor = 0.02`, `autovacuum_analyze_scale_factor = 0.02`) because every terminal hold leaves one dead entry in the exclusion index.
- `session_hold.confirm_token_enc` is encrypted by the agent app, with AES-256-GCM under the key in `DASTAR_TOKEN_KEY`, and bound to its row (section 10.6). `webhook_endpoint.secret_enc` is encrypted at rest with a key from the environment.
- `schedule.closes_next_day` expresses a service period that ends after midnight.
- Capabilities: `read`, `hold`, `cancel`, `confirm`, `seat`, `admin`, `demo`. Agent keys get `read, hold, cancel`; the tool executor further restricts cancel to reservations created in the same session.
- Retention: idempotency by `purge_at`; published outbox rows deleted after seven days; external audit sessions thirty days after they were last seen, as below; reference sessions are not purged; audit_log is never deleted, which is why no guest data may enter it.

Audit sessions.
- A session belongs to one key and one venue. `call_count` is raised, under the session's row lock, by the statement that begins a call while it is below `MAX_SESSION_CALLS` (10,000), so the cap is exact under concurrent calls and `GET /v1/sessions/:id` reads `calls` without counting rows. A call is begun with its tool and input and completed once with its HTTP status, its stored output, and its receipt; a call never completed has no `completed_at`, and the audit counts it as an unknown outcome. `last_seen_at` is the time of the session's latest begun call, or of its opening.
- The header rule. A call that carries `Dastar-Session: <id>` on one of the nine routes in section 9 is recorded as a `tool_call` row with the route's tool name, so an external agent gets the same receipt log as the reference agent. A call without the header runs the route and nothing else. With it, in this order: validation and the route's capability check come first, and a refusal by either is not recorded; no bearer key is 400 `validation`, `Dastar-Session needs a bearer key` (a confirm by token alone cannot be recorded); a session that is not the key's, does not exist, or is not live is 404 `not_found`, `no such session`; the call's venue, from the path or from the reservation the path names, must be the session's, else 422 `session_venue_mismatch`; a session that has recorded `MAX_SESSION_CALLS` calls refuses the next with 422 `session_full`. A reservation that is absent or outside the key's venues is recorded in the session's venue, and the route answers its own 404. The route then runs, and its completion is awaited before the response is returned; if recording the completion fails, the response is unchanged and the call stays pending.
- Recorded fields. A call stores only these, ids lowercased and absent fields left out:

| Tool | Input stored | Output stored (a 2xx answer) | Receipt |
|---|---|---|---|
| `hold` | `party_size`, `starts_at`, `duration_minutes`, `assignment` {`kind`, `id`}, `idempotency_key` | `hold_expires_at`, `replayed` | the answer's receipt |
| `list_holds` | none | `holds`: for each, `id`, `starts_at`, `party_size`, `hold_expires_at` | none |
| `search_availability` | `party_size`, `from`, `to` | `slots` (the count), `truncated` | none |
| `get_reservation` | `reservation_id` | `id`, `status`, `starts_at`, `party_size`, `hold_expires_at`, `version` | none |
| `cancel`, `seat`, `complete`, `confirm` | `reservation_id`, `expected_version` | none | the answer's receipt |
| `confirm_token` | `reservation_id`, `expected_version` | `version` | none |

A receipt keeps `reservation_id`, `status`, `version`, `audit_id`, and `trace_id`. An answer that is not 2xx keeps its problem's `code` as the output and no receipt. Never stored: the key, a confirm token, `external_ref`, a cancel reason, or a problem's detail.

- A receipt is verified, when the audit reads the session, if the venue's `audit_log` holds the row the receipt names: that `audit_id`, for that reservation, with the receipt's status, version, and trace id. A receipt that is not an object, lacks a field, or carries a value of the wrong type is unverified, never an error.
- Liveness and retention. `dastar_agent.session_live(kind, last_seen_at)` is the one rule: a reference session is always live, and an external session is live while it was last seen less than 30 days (720 hours) ago. The session lookup, the statement that begins a call, the audit write, and the reads of a session and of its audit refuse a session that is not live, so every session route answers 404 for it at once. The worker's retention job purges an external session, with its calls, turns, and audit, from 10 minutes after it stops being live: a transaction that began just before the line may still touch the session, and the margin keeps the purge from meeting it. It deletes in bounded batches, calls first, then turns, then the sessions that have none left, oldest first, repeated while a batch comes back full.

### 6.1 Roles and session settings

```sql
-- dastar_owner:    owns schema, tables, and functions; used only by the migration runner.
-- dastar_app:      USAGE on schemas, EXECUTE on the helper functions and the two venue lookups, and the table and column grants below.
--                  No ownership, no DELETE except on `dastar_agent.turn`, no TRUNCATE, no DDL. Subject to row-level security (M2).
-- dastar_worker:   dastar_app's grants on the engine's tables plus UPDATE on outbox and DELETE on idempotency and outbox
--                  for retention; only SELECT and DELETE on the dastar_agent tables; and BYPASSRLS. Used only by the worker container.
-- dastar_readonly: SELECT only.
-- dastar_judge:    LOGIN and BYPASSRLS; the judge's grants below. Used only by the judge process.
ALTER ROLE dastar_app SET statement_timeout = '10s';
ALTER ROLE dastar_app SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE dastar_worker SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE dastar_judge SET statement_timeout = '10s';
ALTER ROLE dastar_judge SET idle_in_transaction_session_timeout = '30s';
```

Grants for `dastar_app`:

| Table | Grants |
|---|---|
| unit, schedule, blackout, webhook_endpoint, api_key | SELECT, INSERT, UPDATE. No DELETE; rows are deactivated or revoked. Unit capacity updates pass through trigger DA012 |
| venue | SELECT, INSERT, UPDATE on the config columns only; `config_version` is written solely by the security-definer config-version trigger |
| unit_combo | SELECT, INSERT, UPDATE (label, active) |
| reservation | SELECT, INSERT, UPDATE (status, cancel_reason, confirm_token_hash, external_ref, updated_at). `during`, `party_size`, `assignment_kind`, `assignment_id`, `hold_expires_at`, `venue_id`, `version`, `created_at` are immutable for the app role |
| reservation_unit | SELECT, INSERT. No UPDATE, no DELETE |
| idempotency | SELECT, INSERT, UPDATE (response) |
| audit_log | SELECT only. The audit trigger is the only writer |
| outbox | SELECT, INSERT |
| schema_migration | SELECT |
| dastar_agent.session | SELECT, INSERT, UPDATE (last_seen_at, call_count, audit, audited_at, judge_requested). `api_key_id`, `venue_id`, and `kind` never change; no DELETE |
| dastar_agent.tool_call | SELECT, INSERT, UPDATE (status, output, receipt, completed_at). `tool` and `input` never change; no DELETE |
| dastar_agent.turn | SELECT, INSERT, DELETE. A new post of a transcript replaces a session's turns; no UPDATE. The insert grant is by column and covers every column but `id` (generated) and `judge_result`, the turn record's and `judge_due` included, so the application cannot write a judge's result by insert or by update; a column added later needs its own insert grant |
| dastar_agent.session_hold | SELECT, INSERT, UPDATE (confirm_token_enc). A session, venue, and reservation never change; no DELETE |

`dastar_app` also has USAGE on the `dastar_agent` identity sequences and EXECUTE on `dastar_agent.session_live` and `dastar_agent.session_venue`; `dastar_worker` has EXECUTE on `session_live`; `dastar_readonly` has SELECT on the three tables through a read-only policy, and none on `session_hold`, whose token is a credential even encrypted. The four tables carry the venue policy below, one migration each, so a transaction bound to one venue reads and writes only that venue's sessions, calls, turns, and token rows. `session_venue(session_id, api_key_id)` is an owner-run lookup that returns the venue of a live session the key owns, for a caller that holds only the session's id.

Grants for `dastar_judge`, which has USAGE on the `dastar` and `dastar_agent` schemas and bypasses row-level security, because it reads every venue's sessions, and holds nothing the work does not need:

| Object | Grants |
|---|---|
| dastar_agent.session, tool_call, turn | SELECT |
| dastar_agent.turn | UPDATE (judge_result), and no other column |
| dastar_agent.judge_day | SELECT, INSERT, UPDATE. Row-level security is on and no policy exists, so no role without the bypass reads or writes it |
| dastar.reservation | SELECT (id, venue_id, status, hold_expires_at), to say what a reservation is now |
| dastar.venue | SELECT (id, timezone), so that a start time can be given with the venue's offset |
| functions | EXECUTE on `dastar.dastar_now`, `dastar.effective_status`, and `dastar_agent.session_live` |

It has no grant on `dastar_agent.session_hold`, whose tokens are credentials even encrypted, on `dastar.audit_log` or `api_key`, or on any other table. The judge's reads need no receipt check, which is the audit's job, so it cannot read the audit log and its calls carry no verification (`receiptVerified` is null). The password is set with `DASTAR_JUDGE_PASSWORD` by `pnpm roles`, as for the other roles.

The three triggers that write rows other than the one being written, the audit insert, the unit-row flip, and the venue config-version bump, are `SECURITY DEFINER` functions owned by `dastar_owner` with a fixed `search_path`. From M2 the four triggers that read other rows to enforce an invariant (the fit check, the capacity guard, the unit-row insert guard, and the membership check) run the same way, so row-level security never changes what they see (ADR 6). A BEFORE trigger that edits the row being written, such as the version bump or the transition trigger clearing `confirm_token_hash`, is not in this class and runs with the caller's rights. Schema USAGE is granted in the same migration that defines the functions it makes callable (0003); table and column grants follow in 0005. That is what lets the app role be denied the privileges those triggers need. A BEFORE trigger may set `NEW.version` regardless of the caller's column grants, and the audit and sync triggers run as owner, which also means row-level security does not apply to them.

Two trust boundaries, and CORRECTNESS.md names which one each invariant sits behind.

Boundary A, adversarial. Invariants 1, 2, 4, 5, 7, 8, 9 and the supporting guards hold against a `dastar_app` that is buggy or hostile: it can issue any SQL its grants allow, set any custom setting it likes, and still cannot overlap two reservations, confirm an expired hold, confirm outside the state table, forge or edit an audit row, flip or delete a unit row, extend a hold, change a combo's members, or attach a unit from another venue. The attack suite exercises exactly this: forged internal settings, deleted unit rows, direct audit inserts, edits to `hold_expires_at`, edits to combo members, truncation.

Boundary B, declared context. `dastar.actor`, `dastar.trace_id`, and `dastar.venue_id` are declarations by the caller. The database enforces that they are present (DA007) and that a transaction is internally consistent with its declared venue (row-level security, invariant 10). It cannot verify that the declaration is true, because custom settings are user-settable and the app role can address every venue. What authenticates the declaration is the API key check in the API process, or the host application in embedded mode. Invariant 3 also sits here: the actor in the idempotency key is whatever the caller declared. CORRECTNESS.md states this plainly rather than implying the database authenticates tenants.

Row-level security, M2, boundary B. Every venue-scoped table gets `ENABLE ROW LEVEL SECURITY` and one policy for `dastar_app` of the form (on `venue` the column is `id`) `USING (venue_id = nullif(current_setting('dastar.venue_id', true), '')::uuid) WITH CHECK (same)`; the `nullif` turns the empty string a finished transaction-local setting leaves behind into no venue. It contains a bug that mixes venues inside one transaction, and it fails closed when the context is missing; it does not stop a caller that declares the wrong venue on purpose. `api_key` and `schema_migration` are not venue-scoped and carry no policy; key lookup happens before the venue is known. A route addressed by a reservation id finds the reservation's venue through an owner-run lookup, checks it against the key's scope, and then binds it (ADR 6); a route addressed by a session id does the same through `dastar_agent.session_venue`, which also requires that the key owns the session and that it is live. Foreign-key checks run as the table owner and are unaffected. The exclusion constraint checks the whole table regardless of policy, which is correct because a unit belongs to exactly one venue.

### 6.2 Clock

Production migration:

```sql
create function dastar_now() returns timestamptz language sql stable as $$ select now() $$;
```

Test setup, applied by the test harness as `dastar_owner` and never part of the numbered migrations:

```sql
create or replace function dastar_now() returns timestamptz language sql stable as $$
  select coalesce(nullif(current_setting('dastar.now', true), '')::timestamptz, now())
$$;
```

`dastar_app` cannot replace the function, so the override cannot exist in production. `now()` is transaction start time, so time is monotonic inside a transaction. Consequence: a confirm that waits on a row lock evaluates expiry against its own start time, granting a grace equal to its wait. Documented in CORRECTNESS.md as a property, not a bug.

### 6.3 Migration runner

Ordered SQL files, each applied according to its declared transaction mode, with `SET lock_timeout = '3s'` and up to five retries on lock timeout. The whole run holds `pg_advisory_lock` on a fixed key so two migrate containers cannot interleave. Checksums of applied files are verified on every run; a mismatch aborts. Forward-only; no down migrations. Expand-then-contract from migration 002: a column or constraint is added in one release and old shapes are removed only after the code that needed them is gone.

What `lock_timeout` does and does not do. It bounds how long a migration waits to acquire a lock, so a deploy fails loudly instead of queueing all traffic behind a lock request. It does not bound how long the migration holds the lock once acquired, and it says nothing about how much data a statement scans. Three properties of a migration are therefore tracked separately rather than folded into one label:

| Property | Values | Examples |
|---|---|---|
| Transaction compatibility | runs inside the runner's transaction, or must run outside one | `CREATE INDEX CONCURRENTLY` must run outside a transaction block. `VALIDATE CONSTRAINT`, `ADD COLUMN`, trigger changes, and plain `CREATE INDEX` run inside one |
| Locking impact | blocks nothing, blocks writes, or blocks reads and writes on the table | `VALIDATE CONSTRAINT` takes a lock that blocks neither reads nor writes. A plain `CREATE INDEX` blocks writes and permits reads. `ADD COLUMN`, `ADD CONSTRAINT ... NOT VALID`, and attaching or replacing a trigger take a lock that blocks everything, briefly. A table rewrite blocks everything for its whole duration |
| Expected duration | instant, or proportional to table size | `ADD COLUMN` with a null default and `NOT VALID` are instant. `CREATE INDEX CONCURRENTLY`, `VALIDATE CONSTRAINT`, and plain `CREATE INDEX` scan the table. A rewrite scans and rewrites it |

Each migration file declares two headers: `transaction: yes|no`, which the runner honors, and `impact`, one of `instant-exclusive`, `long-nonblocking`, `long-blocks-writes`, or `long-blocks-all`. The runner applies `instant-exclusive` and `long-nonblocking` migrations against a live system under `lock_timeout`; it refuses `long-blocks-writes` and `long-blocks-all` unless a maintenance window is explicitly asserted on the command line. Under this scheme, the preferred live-safe pattern for a new index is `CREATE INDEX CONCURRENTLY` outside a transaction, and for a new constraint it is `NOT VALID` followed by `VALIDATE CONSTRAINT` in a later file. Migration under load is a hypothesis (H6) with a named test in 15.1.

Runner decision, reconsidered in v0.10. The runner is kept for v0.1 and bounded to five behaviors: ordered files, checksums, the advisory run lock, per-file transactional or concurrent mode, and lock timeout with retry. No existing tool provides all five without workarounds. If a sixth behavior becomes necessary, an existing tool is adopted instead of growing the runner.

Nontransactional files, D47. A file declared `transaction: no` must contain exactly one statement, either `create [unique] index concurrently if not exists <name> on <schema>.<table> using <method> (...)` or `drop index concurrently if exists <schema>.<name>`, spelled as `pg_get_indexdef` would print it. Before a create, the runner looks up any relation of that name in that schema: none, apply; an index on the same table with the same definition, valid and ready, record the checksum without rebuilding; the same but invalid, drop it concurrently and apply; anything else, abort without dropping. `lock_timeout` is set per attempt and reset afterwards; the checksum is recorded only after success.

### 6.4 Trigger conventions

- One trigger function per invariant or supporting guard, each short enough to read in one screen. Triggers check and raise; the only three that write rows other than the one being written are the audit insert, the unit-row flip on terminal status, and the venue config-version bump, and those three are `SECURITY DEFINER` with a fixed `search_path` so the app role can be denied the underlying privileges.
- Trigger names carry a numeric prefix (`t10_actor_required`, `t20_transition`, `t30_expiry_guard`, ...) because Postgres fires same-event triggers in alphabetical order. The order is therefore explicit and reviewable, and CORRECTNESS.md lists it.
- Every `RAISE` uses `ERRCODE` for the SQLSTATE, `MESSAGE` for a one-line description, `DETAIL` for the ids involved, and `HINT` naming the invariant. The mapper turns these into typed errors with the same fields, so a trigger failure in production reads like an application error.
- The transition trigger is a seven-pair allowlist evaluated only when `NEW.status IS DISTINCT FROM OLD.status`. Same-status updates are metadata updates governed by column grants and section 8. The thirty-six-pair matrix in the tests is the proof, not the code.
- The audit trigger redacts `confirm_token_hash` from its before and after images.
- CORRECTNESS.md carries a trigger inventory: name, table, event, order, invariant, and the test that exercises it.

### 6.5 Workload bounds and provisional targets

Bounds a request may not exceed, enforced where the database can and rejected at the API otherwise:

| Bound | Value | Enforcement | Behavior beyond it |
|---|---|---|---|
| Combo size | 2 to 6 units | CHECK on `unit_combo` (`cardinality(unit_ids)`) | Admin route returns 422 `combo_too_large` |
| Booking duration | 5 minutes to 12 hours | CHECK on `reservation.during` (bounded, `upper - lower` within range) | 422 `duration_out_of_range`, mapped from 23514 by constraint name |
| Overlap lock set per hold | 64 reservation rows | Counted in step 5 of 10.1 before any row lock is taken | 503 `overlap_set_too_large` with Retry-After, retryable; a metric fires, since a healthy system never approaches it: for a future request the set is live conflicts plus unswept dead holds |
| Live holds per actor | 5, venue config | Policy check in the hold command | 429 `too_many_live_holds` |
| Availability window | 14 days, venue config | Policy check | 422 `window_too_large` |
| Availability results | 100 per request, at most 500; 10,000 grid starts examined | Policy in the availability command | `truncated: true` |
| Forced cancellations | 200 per admin write, none seated or past its start | Policy in the admin commands | 422 `force_too_large`, 409 `reservation_in_progress` |
| Units per venue | 200, soft | Not enforced | Documented in LIMITATIONS.md as the initial target scale |

Provisional workload target, for the prototype's go or refine decision. Labeled provisional: the numbers exist so a benchmark can support a decision, not because they are known to be achievable.

- Shape: one venue, 40 units, 10 combos, 15-minute slots. Offered load 50 holds per second sustained for 10 minutes, mixed 40 percent overlapping slots on the ten most popular units, 30 percent non-overlapping dates on the same units, 20 percent disjoint units, 10 percent combos. Confirm and cancel at 20 percent of hold volume. Sweeper on. Machine: the 4 vCPU 8 GB class with local Postgres.
- Targets: hold end-to-end p95 at or under 150 ms and p99 at or under 500 ms; pool-acquire wait p99 at or under 50 ms; advisory-lock wait p99 at or under 100 ms on the non-overlapping-dates mix, which is the direct measure of the D39 cost; zero deadlocks; error rate excluding legitimate conflicts at or under 0.1 percent; the race at N=5000 completes with one winner and zero overlaps.
- Measurement scope. End-to-end latency and the error rate are measured over HTTP against the reference API, with the API in its own process: authentication, validation, and the key lookup's pool checkout are part of what a caller waits for. Pool-acquire wait and lock wait cannot be seen from outside the process, so they are measured at the engine handle under the same arrival plan, and they cover the command's checkout only. What the harness can observe for locks is the unit-lock phase: the lock statements for the assignment's units, one round trip each plus any advisory-lock wait. A request that ends inside that phase is a lower bound on it: it can show a limit broken, never kept. A percentile with too few samples to state, or whose bounds straddle the limit, is no result, not a pass, and no verdict is taken from a run whose confirmations, cancellations, or sweeper failed. A run that offered less than the shape above, or a different one, can miss these targets and cannot meet them.
- Decision rule: all targets met, the baseline stands and these numbers become the first line of BENCHMARKS.md. Advisory-lock wait on non-overlapping dates dominates p99 while everything else passes, the D39 refinement is scheduled for M2 with its coordination requirements stated in D39. Anything else misses, investigate the cause before touching the lock protocol.


---

## 7. Invariants

Each holds against the `dastar_app` role even when the application is adversarial (boundary A in 6.1), except invariants 3 and 10, which depend on declared context (boundary B). The attack suite connects as `dastar_app`.

| # | Invariant | Guard | SQLSTATE | Core error | Proving test |
|---|---|---|---|---|---|
| 1 | No unit is held or confirmed by two reservations with overlapping ranges | Exclusion constraint on active `reservation_unit` rows | 23P01 | hold_conflict | Race harness; attack: raw overlapping insert |
| 2 | An expired hold cannot be confirmed | BEFORE UPDATE trigger on reservation using `dastar_now()` | DA001 | hold_expired | Attack: set test clock past expiry, update status |
| 3 | Same actor, key, and payload returns the same outcome, success or domain error, within the 24-hour retention window, and creates nothing; different payload is rejected | PK on (venue, actor, key) plus hash check; the key is owned by one outer transaction from claim to stored outcome | 23505 / DA002 | idempotency_replay / idempotency_mismatch | Retry test; crash-after-commit test; lost-conflict retry test; concurrent same-key test |
| 4 | Assigned unit or combo fits the party within min and max, and stays fitting while the reservation is live | BEFORE INSERT/UPDATE trigger on reservation; BEFORE UPDATE OF capacity trigger on unit that takes the unit's advisory lock and checks live reservations; combo capacities immutable | DA003 / DA012 | party_does_not_fit / capacity_conflict | Attack: party 9 on a 4-top; shrink a 4-top to 2 under a live party of 4; capacity edit racing a hold from two connections; property tests |
| 5 | Audit log is append-only and written only by the audit trigger | BEFORE UPDATE/DELETE row trigger and BEFORE TRUNCATE statement trigger; `dastar_app` has SELECT only; the audit trigger is `SECURITY DEFINER` | DA004 / 42501 | audit_immutable | Attack: update, delete, truncate, and direct insert as app role |
| 6 | Every state transition writes an audit row | AFTER trigger on reservation | n/a | n/a | Audit row count equals transitions after random sequences; outbox completeness proven by the model-based test |
| 7 | Only transitions in the state table are possible | Hand-written BEFORE UPDATE trigger | DA005 | invalid_transition | Attack: completed to held; exhaustive test over all 36 from-to pairs |
| 8 | Every unit row of a reservation is active iff the reservation occupies its units, that is, its stored status is not cancelled or expired; completed rows stay active as history | The `SECURITY DEFINER` sync trigger is the only writer of `active`; `dastar_app` has no UPDATE or DELETE on unit rows; inserts must carry `active = true` for a held reservation | 42501 / DA006 | unit_rows_immutable | Attack: flip active by hand, delete a unit row, forge the old internal setting; complete a reservation and check rows stay active; model-based tests |
| 9 | The unit rows of a reservation, active or not, are exactly the members of its assignment in its venue, and that member set never changes after the hold | Deferred constraint trigger at commit compares the row set, ignoring `active`, to the assignment's members; composite foreign keys; combo immutability (D34) | DA010 / DA011 | assignment_mismatch / combo_immutable | Attack: combo A+B on the row with a unit row for table nine; unit from another venue; edit a combo's members; cancel, then check the rows remain and are inactive |
| 10 (M2) | A transaction bound to venue A cannot read or write venue B's rows, and an unbound transaction reads and writes nothing (apart from the reservation venue lookups, ADR 6) | Row-level security policies on `dastar.venue_id`, enforced for `dastar_app` | 42501 on write | venue_scope_violation | Attack as `dastar_app`: bound to A, select B's reservations returns zero rows, insert into B raises; unbound select returns zero rows |
| 11 (M2) | A live reservation never overlaps an active blackout of its venue | Owner-run guards under a venue-level advisory lock, shared for reservation inserts and confirmations and exclusive for blackout writes (ADR 7) | DA009 on a reservation insert or confirmation, DA014 on a blackout write | blackout, blackout_conflict | Two connections, both orders: a blackout write behind a hold or a confirmation in flight is refused; a hold behind a blackout write returns the stored blackout outcome, and a confirmation behind one written on a clock past the hold's expiry is refused |
| 12 (M2) | A live reservation never uses an inactive unit or combination | The fit trigger refuses a new reservation on an inactive unit, combination, or member after its unit locks; owner-run guards refuse a deactivation while a live reservation uses the unit or combination, under the same unit locks | DA015 on insert, DA016 on deactivation | assignment_inactive, assignment_in_use | Two connections, both orders: a deactivation behind a hold in flight is refused; a hold, or a confirmation, behind a deactivation is refused by the fit trigger |

Supporting guards: DA007 `actor_required`; DA008 `range_mismatch`, which also requires `active = true` and a held reservation on insert; DA009 `blackout` (M2, invariant 11, with DA014 `blackout_conflict` on blackout writes; ADR 7); DA011 `combo_immutable`; DA012 `capacity_conflict`; DA015 `assignment_inactive` and DA016 `assignment_in_use` (M2, invariant 12); DA017 `invalid_timezone` (M2, a venue's time zone must be an exact name in Postgres's time zone database); DA013 `token_requires_held`, which fires when `confirm_token_hash` changes to a non-null value and requires `OLD.status = 'held'`, `NEW.status = 'held'`, and `OLD.hold_expires_at > dastar_now()`. Clearing the hash is never rejected, and the transition trigger sets it to null on every transition out of held, so confirmation consumes the token and cancellation or expiry discards it. Column grants make the reservation's range, party size, assignment, expiry, venue, and version immutable for the app role, so a direct edit fails with 42501 before any trigger runs.

Retryable errors, never surfaced as invariant failures: 40P01 deadlock_detected and 40001 serialization_failure map to `serialization_conflict`; commands retry once, then the API returns 409 with `Retry-After: 0`.

Isolation: READ COMMITTED everywhere. The reservation row is the lock point for every state change: confirm, cancel, seat, complete, and expiry all UPDATE `reservation` first, and the sync trigger touches `reservation_unit` inside that statement's trigger context.

Unit lock protocol (D39). A transaction-level advisory lock per unit, keyed by unit id, acquired in sorted unit order. The hold command acquires the locks for its assignment at the start of the outer transaction, before any savepoint. The fit trigger acquires the same locks on reservation insert, and the capacity trigger acquires the unit's lock on a capacity update, so the capacity race is closed even for a caller that bypasses the command.

Overlap lock set (D20). Before its booking attempt, a hold locks every occupying reservation that has an active unit row on any requested unit within the requested range, dead or live, in reservation-id order: a first statement collects the distinct ids, a second selects those rows `ORDER BY id FOR UPDATE`, which acquires the locks in that order. It then expires the dead ones through the expire command path. The set is stable while the hold runs, because the advisory locks stop any new unit row from appearing on those units and rows are never deleted, and its order does not depend on which requested unit discovered a reservation.

Why the reference paths are designed not to deadlock (H1). A hold acquires resources in three ordered stages and never returns to an earlier one: advisory locks in unit order (from M2 preceded by the venue lock, shared; ADR 7), then reservation row locks in id order, then its own inserts. Two holds that share a unit serialize at the first stage. Two holds on disjoint units can meet at the second stage on the same combo reservations, and both lock them in id order, so one simply waits. By the time a hold inserts, it holds a row lock on every reservation that could be flipping a unit row on its units, so its inserts are designed to wait on nothing. Confirm takes the same advisory locks as a hold before its own reservation row (0006; the venue lock from M2); cancel and token minting wait only on their own reservation row and hold nothing else; a blackout write (M2) takes the venue lock exclusively and then waits on no lock a hold holds; the sweeper skips locked rows and waits on nothing; the capacity trigger waits only on the unit lock. The intended wait-for graph among these paths has no cycle; the interleaving tests and the mixed-load run in 15.1 are what would falsify this. The third review's interleaving, a retained expiry lock against a fresh insert on a lower unit, is prevented at the first stage. The fourth review's interleaving, holds on U1 and U4 against U2 and U3 both expiring combos U1 and U3 and U2 and U4, is prevented at the second stage. Both are named two-connection tests and must produce a queue, never a deadlock: one winner in the shared-unit case, two winners in the disjoint-unit case.

This is a liveness property of the reference command path, not a correctness property. A caller that bypasses the advisory locks with raw SQL can cause a retryable deadlock and never an overlap. 40P01 and 40001 stay mapped to `serialization_conflict` and are retried once as defense in depth, and the mixed-load harness asserts that the count is zero. Until the prototype and its full trigger behavior have run the named interleavings, zero deadlocks is a hypothesis, not a result.

Holds occupy inventory for their TTL by design. Under a rush the levers are a short per-venue TTL and the per-actor live-holds cap, and LIMITATIONS.md says so. The lost-conflict case that would otherwise create a hold the client never sees is closed by D30.

### 7.1 Guarantees versus hypotheses

Nothing in this section is proven. The distinction is between properties the database is designed to enforce, which the attack suite and interleaving tests either confirm or falsify, and properties of runtime behavior that only measurement can settle.

Designed guarantees, unproven until the prototype's tests run:

- G1. Invariants 1, 2, and 4 to 9 hold against `dastar_app` within boundary A (6.1). Invariant 3 depends on the declared actor and sits in boundary B; it is covered by G2, not G1. Falsified by any attack-suite case that succeeds.
- G2. Invariant 3, outcome ownership per idempotency key within retention. Falsified by the concurrent same-key and crash tests.
- G3. The token lifecycle (D44). Falsified by the mint, consume, and clear tests.
- G4. Effective status semantics (D43). Falsified by the sweeper-disabled tests.

Hypotheses, to be validated experimentally in the prototype (15.1); the design may be wrong about any of them:

- H1. Zero deadlocks on the reference paths under the named interleavings and the mixed-load run.
- H2. Hold transaction duration, and therefore the cost of per-unit serialization across unrelated dates. Unmeasured.
- H3. Throughput and latency at the provisional workload target in 6.5.
- H4. The pool of 16 with a 5s acquire timeout and the 10s statement timeout produce the documented exhaustion behavior and recover cleanly.
- H5. Autovacuum keeps pace with unit-row churn. The settings in section 6 are initial tuning values, not proof.
- H6. Migrations can be applied under load without dropping traffic.

Passing every test in 15.1 is evidence for the tested workloads and failure scenarios, not a universal proof of deadlock freedom or scalability; the document says so wherever a result is reported. Wording rule for this document: runtime behavior is described as "designed to" or "expected to", never as certain, and each such statement names the test that would falsify it. Words such as "bulletproof" and "mathematically" do not appear.


---

## 8. State machine

Defined once as data in core, hand-written into the SQL trigger, with an exhaustive test.

| From | To | Trigger | Guard | Actor |
|---|---|---|---|---|
| held | confirmed | confirm | `hold_expires_at > dastar_now()`; token valid or key has `confirm` | key or token |
| held | cancelled | cancel | none | key with `cancel` |
| held | expired | expire | `hold_expires_at <= dastar_now()` | system:sweeper or system:conflict |
| confirmed | seated | seat | none | key with `seat` |
| confirmed | cancelled | cancel | reason required, includes no_show | key with `cancel` |
| seated | completed | complete | none | key with `seat` |
| seated | cancelled | cancel | reason required | key with `cancel` |

Terminal: completed, cancelled, expired. `version` increments on every transition. Two racing confirms: the loser gets `version_conflict` if it supplied `expected_version`, otherwise `invalid_transition`. That second outcome is the command layer's: after taking the row lock and checking any supplied version, confirm requires stored status `held`, cancel requires `held`, `confirmed`, or `seated`, seat requires `confirmed`, and complete requires `seated`; each raises `invalid_transition` otherwise. At the database boundary a same-status write is a metadata update, which is not a transition and cannot violate an invariant, so the trigger does not and cannot reject it; the row trigger cannot see a statement's SET list.

Two words used throughout, each tied to one kind of status. A reservation occupies its units when its stored status is not cancelled or expired; its unit rows are active, completed reservations keep occupying their past range as history, and an expired-but-unswept hold still occupies until the sweeper or a hold's overlap pass moves its stored status. A reservation is live when its effective status (D43) is held, confirmed, or seated; only live reservations are subject to capacity and blackout checks and to the force option in admin edits. Occupancy is a fact about rows; liveness is a fact about time.

Transitions versus metadata updates (D41). The transition trigger evaluates the allowlist only when status changes. An update that leaves status unchanged is a metadata update, limited by column grants to `confirm_token_hash`, `external_ref`, `cancel_reason`, and `updated_at`; it bumps `version` and writes an audit row like any other update. Token minting is a metadata update that additionally requires a held, unexpired reservation before and after the update (DA013), replaces any previous hash, and bumps version. Clearing the hash is always permitted: confirmation clears it as it consumes the token, and the transition trigger clears it on every transition out of held, so a token never outlives its hold (D44). The UI reads the reservation after minting, so the `expected_version` it sends to confirm is the post-mint version, and a client holding an older version sees `version_conflict`, which is the intended lost-update guard.

---

## 9. API

Base `/v1`. JSON. Zod-validated. Errors are RFC 9457 Problem Details with `type: https://dastar.dev/errors/<code>` and the core error code. Auth: `Authorization: Bearer <key>`; keys are hashed with sha256 and looked up by the unique hash index. Idempotency: `Idempotency-Key` header, required on hold. Rate limit headers per the IETF draft. Every mutating response carries a receipt:

```
receipt: { reservation_id, status, version, audit_id, trace_id }
```

| Method | Path | Capability | Milestone | Notes |
|---|---|---|---|---|
| POST | /v1/venues/:id/holds | hold | M1 | Body: party_size, starts_at, duration_minutes, assignment {kind, id}, external_ref?. Returns receipt and hold_expires_at. Never a token |
| POST | /v1/reservations/:id/confirm-token | confirm | M1 | Mints a single-use confirm token for a human channel such as a UI button or a link; replaces any previous token; the caller, not the agent, decides who receives it |
| POST | /v1/reservations/:id/confirm | confirm or token | M1 | Body: confirm_token?, expected_version? |
| POST | /v1/reservations/:id/cancel | cancel | M1 | Body: reason, expected_version? |
| GET | /v1/reservations/:id | read | M1 | Returns `status` as effective status by database time (D43), `stored_status`, `starts_at` (the start of the range), `hold_expires_at`, `version`, and history from audit_log |
| GET | /health/live, /health/ready | none | M1 | Ready means database reachable and migrations applied |
| GET | /openapi.json | none | M1 | The committed document, `apps/api/openapi.json` |
| GET | /docs | none | M2 | Swagger UI over /openapi.json, served from the installed package under a same-origin content security policy |
| POST | /v1/reservations/:id/seat, /complete | seat | M2 | |
| POST | /v1/venues/:id/availability | read | M2 | Body: party_size, from, to, limit?. Each slot carries the exact `{starts_at, duration_minutes, assignment}` to pass to hold; `truncated` says the list was cut short |
| GET | /v1/venues/:id/floor-plan | read | M2 | Units with current occupancy |
| GET | /v1/venues/:id/holds | read | M2 | Live holds belonging to the calling actor, so a client can find and release holds it lost track of; each carries `starts_at` beside `during` |
| GET, POST, PATCH | /admin/venues/:id/{units,combos,schedules,blackouts} | admin | M2 | Reject-or-force on stranded bookings (D49): a refusal is 409 or 422 with the stranded ids, a forced change returns the cancelled ids. Combination members and capacities are fixed (D34). Webhooks in M4 |
| GET, POST | /admin/venues/:id/keys, /admin/venues/:id/keys/:keyId/revoke | admin | M2 | Keys scoped to exactly the venue, with any of the six capabilities; the secret is returned once at creation; revoking is idempotent. Keys of several venues or all venues stay with the host (the CLI) |
| POST | /admin/outbox/:id/replay | admin | M4 | Dead-letter replay |
| POST | /demo/race | demo | M5 | Body: n <= 100. Advisory lock per venue |
| POST | /demo/chat | none | M3 | Served by the reference agent, `apps/agent`, on its own port (`AGENT_PORT`, 8081 by default), not by this API. Body `{ session_id?, message }`: one agent turn, answered as below. No authentication; the agent binds `127.0.0.1` unless `AGENT_HOST` says otherwise, and public controls belong to M5 (section 14) |
| POST | /v1/sessions | read | M3 | Body: venue_id. Opens an external audit session bound to the calling key and the venue; 201 with `id`, `venue_id`, `kind`, `started_at`. Later calls carrying `Dastar-Session: <id>` record their receipts under it. 403 `forbidden`, `a key that can confirm or administer cannot open an audit session`; 404 for a venue outside the key's venues or one that does not exist |
| GET | /v1/sessions/:id | read | M3 | The key's own session: `id`, `venue_id`, `kind`, `started_at`, `last_seen_at`, `calls`, `audited_at` (null before the first audit). 404 `not_found`, `no such session`, for another key's session, one that does not exist, and an external one not seen for 30 days |
| POST | /v1/sessions/:id/audit | read | M3 | Body: `turns`, 1 to 500, and optionally `judge`, a boolean that is false when absent. Each turn has a `role` (`user` or `assistant`), `text` (1 to 20000 characters), `at` (an instant with an offset) on every turn or on none, and on an assistant turn at most 50 `claims`. A claim is `reservation_id`, `status` (one of the six), and optionally `starts_at` (with an offset), `party_size` (1 to 999), `quote` (1 to 500 characters). At most 1000 distinct reservations in all. Text and quotes are scrubbed, the turns replace any earlier post's, the post's `judge` replaces the earlier post's, and the matcher runs. With `judge: true` each assistant turn becomes due for the judge, which sends its text, the user turn before it, and the session's reservation ids, times, and party sizes to the operator's model provider (section 10.7), and the audit's `undeclared` is `pending`. 200 with the audit; 400 `validation` for a transcript that breaks a rule, and nothing is stored; 404 `no such session`, which a reference session also gets, since its turns are the agent's own record |
| GET | /v1/sessions/:id/audit | read | M3 | The latest audit, as the post returned it, except that `undeclared` is read from the assistant turns' judge results as they stand when the latest post asked for the judge. 404 `not_found`, `the session has no audit yet`, before the first post; 404 `no such session` otherwise as above |

The audit result, for each claim: its `turn` (the 0-based position of the turn in the posted transcript), the `claim`, `verdict` (`backed` or `unbacked`), a `reason` when unbacked (`no_observation`, `observed_later`, `status_mismatch`, `starts_at_mismatch`, `party_size_mismatch`), the `observed` state it was read against, the reservation's `receipts` up to the claim (the latest 10, with `receipts_omitted` counting the earlier ones), `current_status`, and `current_differs`. Beside the results: `session_id`, `audited_at`, `mode` (`timed` or `coarse`), `claims` {`total`, `backed`, `unbacked`}, `receipts` {`recorded`, `verified`, `unverified`}, `unknown_outcomes`, `confirmations`, and `undeclared`.

`undeclared` is `"not checked"` when the latest post did not ask for the judge, so a stored audit from before the judge reads so too. When it did, the post answers `"pending"`, and the read answers `"pending"` while any assistant turn has no judge result, and, once every one has, an object (a transcript with no assistant turn has nothing to wait for, so the post answers that object at once, with every count zero, as the read does). A result that records a failure counts in `failed_turns` whatever its reason; only a turn with no result, or a stored value that is not a judge result, keeps the read `"pending"`. The object: `checked_turns` (the assistant turns with a judged result) and `failed_turns` (those whose result is a failure); `statements` (all those the judge found in the judged turns) and `declared` (those a claim of the same turn covers); `undeclared` {`total`, `backed`, `unbacked`, `unresolved`}; `results`, one for each undeclared statement, with its `turn` (the 0-based position, as for claims), its `quote`, its `claim` (`reservation_id`, which is null when the text names none the session observed, `status`, and `starts_at` and `party_size` when the text gives them), `verdict` (`backed`, `unbacked`, or `unresolved`), `reason` when unbacked, `observed`, `current_status`, and `current_differs`; and `judges`, each distinct `model`, `effort`, and `prompt_hash` among the results with its `accuracy`, `null` unless a measurement of exactly that model, effort, and prompt was in `apps/agent/judge/accuracy.json` when the turn was judged. `unresolved` counts as neither backed nor unbacked. What the judge reports is the matcher's verdicts on what a model read in the text; section 13 gives the rules, and ADR 9 the reason the model decides none of them.

The chat route, `POST /demo/chat`, is served by the reference agent and takes `application/json`: `session_id` (a uuid, optional) and `message` (up to 2,000 characters, not only white space, with no U+0000 and no unpaired surrogate), and nothing else. Without a `session_id` the agent opens a reference session for its venue and key. The body is limited to 16 KB. A turn answers 200 with `session_id`; `reply`, the message and its `claims` (`reservation_id`, `status`, `starts_at`, `party_size`, each required); `holds`, one entry for each reservation the session created that a server read shows held, with `reservation_id`, `party_size`, `starts_at`, `duration_minutes`, `hold_expires_at`, and `confirm_token`; and `guardrail`, `{ fired, regenerations, fallback }`. Refusals are Problem Details in the API's shape, with `type`, `title`, `status`, `code`, `detail` (not on a 500), and a `trace_id` that is also the `x-trace-id` header, taken from the request's own when it is one of 1 to 100 characters from letters, digits, and `._:-`. 400 `validation`: the schema's issues as `<path>: <message>; ...`, `the request body must be application/json`, `the request body is not valid JSON`, `request body too large`, or what is wrong with the message. 404 `not_found`: `no such session` for a session that does not exist, is not a reference session, or belongs to another key or venue, and `no such route` for any other path or method. 409 `turn_in_progress`: `the session is still answering its previous message`, or, when the previous message was closed after its deadline while this one was being answered, `the session's previous message was closed after its deadline`. 422 `conversation_full`: `the conversation has reached 50 messages, its limit`. 500 `internal`, for any other failure of the agent, a failure of its database among them, with no detail; a user turn that was already claimed stays so, and a later request closes it once it is older than 240 seconds. A refusal by the provider, a provider failure, and a turn past its deadline are not HTTP errors: the turn ends in the fallback and `guardrail` says so. The person confirms a hold with `POST /v1/reservations/:id/confirm` and the entry's `confirm_token`, and no key. Each request is logged as one JSON line with its method, path, status, duration, and trace id, never a body. A failed call to the model is logged as one JSON line with the session's id and the error's message, and an unexpected failure of a request, the 500 above, with its trace id and the error's message; neither line holds a body, a header, a request to the model, or a key.

The `Dastar-Session` header is declared on exactly nine routes: `POST` and `GET /v1/venues/:id/holds`, `POST /v1/venues/:id/availability`, `GET /v1/reservations/:id`, and `POST /v1/reservations/:id/{cancel,seat,complete,confirm-token,confirm}`. It must be a uuid. Its refusals, after the route's own validation and capability checks: 400 `validation`, `Dastar-Session needs a bearer key`; 404 `not_found`, `no such session`; 422 `session_venue_mismatch`, `the call's venue is not the session's`; 422 `session_full`, `the session has recorded 10000 calls, its limit`. Section 6 gives the order and what is recorded.

Request bodies are limited to 64 KB and a larger one is refused as 400 `validation`. The audit post alone takes up to 1 MiB; it checks the key first, so a request without a valid key is refused with 401 before its body is read.

Hold is deliberately dumb: it receives an explicit assignment and range and lets the constraint decide. Availability is smart and stateless and may be stale; the constraint is the judge. Outside-schedule bookings are a policy check in the API, not an invariant, because walk-ins and manual bookings are legitimate: the reference API's hold refuses a range that no service period of the venue contains, when the venue has any (`outside_schedule`), after the idempotency claim and without storing the refusal; a hold through the engine is checked only when its caller asks. The live-holds-per-actor cap is likewise a policy check, not an invariant.

HTTP mapping: hold_conflict, hold_expired, invalid_transition, version_conflict, serialization_conflict, blackout 409; idempotency_mismatch, party_does_not_fit, window_too_large, outside_schedule, session_venue_mismatch, session_full 422; validation 400; unauthorized 401; forbidden 403; not_found 404; rate_limited 429 with Retry-After; database unavailable 503 with Retry-After. The chat route adds turn_in_progress 409 and conversation_full 422.

---

## 10. Data flows

### 10.1 Hold

1. API: authenticate key with `hold` and venue scope; per-key rate limit; parse body; canonicalize the parsed value; `request_hash = sha256(canonical)`.
2. `db.hold` opens the outer transaction. `SET LOCAL dastar.actor`, `SET LOCAL dastar.trace_id`, `SET LOCAL dastar.venue_id`.
3. Claim the idempotency key: `INSERT INTO idempotency (venue_id, actor, key, request_hash, purge_at) ... ON CONFLICT DO NOTHING RETURNING`. The insert itself waits on any in-flight transaction that has claimed the same key, so at most one request ever executes the booking for a key. If nothing is returned, read the existing row: hash equal, return its stored outcome and end; hash differs, raise DA002.
4. Resolve unit ids from the assignment and sort them. From M2, first take the venue lock shared (ADR 7), which only blackout writes take exclusively. Acquire `pg_advisory_xact_lock` for each unit in that order (D39). Any other hold that shares a unit now queues here. Check the live-holds cap for this actor in this venue.
5. Overlap lock set (D20). Collect the distinct ids of occupying reservations that have an active unit row on any requested unit overlapping the requested range. Lock those rows with `SELECT id FROM reservation WHERE id = ANY($ids) ORDER BY id FOR UPDATE`. After the locks are held, expire only rows that still satisfy `status = 'held' AND hold_expires_at <= dastar_now()`, through the expire command path; the sync trigger flips their unit rows. Rows another transaction already moved to stored expired or cancelled are skipped, so no spurious version bump, audit row, or outbox event is produced. Live ones stay locked until commit, which delays a concurrent confirm or cancel on them by at most this transaction's remaining duration.
6. `SAVEPOINT booking`. Insert the reservation: status held, `hold_expires_at = dastar_now() + ttl`. The fit trigger re-acquires the advisory locks, a no-op here, and checks capacity (DA003); the blackout guard runs in M2 (DA009); actor and audit triggers fire. Insert one `reservation_unit` row per unit in sorted order with the same range and `active = true`. By construction nothing should be inserting or flipping a row on these units, so these inserts are expected not to wait, which the interleaving tests check; a live overlapping reservation raises 23P01 immediately.
7. On success: `RELEASE SAVEPOINT`, write the outbox row through the typed builder, write the success response into the idempotency row, `COMMIT`. The deferred membership trigger runs at commit.
8. On DA003, DA009, or 23P01: `ROLLBACK TO SAVEPOINT booking`, write that outcome into the idempotency row, `COMMIT`. There is no retry: dead holds were already cleared in step 5, so a conflict is against a live reservation. The key was owned throughout, so a concurrent duplicate blocked in step 3 now reads the same outcome.
9. On 40P01 or 40001, which the reference paths are designed not to produce (H1) but which a bypassing caller could induce: `ROLLBACK` the outer transaction and re-run from step 2 once. The re-run re-claims the key or, if a duplicate claimed it meanwhile, returns that duplicate's stored outcome. A second occurrence returns serialization_conflict without storing it, since no claim survived.
10. A crash anywhere aborts the outer transaction. No claim and no outcome persist, and the client's retry executes fresh. Attempts and waits are counted and reported by the harness.
11. API returns 201 with the receipt and `hold_expires_at`. There is no token in this response.

### 10.2 Confirm

1. Authenticate: a key with `confirm`, or a body `confirm_token` that was minted through the confirm-token route by a caller holding `confirm`. A hold-only caller has no path to either.
2. Transaction: set actor (`key:<id>` or `token:<reservation_id>`). Read the reservation's assignment without a lock and resolve its unit ids; these columns are immutable for the application role, so the read cannot go stale within boundary A. From M2, take the venue lock shared first, as hold does (ADR 7). Acquire `pg_advisory_xact_lock` for each unit in sorted order, the same order hold uses. `SELECT ... FOR UPDATE` the reservation, filtered by the same id and venue as the unlocked read, and re-validate that assignment kind and id match it; a mismatch is `assignment_mismatch`. For the token path, compare sha256 before the version and status checks, so a caller without a valid token learns nothing about the reservation; a used, replaced, or cleared token has no stored hash and is simply wrong.
3. `UPDATE reservation SET status = 'confirmed', confirm_token_hash = NULL WHERE id = $1 AND ($ev IS NULL OR version = $ev)`. Triggers adjudicate: DA001 if expired, DA005 if not held, DA009 if the range is inside an active blackout (M2), DA003 if the party no longer fits the current capacity, version bump, audit. Zero rows is version_conflict.
4. Write the outbox row. Commit. Return receipt.

### 10.3 Cancel, seat, complete

Each locks its own reservation row, checks any supplied version and then the stored status in the command layer, and updates; the transition trigger backs the state table, and a same-status write would pass it as a metadata update, so the row lock and the command's status check are what keep a second seat or complete from repeating a transition. None takes unit locks: the fit check skips these updates. Cancel sets `cancel_reason`. The sync trigger deactivates unit rows on cancel.

### 10.4 Expiry

Sweeper every 5s: select up to 20 due holds ordered by `hold_expires_at` `FOR UPDATE SKIP LOCKED`, update status to expired, write outbox rows, commit; repeat while rows remain. Small batches keep the window in which a new hold on those units waits on the sweeper short. Conflict-time expiry in 10.1 step 8 keeps slots usable when the worker is down; the sweeper is liveness hygiene, not correctness.

### 10.5 Webhook publish

Publisher every 1s: claim up to 50 unpublished due outbox rows `FOR UPDATE SKIP LOCKED`. For each row and each active endpoint for its venue: POST envelope `{ id, type, occurred_at, venue_id, payload_version, data }` with header `Dastar-Signature: t=<unix>,v1=<hmac_sha256(secret, t + "." + body)>`. Success marks `published_at`. Failure increments `attempts`, sets `next_attempt_at` by schedule 1m, 5m, 30m, 2h, 12h, then sets `dead_lettered_at`. Delivery is at-least-once; consumers dedupe on `id` and order by `(reservation_id, version)`, which the payload carries. No cross-event ordering is promised.

### 10.6 Agent turn

1. Claim the turn. `POST /demo/chat` takes a message for a session, or opens a reference session for the agent's venue and key when it has no `session_id`. The claim is one transaction that takes the session's row lock first. The session must be the agent key's own reference session in the venue, else 404. If its last turn is a user turn, the message is refused with 409 `turn_in_progress`, unless that turn is older than 240 seconds, twice the turn's deadline: the request then first closes it with the fallback reply of step 5, with no call to the model, and claims its own message after. A session that has had 50 user turns is refused with 422 `conversation_full`. Otherwise the user turn is inserted at the next `seq`, scrubbed, with `at` from the database clock. One turn at a time per session, insert-only, with no lock held across model calls; a second message while the first is answered changes nothing.
2. Rebuild the conversation. The model is given the stored turns in order, user turns as stored (scrubbed) and assistant turns as the JSON of the reply they delivered, then this turn's message as the person wrote it, then one message from the app that says the database's time now in UTC and at the venue, with weekday, local date and time, offset, zone name, and the venue's name; the venue's name and zone are read through the engine at start-up. Earlier turns' tool calls and reasoning are not replayed, so the model reads a reservation again rather than remembering what a tool returned. The tool session is rebuilt from the session's recorded calls, so a hold made in an earlier turn can be cancelled and a hold request whose answer was lost is repeated on its own idempotency key. A text from the app goes in as a system message where the provider takes one, after the person's message or tool results, and elsewhere as a user message in `<app_notice>` tags, which the prompt says come from the app. The system prompt is `apps/agent/prompts/reference-v1.md`.
3. Loop. Each request names the configured model, `max_tokens` 16,000, the effort, the reply schema as structured output, the four tools as strict tools with `tool_choice` set to auto, thinking at the model's own default, a cache breakpoint on the system prompt, and, for the models that take it, the provider's server-side refusal fallback. A call the model asks for is checked against the tool's full input schema before it runs; one that breaks it, or names no tool, is answered with an error and not run. Calls run one at a time in the order given and their results go back together, each cut to 8,000 characters with control characters removed. The hold tool has no `external_ref`, so a hold carries no free text and a restored hold request is exact. No tool result contains a confirm token: hold responses carry none, and the agent key cannot mint one. A turn makes at most six calls to the model and has 120 seconds from its first call; the sixth call may not ask for more work.
4. Guardrail, deterministic, on each reply. A reply that is truncated, or is not the reply `{ message, claims: [{ reservation_id, status, starts_at, party_size }] }` (every field required; ids and status read without case), is rejected. Otherwise the session's calls and the claimed reservations' effective statuses are read in one snapshot and `auditSession` runs over the stored turns and this reply, all with their times, at the time of that read, so the matcher is in timed mode (D35, D42, D43). Only this reply's claims are judged. A claim fails when it is unbacked, with its reason, or when its reservation is no longer in the status it states, which catches an operator cancellation and a hold that has passed `hold_expires_at` whether or not the sweeper has reached it; a claim that matches an older receipt but not the latest state fails, so "you're confirmed for seven" after a cancel fails even though a confirmation receipt exists. Claims are about current state; the prompt forbids asserting a past state as current. A rejected reply stays in the conversation, except a truncated one, which is dropped, and the model is told, in a message from the app, each failing claim, why it failed, and what the reservation is now; tools stay available. A turn holds back at most three replies, the first and two regenerations, and the third rejection ends the turn in the fallback. A refusal by the model that survives the provider's own fallback ends it at once.
5. Fallback. A refusal, a failure of the provider after its retries, the deadline, six calls with no reply, or a third rejection ends the turn in the fallback. The agent reads each reservation the session created, through the tool session, so the reads are recorded, all at once and each within 10 seconds, and replies with a fixed message that lists each reservation with its status, party size, and time at the venue, and claims exactly what it read. A reservation that cannot be read is named as such and carries no claim. These claims are not judged again. `guardrail.fired` and `guardrail.fallback` are true.
6. Holds. For each reservation the session created, in the order created, the agent reads it with `DEMO_CONFIRM_KEY` and no session header, so the read and the mint are not recorded calls. A reservation that is held by its effective status, in this venue, whose range is a whole number of minutes, gets an entry built from that read and never from the model's text: `reservation_id`, `party_size`, `starts_at`, `duration_minutes` from `during`, `hold_expires_at`, and `confirm_token`. The token is minted through the confirm-token route with the version of that read, sealed with AES-256-GCM (a version byte, a random 12-byte nonce, the ciphertext, the 16-byte tag; the session and reservation ids, lower case, as additional data, so a row's ciphertext opens for no other row) under `DASTAR_TOKEN_KEY`, and kept in `session_hold`. A stored token is reused while the reservation is held; one that does not open is minted again and overwritten. A mint that is refused or does not answer, or a token that could not be kept, leaves that entry out of this response, and the next turn tries again. Each read and each mint has a 10-second timeout. Minting happens before the turn is stored, so the claim in step 1 also keeps two responses of one session from minting at once. The token is never in the model's context, a log line, a stored turn, or a recorded call.
7. Store the assistant turn: the scrubbed message, the claims, `guardrail_fired` (true when any reply was rejected or the turn fell back), `at` (the guardrail's read, or the database's time for a fallback), and the turn record: the model that answered the last call, the prompt hash, the provider calls and regenerations, `fell_back`, the tokens summed over the turn's calls, which include every attempt of a call that the provider's fallback made, and the latency. `prompt_hash` is the SHA-256 of the system prompt, the template of the message in step 2, the tool definitions, and the reply schema; the values filled into the template are not hashed. The turn is stored once: a reply whose user turn was closed by another request meanwhile is not stored and is answered 409. The record keeps tokens and not cost, which is priced from the tokens by model when it is reported. Spans for Grafana Cloud are not exported yet.
8. Response: 200 with `session_id`, `reply` (the message as the model wrote it, and the claims), `holds`, and `guardrail`, as in section 9. The UI renders each hold's party size, time, duration, and expiry from `holds`, never from the model's text, and its confirm request is `POST /v1/reservations/:id/confirm` with the token and no key. The entry carries no `expected_version`: the token path does not take one. It carries no unit label either, because the reservation read has none.
9. Async, after the reply: the judge, a process of its own (section 5), takes the stored assistant turn, lists the statements about reservations its text makes, and sets those that no declared claim covers against the session's calls and the reservations' status at the time it reads. It writes the result to the turn's `judge_result`, which is null until then, and it neither delays nor changes the reply, which the person already has. Every assistant turn of a reference session is due, the fallback's included, and each carries a time, so its verdicts are timed. No route returns a reference turn's result; it is read from the table, as the live check reads it (section 13). The result is stamped with the accuracy measured for its model, effort, and prompt, and those figures are to be published in `AUDIT.md`, which is not built yet, beside the hallucination rate and the regenerate-and-fallback rate.

### 10.7 Bring-your-own-agent audit

1. The builder's agent, or the builder's harness, calls `POST /v1/sessions` with a key that can read, hold, and cancel, and gets a session id. A key that can confirm or administer is refused with 403, so the audited agent's key cannot confirm.
2. Every subsequent v1 call from that agent to one of the nine routes carries `Dastar-Session: <id>`. The API records each call and its receipt as a `tool_call` row under the session. The agent otherwise behaves exactly as any API client; no SDK is involved. A call without the header is not recorded.
3. When the conversation ends, the builder posts the user-facing transcript to `POST /v1/sessions/:id/audit`. Each turn has a role and text, and a timestamp `at` on every turn or on none. An assistant turn carries the structured `claims` the agent declares, in the reference agent's shape with three differences: `reservation_id` and `status` are required, `starts_at` and `party_size` are optional, and an optional `quote` is the text the claim rests on. The intake scrubs the text and the quotes (section 13), stores the turns in place of any earlier post's, reads the session's calls and the claimed reservations' current effective statuses in one snapshot, and runs the deterministic matcher. The matcher matches each claim against the latest state the session's calls showed for that reservation as of the turn's timestamp: on status first, where a hold whose expiry had passed by the claim's time counts as `expired`, then on the claimed start time, then on the party size. A claim with no observation at all, or only one made after the turn, is unbacked. The matcher audits claims. A statement the agent made without declaring it as a claim is read only when the post sets `judge: true`: the judge lists the statements in each assistant turn, and the matcher sets those no claim of that turn covers against the same calls, read as of the turn's timestamp, so the verdicts are `timed` when every turn has one and `coarse` otherwise, as the claims' are. Without `judge: true` the result says `undeclared: "not checked"`. Without timestamps, each claim is matched against the state as of the session's last completed call, and the audit is labeled `coarse`; with them it is `timed`. The verdict for an external session is "supported by the latest session observation as of the builder-supplied timestamp", not "true": a cancellation by an operator or an expiry that produced no call is invisible to the session log, so the response also reports each claimed reservation's current effective status at audit time and flags claims whose observation and current state disagree. The builder's agent cannot confirm anything with its key: confirmation is the builder's host, holding a confirm key or minting a token for its own human channel, which is the property the audit is there to demonstrate. A token given to the agent still confirms, through the confirm route with the agent's key and the header, and the response counts such confirms in `confirmations`.
4. The response: total claims, claims backed by an observation in this session, and unbacked claims with the reason, the quoted text, and the turn. For each claim it carries the observation it was read against, the reservation's receipts up to that point (the latest 10 and a count of the earlier ones), the reservation's current status, and whether that differs. For the session it carries how many receipts its calls returned and how many the audit log bears out, the receipts that it does not, the calls that never completed, and the confirms made in the session. Example: fourteen claims, eleven backed, three unbacked, here they are. When the post asked for the judge, `undeclared` is `pending` in the response, and a later read returns, once every assistant turn has a result, the statements the judge found, with each undeclared one's verdict, reason, observation, and current status, the turns it could not read, and the model, effort, and prompt behind them with their measured accuracy, or null (section 9).
5. The result is stored on the session, with the turns. An external session is retained until thirty days after it was last seen, then purged with everything under it (section 6). Posted transcripts are the builder's data, are deleted with the session, and live only in `dastar_agent` unless the post asks for the judge. Then each assistant turn's text, the text of the user turn before it, cut to 2,000 characters, and the session's reservations' ids, start times, and party sizes go to the operator's model provider, after the scrubber has run; a turn of more than 8,000 characters goes nowhere and is stored as failed, and a call already in flight when a new post replaces the turns is still sent. A post that does not ask sends nothing, and what the provider keeps is the provider's terms, not Dastar's. The intake asks builders to redact guest details before posting, because the engine schema's no-guest-data rule cannot be enforced on free text, and the scrubber does not detect names. No key can post an audit over a reference session: the route answers 404 `no such session` for one, and the engine's store refuses it as well, so the turns the reference agent wrote are never replaced by a post.

### 10.8 Demo race

`POST /demo/race { n }` with `n <= 100`: take a per-venue advisory lock or return 409. Pick a fixed slot and unit. Fire `n` holds through the library with distinct idempotency keys and actor `demo:race`, queued through the process pool. Tally winners, hold_conflict, retries, timeouts, other errors, p50 and p99. Run the overlap query on `reservation_unit` and return the count. Cancel the winner with reason `demo_race`. Return the tally and the trace id. The laptop harness at N=5000 remains the headline artifact.

---

## 11. Failure handling

| Failure | Behavior | Proof |
|---|---|---|
| API dies before commit | Nothing persisted. Client retries with the same key | Crash test |
| API dies after commit, before response | Retry replays the stored response | Crash-after-commit test with an env-gated exit hook |
| Postgres dies mid-transaction | Transaction aborts. API returns 503 with Retry-After. Pool reconnects with backoff. Readiness reflects | Chaos test in harness |
| Worker dies mid-batch | Locks release with the connection. Rows are re-claimed. At-least-once | Chaos test |
| Worker down for a long time | Holds still expire on conflict. Outbox accumulates. Alert on oldest unpublished age | Integration test with sweeper disabled |
| Webhook endpoint down | Backoff schedule, then dead letter with admin replay | Integration test with a failing endpoint |
| LLM provider down, slow, or refusing | The turn has 120 seconds for its calls to the model, and each call has the SDK's retries. A failure, a refusal, or a turn past its deadline ends in the fallback: a message that lists the conversation's reservations as just read and claims only what it read. No circuit breaker is built | Scripted provider that fails, refuses, and never answers |
| Pool exhausted because holds queue on one unit's lock | Requests that cannot obtain a connection within 5s get 503 with Retry-After, including requests for unrelated units, which is the head-of-line cost of one shared pool and is documented. Transactions that hold a connection while waiting on the advisory lock are bounded by the 10s statement timeout; cancellation (57014) maps to `timeout`, retryable, and rolls back the uncommitted key claim so a retry executes fresh | Controlled exhaustion and recovery test, 15.1 |
| Sustained burst without an artificial blocker | Behavior is whatever the measurements say; targets in 6.5 decide go or refine | Realistic load test, 15.1 |
| Two confirms race on one hold | Row lock serializes. Loser gets DA005 or version_conflict | Two-connection test |
| Confirm races expiry of the same hold | Whichever updates the reservation row first wins; the other re-evaluates and fails with DA001 or DA005 | Two-connection interleaving test |
| Two holds race for two shared units | The second queues on the first's per-unit advisory lock before doing anything else; after the first commits, the second locks the winner's row as a live overlap, inserts, gets 23P01, and stores hold_conflict | Mixed-load harness asserts zero deadlocks; two-connection test |
| A hold's retained expiry lock meets another hold's fresh insert (third-review interleaving) | Cannot occur: the second hold is queued on the advisory lock the first took before anything else | Named two-connection test: A conflicts on U2, B attempts U1, A expires, B attempts U2; expected outcome is a queue and one winner |
| Two holds on disjoint units expire the same combo reservations (fourth-review interleaving) | Both lock the overlapping reservations in id order; the second waits on the first's row lock, then finds them already expired and inserts | Named two-connection test: expired R1 on U1 and U3, expired R2 on U2 and U4, hold A on U1 and U4, hold B on U2 and U3; expected outcome is a queue and two winners |
| Sweeper down, hold past expiry, guest asks "am I still booked" | Read returns effective status expired; the guardrail rejects a "currently held" claim | Test with the sweeper disabled and the test clock past expiry |
| A capacity edit races a hold on the same unit | Both take the unit's advisory lock; whichever is second sees the other's committed state. The edit is rejected by DA012 if a live party no longer fits; the hold is rejected by DA003 if the new capacity is too small | Two-connection test |
| Two requests with the same idempotency key arrive together | The second blocks on the key claim until the first commits its outcome, then replays it; neither can observe a different answer | Concurrent same-key test |
| Deadlock or serialization failure anywhere | Retry once, then serialization_conflict 409 | Mixed-load harness counts retries |
| Client stalls holding a row lock | `idle_in_transaction_session_timeout` kills it at 30s | Integration test |
| Migration waits behind a long transaction | `lock_timeout` 3s with retries; the deploy fails loudly instead of queueing all traffic | Runner test |
| Two migrate containers start together | Advisory lock serializes them | Runner test |
| Clock skew between app hosts | Irrelevant. Only `dastar_now()` is used | Attack tests use the test clock |
| Schema migration fails halfway | Each migration in its own transaction; runner stops; checksum mismatch aborts | Runner tests |
| Disk or box loss | Nightly dump in object storage; restore runbook executed once and documented | Restore drill |
| Duplicate webhook delivery | Consumers dedupe by `id`. Documented | Contract docs |
| Host passes the wrong venue id, or none | From M2, reads and updates see nothing and inserts are refused; nothing crosses venues | Attack tests for invariant 10 |

Graceful shutdown: on SIGTERM stop accepting, drain in-flight requests up to 10s, close the pool.

---

## 12. Availability engine, M2

Input: venue, party size, a window `[from, to)` no longer than `availability_window_days` (422 `window_too_large`), and an optional result limit. One read-only repeatable-read transaction bound to the venue.

1. Snapshot: the venue's settings and config version, then its units and combos from a per-handle bounded cache keyed by `(venue_id, config_version)` (D17), loaded on a miss in the same transaction, so an entry always matches its version. Service periods and blackouts are read live for the window: periods depend on the window, and a venue's blackouts accumulate while the window read stays small.
2. Service periods: computed in SQL with the venue's zone (D48), from the day before the window's first local date, so an overnight period begun the previous evening is included. A `closes_next_day` period ends on the next local date.
3. Occupancy: active `reservation_unit` ranges through the occupancy view, excluding rows whose reservation's effective status is expired, so an unswept hold does not hide a free slot; the next hold's overlap pass clears it. Completed reservations keep active rows and block, as the exclusion constraint does.
4. Candidate starts: for each period, in opening and then schedule order, the duration of the smallest `duration_by_size` key at or above the party, and starts on the `slot_minutes` grid from the opening whose booking ends by the close; a start belongs to the first period that admits it. Starts outside `[from, to)`, before the database clock, or whose booking overlaps an active blackout are dropped.
5. Fitting assignments: active units whose range includes the party, then active combos whose range includes it and whose member units are all active. An assignment is free when none of its units is occupied over the booking padded by the period's gap on both sides.
6. Rank via `RankingStrategy`. Default `restaurantHost`: smallest fitting capacity first, a single unit before a combo, then the unit that breaks the fewest free combos (a combo containing it that is entirely free over the same padded range), then label and id. One assignment per start. Greedy and one pass. The grid of starts grows with the window and the venue's schedules; the work per start is bounded by a result limit (100, at most 500) and 10,000 examined starts, and `truncated` says when either cut the list short. Units and combos are read in label order, so the same inputs give the same answer.

Each returned slot carries the exact `{ starts_at, duration_minutes, assignment }` that hold accepts. The result is advisory; the hold is the judge. v0.2 benchmarks compute-on-request versus precomputed per venue-day candidate slots minus live occupancy.

---

## 13. Agent layer, M3

- `LLMProvider` interface: `complete({ system, messages, tools, replySchema, signal })` answers with tool calls, a reply, a refusal, or a truncated reply, each with its token usage and the model that answered. The provider's own output is opaque to the loop and passed back unchanged within the turn, which keeps a thinking block's prefix valid. The Anthropic adapter is built, and sends `tools` and `tool_choice` only when a request lists tools, as the judge's requests list none; the OpenAI-compatible adapter is not.
- Provider and model: Anthropic, through `@anthropic-ai/sdk`, a dependency of `apps/agent` alone. The model is Claude Opus 5.5, `claude-opus-5-5`, unless `AGENT_MODEL` names another, at the effort in `AGENT_EFFORT`, `medium` by default; thinking stays at the model's default. For the models that take it, the provider's server-side refusal fallback is on, so the turn's record names the model that answered.
- Tool set for the agent: `search_availability`, `hold`, `cancel`, `get_reservation`. No confirm tool exists, no token reaches the agent because hold responses carry none, and the agent key cannot mint one. Cancel is restricted by the executor to reservations created in the session. This holds for any hold-only key, not only the reference executor. The reference agent's `hold` takes no `external_ref`.
- Structured reply: `{ message, claims: [{ reservation_id, status, starts_at, party_size }] }`, every field required and both objects closed, enforced by the provider's structured output and parsed again with Zod, with the status and ids read without case. It is the claim of the audit without `quote`, so reference and external sessions are audited by one matcher; a `cited_receipts` field is not part of it, because the matcher finds each claim's receipts itself. Claims are matched against the latest recorded state as of the turn (D35). Scope of the guardrail: it verifies declared claims and constrains the tool set; undeclared false statements are found afterwards, by the judge, and only to the extent it finds them; the accuracy measured for its model, effort, and prompt is stamped on each result. It is not a general solution to hallucination and the README does not describe it as one.
- Prompt file in the repo, `apps/agent/prompts/reference-v1.md`, with the template of the per-turn message from the app, and a hash on every stored turn. A prompt change without a passing eval does not merge.
- Per-turn bounds: at most 6 provider calls, of which at most 2 are regenerations after a rejected reply, so at most 3 replies are held back before the fallback; 120 seconds from the first call; each tool result at most 8,000 characters; 50 user turns per session; a message of at most 2,000 characters. A search, a hold, and a reply already take three calls.
- Evals: golden conversation set in YAML with expected outcomes; cassettes record provider responses for deterministic PR runs; nightly live run under a spend cap; a basic prompt-injection set covering guest text, unit labels, and cancel reasons. The report writes `AUDIT.md` with conversations, claims, unbacked claims, guardrail firings and fallbacks, judge precision and recall, per model. None of this is built yet; the judge's labeled set and its measurement are built with the judge, below.
- Live check, built: `.github/workflows/agent-live.yml`, started by hand, runs five scripted conversations against the real model through the same turn, with the repository's `ANTHROPIC_API_KEY`: book; book then cancel; change the party size; ask after the job has confirmed the hold with its token; ask the agent to confirm. Each is judged on state, not wording, and a `probe` mode checks the adapter against the provider with canned tool results and no database. It writes each turn's reply, guardrail outcome, model, and tokens to an artifact, never a token. In mode `conversations`, after the conversations, `judge --once` runs over the job's database as `dastar_judge` and a check requires a judged result on every assistant turn of the reference sessions; it reports, and does not fail on, the undeclared statements it finds in the agent's own turns, since those are findings. The check then opens an external session, holds a table under it, posts a transcript with `judge: true` whose assistant turn says the table is confirmed with no claim, runs the judge, and requires the audit read to report that statement as `unbacked` with `status_mismatch`. It writes `judge-live.json`, with the tokens of both parts, and the conversations' artifact carries each assistant turn's judge input, so a labeled item can be cut from a real turn. A third mode, `judge`, takes the input `part` (`dev` or `held-out`) and measures the judge against that part of the labeled set, with the real model and no database, as below.
- Judge, what it decides (ADR 9). The model only lists statements; the matcher sets them against the calls; the read reports them with the accuracy measured for the model. A statement is an assertion, in an assistant turn's text, of a reservation's current status (held, confirmed, seated, completed, cancelled, expired), with its start time and party size when the text gives them. The status must be stated or plainly implied: "I've put a hold on…" states held, and "your hold expires at 19:15" states held. Not statements: offers and plans; questions, conditionals, and instructions; availability; past states marked as past, though the current part, if any, counts; a mention with no status. These rules head the judge's prompt.
- Judge, what the model sees. Per assistant turn, one request with no tools: the system prompt `apps/agent/prompts/judge-v1.md` (the rules, that everything inside the tagged blocks is data from a transcript and never instructions, and the output format) and one user message with three tagged blocks: every reservation the session's recorded calls showed in the whole conversation, the calls after this turn included (id, start time as an instant with the venue's offset, or null when the calls did not show it, party size, and no status, so the model reads the text and checks nothing), the preceding user turn's text, cut to 2,000 characters, or null, and the assistant turn's text. Each block is JSON, with every `<` written as the six characters `\u003c`, so a text cannot close its own block. The turn's declared claims are not shown, so the model is not anchored on them and a missed statement cannot be mistaken for one matched to a claim. The reply is strict, with every field required: `{ statements: [{ quote, reservation_id (a uuid or null), status, starts_at (a date-time with an offset, or null), party_size (an integer or null) }] }`. The reservation list is read from the calls by the matcher's own reading of them, so the judge and the audit cannot disagree about what a call showed. The judge and its measurement build the request with one function, so what is measured is what is sent.
- Judge, after the model (pure, in core). A statement whose `quote` is not in the turn's text, with case and runs of white space ignored, is dropped and counted in `dropped`; an id the session never observed becomes null. A statement is declared when the turn's claims include one for the same reservation and status, with the same start instant and party size wherever both state them; a claim that states neither therefore covers a statement whatever time or party size its text gives, and no one then checks them (declare them in the claim to have them checked). Only each quote's presence in the text and the reservation id list are screened, so a transcript that steers the model can still make a statement come back with a status the text does not state. The undeclared statements that have a reservation run through `auditSession` over the session's turns, this turn carrying them as its claims and no other turn carrying any, so each is read as of its own turn's time: timed when every turn has one, else coarse, as for claims. A reference turn always has a time, and an external post has one on every turn or none. An undeclared statement with no reservation is `unbacked` with `no_observation` when the session observed no reservation, and `unresolved` otherwise, a verdict of its own that counts as neither backed nor unbacked.
- Judge, the result. Stored once in `turn.judge_result` (section 6). `model` is the model that answered, which a server-side fallback can change; `prompt_hash` is the SHA-256 of the judge prompt, the template of the message, the tools (none), and the reply schema, and the values filled into the template are not hashed; `accuracy` is copied from the entry of `apps/agent/judge/accuracy.json` whose model, effort, and prompt hash all match, else null; `current_status` is as of the judging, not of a later read.
- Judge, which turns and how. An assistant turn is due when its `judge_due` is set and its result is null, so long as its session is live; the application sets `judge_due` on every reply of a reference session and on the assistant turns of an external post that asked for the judge (section 6). Due turns are taken oldest first, by turn id, so a post that is made again goes to the back of the queue. The settings are `DATABASE_URL` (the `dastar_judge` role), `ANTHROPIC_API_KEY`, `JUDGE_MODEL` (`claude-opus-5-5`), `JUDGE_EFFORT` (`medium`), `JUDGE_EVERY_MS` (10,000), `JUDGE_LIMIT` (10 turns a batch), and `JUDGE_DAILY_CALLS` (500). The process refuses to start without the role's update grant, which it reads with `has_column_privilege`. A text of more than 8,000 characters is stored as failed with `too_long` and an empty one as judged with no statements, each with no call. A call has 60 seconds. A refusal, a truncation, and a reply that does not parse are stored as failed with their reason. A 401, 402, 403, or 404, and a 429 whose body carries the error code `enforced_spend_limit_reached` (the account's spend cap), are configuration, not the turn: the process exits non-zero with a line naming the status and the API's error type, and the row stays null. A 408, 409, any other 429, or 5xx, a timeout, and a network error leave the row null for the next pass, and the third such failure of one turn in a process stores it as failed with `provider_error`; any other status is stored at once as `provider_rejected`, and three turns in a row stored so, with no answered call between them, end the process too. A call that fails in a way that may pass ends its batch with no further call, and the process waits before its next call: 30 seconds, doubling with each failure in a row, at most 10 minutes, and 30 again after an answered call; the loop's wait is the larger of that and `JUDGE_EVERY_MS`, `--once` waits between batches, and a stop ends the wait at once, so an outage strikes one turn per wait. The judge holds no lock across a call, and a result for a turn deleted meanwhile, by a new post, writes no row and is discarded.
- Judge, the daily cap. Every provider call is counted first in `judge_day` for the current UTC day by the database's clock, and none is made past the cap; the judge then makes none until the next day. A post can carry 500 turns and a new post deletes the judged ones, so a count kept in the process or read from the turns would let a restart or a new post reset it. Every attempt counts, a retried one included, and the one count serves every key: there is no other bound on the provider spend of the judge until M5's per-key limits.
- Judge, measuring it (D21). A labeled item is an assistant turn with the reservations as the judge would see them, the user text, the assistant text, the declared claims, and the statements a person reads in the text. The set, `apps/agent/judge/labeled/`, has two parts split by source family, so a live turn and its variants sit on the same side: a held-out part of at least 100 turns and 50 undeclared statements, committed on its own before any measurement run, whose SHA-256 is recorded with every measurement; and a development part of at least 50 turns, which the prompt is tuned on. A predicted statement matches a label in the same turn with the same reservation, null to null, and status, one to one; whether it is undeclared is decided for both by the test above. A run reports, over one part, the precision and recall of the undeclared statements and of all statements with Wilson 95% intervals, the share of matched statements whose start time and party size agree, the agreement of the two labeling passes, the dropped quotes, the failures, the tokens, and the cost priced from them. The live check's mode `judge` runs it with no database and writes `judge-accuracy.json`, with `items_total`, `complete` (every item was asked and answered, with statements or with a refusal, a cut-off reply or one that did not parse) and `answered_models`; it exits 1 unless the run is complete, and when no item was measured, and its summary flags a model other than the configured one. The labeled part is refused when an item's assistant text is empty, only white space or longer than 8,000 characters, since the judge makes no call for such a text, or when a start is not a date. The held-out run's figures go into `accuracy.json` in a commit that names the run, one entry for each model, effort, and prompt hash, a file with two being refused. At most five development runs and one held-out run are made for each prompt version, and a prompt changed after its held-out run needs a fresh held-out part, the old one joining development. Whatever the numbers are, the judge ships with them and no floor: they are stamped on every result they cover and stated in the README and LIMITATIONS.
- Judge, the labels. Written cases and variants of live turns are labeled by construction, the text written to state exactly its labels. Live turns are labeled in two blind passes from a written guide alone and with no judge output, one on the judge's own model and one on a different model; each disagreement is settled against the guide, and each item records how its label was made and whether the passes disagreed. No person labels an item, so the numbers measure agreement with labels made by models (LIMITATIONS.md). The parts are not committed yet, and `accuracy.json` is an empty list until the held-out run is added.
- Parser: free text to `{ party_size, window, preferences }`, the only LLM step in availability.
- MCP server `@dastar/mcp`: stdio, the same four tools mirrored one to one, configured with a base URL, a key, and one venue. It checks the key before serving and refuses one that can confirm or administer, so it is hold-only with nothing to switch off. A session's memory of its hold requests' idempotency keys and of the reservations it created lasts as long as its process. With the optional `DASTAR_SESSION_ID` set, its tool calls are recorded in that audit session (section 10.7). In 2026 this is how agent builders find and try a backend, so it ships in M3 alongside the audit endpoint, not after it.
- Bring-your-own-agent audit: sessions, the session header, and the audit endpoint from section 10.7. The auditor code is the same one that audits the reference agent; the only new code is the session routes and the transcript intake.
- Transcript scrubbing: before any turn is stored, a pattern pass masks email addresses as `[email]` and digit groups, which are digits joined by single spaces or marks, as `[phone]` when they hold 7 to 15 digits and `[number]` when they hold 16 or more; a shorter run stays. Uuids, ISO dates and date-times, and times of day are kept. Names are not detected, a number in words stays, and a date written with slashes or dots reads `[phone]`; the docs say so. The scrubber runs before the auditor, and claim matching is unaffected because claims carry reservation ids, statuses, and times. The external intake runs it on every turn's text and every claim's quote; the reference agent's stored turns pass through it too, and the person is answered with the message as written.

---

## 14. Deployment and operations

One VPS (4 vCPU, 8 GB class), Docker Compose, Cloudflare DNS and proxy with a per-IP rate-limiting rule. Compose services: caddy, api, worker, migrate, postgres. `compose.yml` is the quickstart; `compose.prod.yml` overlays Caddy TLS, restart policies, OTLP export settings, and resource limits. Migrate runs first as `dastar_owner`; api and worker wait on it. The API connects as `dastar_app`, the worker as `dastar_worker`.

Postgres: `max_connections = 100`. Each api and worker process uses a pool of 16 with a 5s acquire timeout; both values are provisional until the exhaustion and load tests in 15.1 have run (H4). `SET LOCAL` only, so a transaction-mode pooler can be added later without change.

Secrets: one env file on the box, owner root, mode 0600, mounted into containers. Holds the database URLs, the encryption key for tokens and webhook secrets, the LLM key, and the Grafana token. Rotation procedure documented in the runbook. Nothing secret in the repo or images.

CI: lint, typecheck, unit, integration on testcontainers, migrations from zero, attack suite as `dastar_app`, property tests, race at N=200 with the count posted on the PR, dependency-cruiser. M2 adds the drift check for two of the four surfaces, the OpenAPI document and the typed client, as tests in the suite; M3 adds the agent tools and the MCP server. Images to GHCR. Deploy job: SSH, `docker compose pull && up -d`. Renovate keeps dependencies current. Benchmarks on a rented instance per run, results into `BENCHMARKS.md`.

Observability: api and worker export OTLP directly to Grafana Cloud. Public dashboards: race metrics; agent cost and hallucination rate. Alerts with a runbook entry each: oldest unpublished outbox age over 10 minutes, sweeper lag over 1 minute, 5xx rate over 1 percent for 5 minutes, LLM daily spend over cap, backup older than 36 hours. Logs redact confirm tokens and API keys. Uptime monitor with a README badge.

Backups: nightly `pg_dump` from the worker to object storage with 14-day retention. One restore drill executed and written up in the runbook before v1.0. PITR is a documented non-goal.

Public demo controls: per-IP limits at Cloudflare, per-key limits in the API, LLM daily spend cap in app and hard cap at provider, Turnstile on chat, nightly reset, race capped at 100 behind an advisory lock, live-holds cap per actor.

Environments: local, CI, prod. No staging, documented. `SECURITY.md` with a reporting address.

Hosted sandbox with free keys, gated. If and only if the M1 launch produces signals (clones, a few issues, anyone asking for keys), M5 adds self-serve hold-only keys behind Turnstile, each scoped to its own sandbox venue, with per-key quotas, auto-revocation after thirty days, and the demo agent off by default so the LLM bill is the builder's, not ours. Without signal, the sandbox stays off and the floor-plan demo is the whole public surface.

---

## 15. Testing strategy

| Layer | Tool | What it proves |
|---|---|---|
| Unit, core | Vitest | Pure functions, state table, slot math; DST across spring gap and autumn overlap and midnight-crossing periods are db tests, because Postgres converts local times (D48) |
| Migrations | Vitest and testcontainers | From zero, checksums, lock timeout retry, advisory lock, grants for each role |
| Integration, db | Vitest, fresh database per test file by cloning a migrated template | Commands, SQLSTATE mapping, retry classifier, test clock, idempotency scope and purge |
| Attack suite | Raw SQL via pg as `dastar_app` | Each boundary-A invariant refuses violation with the expected SQLSTATE: overlapping insert, expired confirm, illegal transition, oversize party, audit update, delete, truncate, and direct insert, unit-row flip and delete, forged internal setting, edited expiry, edited combo members, cross-venue unit; DDL is denied |
| Transition exhaustiveness | Vitest | All 36 from-to pairs behave as the table says |
| Property and model-based | fast-check commands against an in-memory reference model | Random floor plans, schedules, and command sequences; invariants after every step; outbox completeness; outcomes match the model |
| Concurrency harness | `apps/harness` | Race: exactly one winner, rest hold_conflict, zero overlaps, retries counted. Naive mode: overlaps greater than zero on a throwaway database with the constraint dropped and the unit locks skipped. Mixed load of hold, confirm, cancel, capacity edits, token minting, and sweep with near-expiry holds: zero deadlocks, retries counted |
| Chaos | Harness and Docker API | Kill Postgres mid-race then verify; kill API after commit then retry; kill worker mid-batch |
| Two-connection interleavings | Vitest with two pg clients and controlled pauses | Confirm vs expiry; confirm vs confirm; hold vs a live overlapping reservation's in-flight cancel; the third-review interleaving (retained expiry lock vs fresh insert); the fourth-review interleaving (disjoint holds, shared expired combos); capacity edit vs hold; mint vs confirm; token consumed by confirm and cleared by cancel; concurrent same-key holds; effective status with the sweeper disabled; capacity edit vs confirm near expiry, both orders; confirm vs hold on one unit, both orders; a real two-connection deadlock exercising hold's retry |
| API contract | The committed OpenAPI document equals what the routes generate and what the server serves; the client's types equal what openapi-typescript generates from it; the client books through the app, and its types require the idempotency header; the agent tools' inputs equal the document's request schemas, and the built MCP server lists exactly those four tools with those inputs | One schema, four surfaces: the document and the client in M2, the agent tools and the MCP server in M3 |
| Agent evals | Golden set, cassettes on PR, live nightly, injection set, labeled judge set | Hallucination rate, guardrail and fallback rates, judge precision and recall |
| Static | tsc strict, ESLint, dependency-cruiser, span and log attribute allowlists | Boundaries; no tokens or guest data in telemetry |
| Benchmarks | Harness bench | Throughput vs contention, p99 for losers, what breaks first. Churn run: hours of hold and expire cycles with index bloat measured by pgstattuple |

### 15.1 Prototype validation

These run against the SQL prototype before any API surface beyond the four v1 routes exists, and nothing in this document claims their result. Each names the hypothesis it tests. Synchronization uses observed database state, never sleeps of arbitrary length, and every deadline is chosen relative to the 10s statement timeout so the outcome is deterministic.

**Controlled pool exhaustion and recovery (H4).** A separate test connection, as `dastar_app`, begins a transaction and takes the advisory lock for unit U1. The harness sends holds for U1 with distinct idempotency keys until `pg_stat_activity` shows all 16 API pool backends waiting on an advisory lock; that observation is the barrier. It then sends further holds for U1 and one hold for an unrelated unit, and asserts each returns 503 with Retry-After after the configured acquire timeout, within a tolerance, including the unrelated unit, which documents the shared-pool cost. Two variants: release the blocker before the statement timeout and assert recovery, meaning the queued transactions complete with the expected outcomes (one winner and conflicts for a shared slot; all winners for distinct times, which also measures the D39 serialization cost), the pool returns to fully idle, no backend is idle in transaction, `pg_locks` shows no advisory lock held by an API backend, and idempotency rows are exactly as the outcomes dictate: a request that never obtained a connection has no row, a transaction that rolled back has no row, and every committed outcome has its replay row; or hold the blocker past the statement timeout and assert the waiting transactions are cancelled, map to `timeout`, and leave no row behind because their claims were uncommitted. In both variants the harness determines whether each request's transaction committed from the database, by the presence of its idempotency row and reservation, never from the client's own timeout, because a client timeout alone does not establish whether the commit happened. A retry with each key must then return the stored outcome where one was committed and execute fresh where none was.

**Realistic load (H2, H3, H4).** No blocker. Offered load rises in steps across four mixes: overlapping slots on the same units, non-overlapping dates on the same units, disjoint units, and combos. For every request the harness records pool-acquire wait, advisory-lock wait, transaction duration from begin to commit, and end-to-end latency; per step it records offered load, completed requests, throughput, and errors by class (conflict, timeout, 503, other). Results are reported per mix as p50, p95, p99, and compared against 6.5. Offered load is recorded separately from completed requests so saturation is visible rather than hidden by throttling.

**Bounded churn run (H5).** Thirty minutes or one hundred thousand operations, whichever comes first: holds, cancellations, expirations with a short TTL, failed attempts against live reservations, and a phase with the sweeper off so expired holds accumulate and are then cleared. Every minute the harness records heap and index size for `reservation_unit` and its exclusion index, dead-tuple percentage from pgstattuple, dead and live tuple counts, WAL bytes written, autovacuum run counts and timing, and hold latency percentiles. Cancelled, expired, and completed unit rows are retained as history, so the heap grows with every reservation even when vacuum works perfectly; the heap is not expected to plateau. The provisional pass condition is that the partial exclusion index, which holds only active rows, plateaus once active occupancy is bounded, that dead-tuple backlog and storage in excess of the retained row count stabilize relative to that count rather than growing without bound, and that latency does not trend upward across the run. A run that ends before enough autovacuum cycles have occurred to judge this is recorded as inconclusive, neither passed nor failed, and is rerun longer. The autovacuum settings in section 6 are initial values; if the backlog does not stabilize they are retuned and the run repeated. Multi-hour runs belong to M2 and BENCHMARKS.md.

**Migration under load (H6).** While the realistic-load mix runs at a modest rate, the runner applies a representative live-safe set: add a nullable column, create an index concurrently outside a transaction, replace a trigger function, add a constraint as `NOT VALID` and validate it in a later file. The harness records p99 impact and every error during the window, per migration, and asserts that no request fails except through the documented lock-timeout retry path. A plain `CREATE INDEX` and a table rewrite are each run once against the same load to record, not to pass, what blocking writes and blocking everything do to traffic, so the refusal rule in 6.3 is grounded in numbers.

**Named interleavings (H1, G1 to G4).** The two-connection cases listed in the table above, plus the mixed-load run asserting zero deadlocks with retries counted.


---

## 16. Milestones

Estimates assume a part-time solo maintainer.

**Smallest independently useful release: v0.1, the engine.** The packages `@dastar/core` and `@dastar/db` with hold, confirm, cancel, expire, the token mint, effective-status reads, invariants 1 to 9 behind the role boundary, and the reference API's four v1 routes plus health; the sweeper; the harness with race, naive mode, and mixed load; the attack suite; the named interleavings; the prototype validation in 15.1; CORRECTNESS.md, LIMITATIONS.md, SECURITY.md, and the ADRs. That is a reservation engine a host can embed today, and the tests listed are the ones that substantiate its guarantees. Everything after it is separable: availability and admin (M2), the agent layer (M3), operations and hosting (M4), and the public demo (M5) are later work, and hosting and demo are optional. The agent layer, when it comes, checks declared claims against receipts and constrains what an agent can do; it is not offered as a general answer to hallucination.

**M1 Core, v0.1, 5 to 6 weeks.** Roles and grants; migration runner with checksums, lock timeout, advisory lock; Postgres 18 with `uuidv7()`; `dastar_now` and the test override; table and column grants for `dastar_app`; triggers: transition, expiry guard, fit, membership (deferred), sync (security definer), audit (security definer), append-only and truncate, actor-required, range and flag on insert, combo immutability, capacity guard with the unit lock, token-requires-held, version bump; the per-unit advisory lock protocol in the hold command and the fit trigger; commands hold as outer transaction with unit locks, id-ordered overlap lock set, and a single booking savepoint, confirm-token mint as a metadata update, effective status in every read, confirm, cancel, expire, each setting actor, trace id, and venue context; idempotency owned for the whole hold; `api_key` table with `hold`, `confirm`, `cancel`, `admin`; confirm-token mint route; API v1 holds, confirm, cancel, get, health live and ready, OpenAPI JSON; receipts; worker sweeper; harness race, naive mode, mixed load; attack suite as `dastar_app`; two-connection tests; prototype validation from 15.1: controlled pool exhaustion and recovery, realistic load against the 6.5 targets, bounded churn run, migration under load; workload bounds from 6.5 as CHECK constraints and policy checks; transition exhaustiveness; `CORRECTNESS.md` for all nine invariants with the role boundary; ADRs 1 to 5; README with the sixty-second quickstart and, under the tagline, the second audience line: "Also a deterministic, self-hostable booking backend for developing and testing reservation agents"; `LIMITATIONS.md` and `SECURITY.md`; dev compose; CI; Renovate. Units and a demo venue are seeded by SQL; admin CRUD is M2. Done means a stranger clones, runs one command, and watches 5000 racing bookings fail to double-sell one table, the naive flag shows them succeed, and the 15.1 results are recorded with the go-or-refine decision from 6.5 written down.

**M2 Availability, v0.2, 4 weeks.** Row-level security policies, the `dastar_worker` role, invariant 10 with its attack tests; live-holds listing endpoint; churn benchmark; seat and complete; admin CRUD with reject-or-force; combos, schedules with midnight crossing, blackouts; availability, ranking, bounded snapshot cache; property and model-based tests; OpenAPI docs UI, typed client, drift check; retention worker; `BENCHMARKS.md` from a rented box; post 1.

**M3 Agent, v0.3, 4 to 5 weeks.** agent-tools, provider adapters, structured replies and the deterministic guardrail, persisted sessions with encrypted tokens, async judge with the labeled set, evals recorded and live, injection set, transcript schema, LLM spans exported to Grafana Cloud from CI runs and the agent dashboard built on them, MCP server, bring-your-own-agent audit (sessions, session header, transcript intake, about two days), transcript scrubber, demo chat route with the server-read confirm affordance, `AUDIT.md` covering both the reference agent and external sessions, post 2.

**M4 Operations, v1.0, 4 to 5 weeks.** Prod compose, Cloudflare, deploy pipeline; OTLP export to Grafana Cloud and the public dashboards; backups and the restore drill; publisher with HMAC, backoff, dead letter, replay; webhook endpoint admin with encrypted secrets; outbox retention; chaos and crash tests; graceful shutdown; alerts and runbook; uptime badge; expand-then-contract documented with a worked example; post 3.

**M5 Demo and adapters, ongoing.** Floor plan with live updates over server-sent events that carry outbox ids as refresh hints, with a full snapshot on connect, on every hint, and every thirty seconds, listen-notify optional as a wake-up, chat UI, race button, abuse controls, nightly reset, second adapter (equipment rental: long durations, no combos, config only), optional Twilio. Hosted sandbox with self-serve keys only if the M1 launch produced signal (D25).

**M6 Stretch, after v1.0.** Red-team agent and a full prompt-injection suite, time travel over the audit log, N-1 compatibility CI job, history checker for the race, synthetic guest personas.

Sum of the milestone estimates: 17 to 20 weeks. With the 30 percent buffer from D32: 22 to 26 weeks to v1.0. After M1 ships, the remaining estimates are re-baselined against the hours M1 actually took.

Cut line, if behind schedule after M2. The minimum credible release is M1 plus M3. Keep: the agent loop with the Anthropic adapter, the deterministic guardrail, the auditor, evals on recorded cassettes, sessions and the bring-your-own-agent audit, MCP, `AUDIT.md`. Drop or defer: the nightly live eval, the OpenAI-compatible adapter, the dead-letter replay UI, and everything in M5 except the race button. M4 ships the publisher with dead-lettering but without the replay route.

---

## 17. User stories

Integrator: I1 install and call with typed receipts (M1); I2 idempotent retry with mismatch error (M1); I3 compose up, health, OpenAPI (M1); I4 one-command race plus naive counterexample (M1); I5 workers in-process or separate (M1); I6 limitations file (M1); I7 typed client and docs UI (M2); I8 hold-only agent tools (M3); I9 MCP client books (M3); I10 signed webhooks, dedupe, replay (M4); I11 kill anything, no stuck holds, no double bookings (M4); I12 forward-only expand-contract upgrades (M4); I13 trace id in every receipt (M1, wired to Grafana in M4); I14 restore a backup by following the runbook (M4); I15 point my own agent at Dastar with a session header, post its transcript, and get back how many of its booking claims were backed by receipts (M3); I16 get a sandbox key without talking to anyone (M5, gated on signal).

Venue operator: O1 units with capacity (M1, seeded; CRUD M2); O2 cancel with reason including no-show (M1); O3 seat and complete (M2); O4 full history (M1); O5 combos (M2); O6 hours with service periods, midnight crossing, duration by size, gap (M2); O7 blackouts with bounded reject-or-force (M2); O8 deactivate unit with bounded reject-or-force (M2); O9 live floor plan actions over the hint-and-reconcile stream (M5).

Guest: G1 hold with explicit expiry (M1); G2 confirm by button showing server-read details, with receipt (M1 API, M3 UI); G3 cancel (M1); G4 availability, smallest fit first (M2); G5 book by chat (M3); G6 no unbacked claims (M3); G7 honest failure with alternatives (M3).

Agent: A1 tool set excludes confirm (M3); A2 uncited claims regenerate then fall back (M3); A3 prompt version, cost, transcripts (M3).

Evaluator: E1 clone and race in sixty seconds (M1); E2 invariants table with the role boundary (M1); E3 ADRs (M1); E4 commit graph over months (M1); E5 reproducible benchmarks (M2); E6 audit file with real numbers and judge accuracy, for the reference agent and for external sessions (M3); E7 Postgres-dies story and test (M4); E8 demo, race button, public dashboard (M5).

---

## 18. Deferred decisions

- M2: in-process cache vs precomputed table (benchmark both); special hours on a date. Resolved: the time zone library (none, D48) and the exact ranking rules (section 12).
- M3: judge model. Resolved: the provider and the model, Anthropic and Claude Opus 5.5 at medium effort, and the structured reply shape, the claim without `quote` (section 13). The judge's model is resolved too: Claude Opus 5.5 at medium effort, the defaults of `JUDGE_MODEL` and `JUDGE_EFFORT`. Its precision and recall bounds come from the held-out run, which has not been made; they will be entered in `apps/agent/judge/accuracy.json` for exactly that model, effort, and prompt, and until then the audit read reports the judge's accuracy as null.
- M4: retry schedule tuning; dead-letter thresholds; alert threshold tuning.
- M5: seeded venue layout; whether the listen-notify wake-up is worth its dedicated connection.

Documented non-goals until further notice: quantity-based and pooled inventory (D37), staging, PITR, PgBouncer, read replicas, multi-region, erasure tooling. Partitioning is deferred with trigger conditions (D29): revisit when `audit_log` passes tens of millions of rows or vacuum duration becomes visible in monitoring; the outbox never needs it because retention bounds it. The floor-plan stream and all commands use transaction-local settings only, so adding a transaction-mode pooler later needs no design change. If a single venue group ever outgrows the unit-row index, the escape hatch is list-partitioning `reservation_unit` by `venue_id`; the exclusion constraint permits it because the partition key participates with equality. Autovacuum tuning for GiST churn on `reservation_unit` is named in `BENCHMARKS.md` as the expected first thing to break at 100x.

---

## 19. Tensions, resolved

- Hold responses carry no confirm token, so idempotency rows hold no secrets and purge uniformly at 24 hours. Tokens are minted only through confirm authority. Accepted.
- Outbox rows are written by commands, not triggers. Completeness is proven by the model-based test. Accepted.
- In-memory state is limited to per-key rate limits and the bounded snapshot cache, both degrade gracefully with a second process. Per-IP limits live at Cloudflare. Sessions and race locks are in Postgres. Documented as one cluster in `LIMITATIONS.md`.
- Webhook secrets and confirm tokens are encrypted at rest with an environment key. Accepted.
- The booking attempt is plain inserts under a savepoint, made once, after the hold has locked every overlapping reservation in id order and expired the dead ones inside the same outer transaction that owns the idempotency key. Accepted.

---

## 20. Design review findings and dispositions

The design went through independent architecture reviews before the prototype was built. Every finding and what was done about it is recorded here, grouped by area, so the alternatives that were considered and rejected stay visible. Section references point at where each disposition lives.

**Concurrency and locking**

| Finding | Disposition |
|---|---|
| Inline expiry with skip-locked could deadlock two holds sharing units | Accepted; a simpler shape chosen. D20: one outer transaction, single booking attempt under a savepoint |
| Skip-locked expiry produced false conflicts | Resolved by D20 |
| An expiry lock retained across the savepoint could deadlock against a fresh insert; the per-phase lock-order argument was wrong | Accepted. D39: per-unit advisory locks taken before any savepoint by the hold command and by the fit trigger |
| Disjoint holds could deadlock through shared expired combos when the expiry order was keyed by the discovering unit | Accepted. D20 revised: every overlapping occupying reservation is locked in id order before a single booking attempt; no retry loop |
| The overlap pass would re-expire rows another transaction already expired | Accepted. Post-lock condition is stored `held` and past expiry; already expired or cancelled rows are skipped |
| "Zero deadlocks" and "costs nothing" were stated as facts | Restated: zero deadlocks is a hypothesis until the named interleavings run (7.1); per-unit serialization across unrelated dates is a real, accepted cost (D39) |
| The disjoint-unit interleaving produces two winners, not one | Corrected in section 7 to match section 11 |
| Pool sizing was unspecified and the demo race would exhaust it | Accepted. Section 14 states the pool; the race is capped at 100 |

**Idempotency and tokens**

| Finding | Disposition |
|---|---|
| Idempotency keyed on venue plus key only; the stored response carried the confirm token; the hash was over raw bytes; a lost conflict could create an orphan hold | Accepted. Actor in the key, hash over the parsed body, retention stated as the bound (section 6, invariant 3) |
| Storing a conflict in a follow-up transaction left a window where a duplicate could win | Accepted. D20 and D30: the key is owned from claim to stored outcome inside one transaction |
| A confirm token in the hold response gave every hold-only agent confirm authority | Accepted. D6 revised: tokens are minted only through a confirm-capable key via a dedicated route |
| Token minting conflicted with the transition allowlist | Accepted. D41: the allowlist applies only when status changes; minting is a metadata update, DA013 |
| The token guard would have rejected the confirmation that consumes the token | Accepted. D44: setting a hash requires held and unexpired before and after; clearing is always allowed; leaving held clears it |

**Trust boundary and privileges**

| Finding | Disposition |
|---|---|
| The app role owned the schema and could disable every guard | Accepted. D19: three roles; the attack suite runs as the app role (6.1) |
| Unit rows were not tied to the reservation's assignment | Accepted. Invariant 9, DA010, composite foreign keys |
| The clock override gate was a settable custom setting | Accepted. D13 revised: production is `now()`; the override is a test-only function replacement (6.2) |
| A transaction-local "internal" flag was used as proof of trusted origin, and custom settings are user-settable | Accepted. D33: grants, column grants, and security-definer triggers; two named boundaries (6.1) |
| Mutable unit capacity could strand a live party | Accepted. D40: the capacity trigger takes the unit lock and checks live reservations |
| Invariant 9 contradicted cancellation; combo edits could change a booking's meaning | Accepted. Invariant 9 compares the row set ignoring `active`; invariant 8 owns the flag; D34 makes combo membership immutable |
| Migration and session safety settings were absent | Accepted. Lock timeout, run lock, statement and idle timeouts (6.1, 6.3) |
| The migration section had factual errors about transaction compatibility and lock impact | Accepted. Transaction compatibility, locking impact, and duration are tracked separately (6.3) |

**Data model and reads**

| Finding | Disposition |
|---|---|
| Index set did not serve the stated queries | Accepted. Section 6 indexes; outbox retention by deletion rather than partitioning at this scale |
| Service periods crossing midnight, config in jsonb read by triggers, no external reference, no PII rule, no live-holds cap | Accepted. Section 6 |
| Occupancy and liveness both said "status" | Accepted. Occupancy is stored status, liveness is effective status (section 8) |
| A fresh read could not see a hold that expired before the sweeper reached it | Accepted. D43: effective status by database time in every read and check |
| Outbox ordering by identity id was claimed; ids are assigned at insert, not commit | Accepted. Ordering claim dropped; the live stream treats ids as hints with reconciliation (D28, D36) |
| The outbox written by trigger would shape public payloads in SQL | Accepted. D16 revised: commands write typed payloads |
| Partitioning requested early | Deferred with trigger conditions (D29) |

**Agent layer**

| Finding | Disposition |
|---|---|
| The confirm button's details came from the model's text | Accepted. The entry for the button is built from a server-side read, never from the model's text (10.6) |
| The hallucination rate depended on a judge whose recall was unmeasured, and the judge ran in the request path | Accepted. D21: async judge with published precision and recall |
| Receipt matching accepted stale state, and claims lacked fields | Accepted. D35: claims carry status, time, and party size and match the latest state as of the turn |
| Latest session observation is not authoritative state | Accepted. D42: fresh read at guardrail time; external verdicts named as observation-based |
| Prompt-injection surfaces were open until M6 | Accepted. Injection set and string caps moved into M3 |
| In-memory session state would lose confirm tokens on restart | Accepted. Sessions persisted; per-IP limits at the edge; bounded cache; advisory lock for the race |

**Validation, scope, and estimation**

| Finding | Disposition |
|---|---|
| Guarantees and hypotheses were not separated; runtime claims were asserted | Accepted. Section 7.1; "designed to" wording with the falsifying test named |
| Pool exhaustion, load, churn, and migration-under-load had no test definitions | Accepted. Section 15.1 |
| The churn test required the heap to plateau despite retained history | Accepted. Pass condition is about the partial index and reclaimable storage; short runs are inconclusive |
| Workload bounds and acceptance criteria were missing | Accepted. Section 6.5 with a decision rule |
| G1 included invariant 3, which depends on declared context | Accepted. G1 is invariants 1, 2, and 4 to 9; invariant 3 is under G2 |
| The M1 estimate was about 2.5 times too low; M2 was overloaded | Accepted. M1 re-cut; deploy, telemetry, and backups moved to M4; estimates carry a 30 percent buffer with a written cut line (D32, section 16) |
| "Capacity-based inventory" overclaimed | Accepted. D37: exclusive units and fixed combinations; quantity inventory is a stated non-goal |
| Cuts | Accepted: generated transition trigger, collector container, inline judge, trigger-written outbox, race at 500. Naive mode kept |
| Missing operational pieces | Accepted for v1.0: backups and a restore drill, timeouts, pool documentation, secrets handling, log redaction, SECURITY.md, dependency updates, runbook. The rest deferred and documented (section 18) |

**Corrections recorded while building the prototype.** Schema USAGE is granted with the functions in migration 0003; the venue config-version bump is a security-definer trigger and the app role's venue update is column-scoped; the version bump edits only the row being written and is not security definer; a same-status command is rejected by the command layer while the trigger treats the write as a metadata update; `duration_out_of_range` is a validation failure that leaves the idempotency key free, per D30; the fourth-review interleaving demonstrates queueing and cannot by itself falsify id-order locking, which the mixed-load run covers.

**Prototype results.** `results-2026-09-10-prototype.md`. G1 to G4 held in the named tests; H1 held for the eight named interleavings with a zero deadlock delta and one stated limitation; H2 first measurements recorded; H3 to H6 not yet run.

# Dastar

**A reservation engine with double-booking protection enforced by Postgres.**

Also a deterministic, self-hostable booking backend for developing and testing reservation agents.

Tables that seat different party sizes. Tables that combine. Holds that expire. Guests racing for the same reservation. Dastar is a TypeScript and Postgres engine for these cases, with a database constraint at the center of its concurrency model.

The name comes from *dastarkhan*, the Kazakh table where guests are honored.

**Status: engine prototype, v0.2.** The database core, a pool-owned TypeScript API, availability search, admin commands, a reference HTTP API with a typed client, agent tools with an MCP server, an audit of any agent's booking claims against what its recorded calls returned, a reference agent that books by chat and has each reply checked the same way, a worker for expiry and retention, a concurrency harness, and their tests are implemented and run in CI on Node.js 22, 24, and 26. A public demo is planned. The package is not yet published to npm.

[Try it](#try-it) · [Run the tests](#run-the-tests) · [See the race](#see-the-race) · [Run the API](#run-the-reference-api) · [Audit an agent](#audit-any-agent) · [Reference agent](#the-reference-agent) · [How it works](#how-it-works) · [Use the engine](#use-the-engine)

[Correctness](CORRECTNESS.md) · [Benchmarks](BENCHMARKS.md) · [Limitations](LIMITATIONS.md) · [Security](SECURITY.md) · [Decisions](docs/adr/README.md) · [Prototype results](docs/design/results-2026-09-10-prototype.md) · [System design](docs/design/design.md)

## Try it

You need Docker with Compose.

```bash
git clone https://github.com/Zhan017/dastar.git && cd dastar
docker compose run --rm demo
```

This builds one image, starts Postgres 18, applies the migrations, and sends 5000 holds for the same table and time slot at once. Exactly one wins; the other 4999 get `hold_conflict`, and a SQL check finds zero overlapping bookings. Then it turns the protections off on a throwaway database and lets 50 workers do what a plain check-then-insert application does: all 50 commit, and the same check counts 1225 overlapping pairs. The command exits 0 only when both come out that way. The first run builds the image and pulls Postgres; after that, the demo took 40 to 60 seconds on a 4 vCPU machine. `RACE_N=500` makes it shorter. The summary is printed; the JSON report files are written inside the container and go with it.

`docker compose up -d` runs the reference API on 127.0.0.1:8080 and the worker that expires stale holds, against the same database, which is published on 127.0.0.1:55433. The passwords in `compose.yml` are development defaults, every port binds to loopback only, and only the migration and demo containers get the owner's credentials. `docker compose --profile demo down -v` removes it all.

## Run the tests

You need Node.js 22 or newer, pnpm 10, and a running Docker daemon.

```bash
git clone https://github.com/Zhan017/dastar.git
cd dastar
pnpm install
pnpm test
```

`pnpm test` runs every package: the core, database, API, worker, and harness suites. Each starts a real `postgres:18` container, applies the migrations, and creates isolated test databases. The first run may need to download the image.

To run only the database package, to type-check, to lint, or to check the package boundaries:

```bash
pnpm test:db
pnpm typecheck
pnpm lint
pnpm deps:check
```

## See the race

The harness fires concurrent holds at one table and one time slot through the public API. Then it repeats the experiment the way a plain application would write it.

```bash
docker run -d --name dastar-demo -e POSTGRES_USER=dastar_owner -e POSTGRES_PASSWORD=owner -p 55432:5432 postgres:18 -c max_connections=200
until docker exec dastar-demo pg_isready -U dastar_owner; do sleep 1; done

pnpm migrate --owner-url postgres://dastar_owner:owner@localhost:55432/postgres
docker exec dastar-demo psql -U dastar_owner -d postgres -c "alter role dastar_app password 'app'"

pnpm race --owner-url postgres://dastar_owner:owner@localhost:55432/postgres --app-url postgres://dastar_app:app@localhost:55432/postgres --n 500
pnpm naive --admin-url postgres://dastar_owner:owner@localhost:55432/postgres --n 50
```

`race` sends 500 holds for the same slot, released together. It exits 0 only when exactly one wins, the other 499 receive `hold_conflict`, and a SQL check finds zero overlapping active rows.

`naive` creates a throwaway database under a generated name, drops the exclusion constraint and disables the fit trigger there, and lets 50 workers each confirm the slot is free before any of them inserts. Every worker commits, and the same SQL check counts 1225 overlapping pairs. It never touches an existing database and drops only the one it created.

## Run the reference API

A small HTTP server over the same engine: thirteen v1 routes, fifteen admin routes, hashed keys with capabilities and venue scope, and Problem Details errors. With the database from the previous section still running:

```bash
pnpm seed:demo --owner-url postgres://dastar_owner:owner@localhost:55432/postgres
DATABASE_URL=postgres://dastar_app:app@localhost:55432/postgres pnpm keys:create --label demo --capabilities hold,confirm,cancel,read
DATABASE_URL=postgres://dastar_app:app@localhost:55432/postgres pnpm api
```

`seed:demo` applies [`packages/db/seed/demo-venue.sql`](packages/db/seed/demo-venue.sql): one venue with six tables and two combinations under fixed ids, and applying it again changes nothing. The Compose stack from [Try it](#try-it) applies the same file after its migrations. `keys:create` prints a key once; only its hash is stored. The server listens on 127.0.0.1:8080; `HOST` and `PORT` change that. From another terminal, with the key in `KEY`, hold table T1 for two:

```bash
curl -s -X POST localhost:8080/v1/venues/0199a000-0000-7000-8000-000000000001/holds \
  -H "authorization: Bearer $KEY" -H "idempotency-key: friday-1" -H "content-type: application/json" \
  -d '{"party_size":2,"starts_at":"2030-06-07T19:00:00Z","duration_minutes":90,"assignment":{"kind":"unit","id":"0199a000-0000-7000-8000-000000000101"}}'
```

The response carries a receipt and `hold_expires_at`, never a token. A key with `confirm` can confirm directly, or mint a single-use token at `/v1/reservations/{id}/confirm-token`; whoever holds that token confirms without a key. `GET /openapi.json` describes every route, `/docs` shows that document in Swagger UI, and `/health/ready` reports whether the database is reachable and migrated.

`POST /v1/venues/{id}/availability` with `party_size`, `from`, and `to` answers which starts a party can book: slots inside the venue's service periods, each carrying the `starts_at`, `duration_minutes`, and `assignment` a hold accepts. The demo venue has no service periods, so it offers no slots and takes holds at any time; once a venue has a schedule, the API refuses holds outside it with `outside_schedule`.

### The contract and the typed client

[`apps/api/openapi.json`](apps/api/openapi.json) is the document the server serves, committed so that a change to it shows in review. [`@dastar/client`](packages/client) is generated from it: each call names a path as the document writes it, and the request, the response, and the Problem Details of each error are typed.

```ts
import { createDastarClient } from "@dastar/client";

const dastar = createDastarClient({ baseUrl: "http://127.0.0.1:8080", key: process.env.KEY });
const held = await dastar.POST("/v1/venues/{id}/holds", {
  params: { path: { id: "0199a000-0000-7000-8000-000000000001" }, header: { "idempotency-key": "friday-1" } },
  body: { party_size: 2, starts_at: "2030-06-07T19:00:00Z", duration_minutes: 90, assignment: { kind: "unit", id: "0199a000-0000-7000-8000-000000000101" } },
});
if (held.error) console.log(held.error.code); // hold_conflict, outside_schedule, ...
else console.log(held.data.receipt.reservation_id);
```

After a change to a route or a schema, `pnpm openapi` regenerates the document, then the client's types and the agent tools' inputs; a test fails while any of them is out of date.

### Agent tools and MCP

[`@dastar/agent-tools`](packages/agent-tools) gives an agent four tools, `search_availability`, `hold`, `cancel`, and `get_reservation`, with inputs taken from the committed document, and runs them over HTTP for one venue. There is no confirm tool: a person confirms a hold through the venue. Each distinct hold request keeps its own idempotency key, so repeating it after a lost answer returns the same hold, and `cancel` refuses reservations the session did not create.

[`@dastar/mcp`](packages/mcp) serves those tools to any MCP client over stdio. It takes a key that can read, hold, and cancel in one venue, and refuses to start with a key that can confirm or administer:

```bash
DATABASE_URL=postgres://dastar_app:app@localhost:55432/postgres pnpm keys:create --label mcp --capabilities read,hold,cancel --venues 0199a000-0000-7000-8000-000000000001
pnpm --filter @dastar/mcp build
```

Then add it to the MCP client's configuration, with the path to this clone and the printed key:

```json
{
  "mcpServers": {
    "dastar": {
      "command": "node",
      "args": ["/path/to/dastar/packages/mcp/dist/dastar-mcp.js"],
      "env": { "DASTAR_URL": "http://127.0.0.1:8080", "DASTAR_KEY": "dsk_...", "DASTAR_VENUE_ID": "0199a000-0000-7000-8000-000000000001" }
    }
  }
}
```

`DASTAR_SESSION_ID` is optional. Set it to the id of an audit session that the same key opened for the same venue (see [Audit any agent](#audit-any-agent)), and the server sends it with every tool call, so the calls are recorded in that session:

```json
"env": { "DASTAR_URL": "http://127.0.0.1:8080", "DASTAR_KEY": "dsk_...", "DASTAR_VENUE_ID": "0199a000-0000-7000-8000-000000000001", "DASTAR_SESSION_ID": "the session's id" }
```

At start-up the server asks the API whether the session is one of its key's, for its venue, and refuses to start with one line when it is not (`session <id> is not one of the key's sessions for venue <venue>`). A value that is not a uuid is refused as well. The start-up checks are not recorded in the session.

The demo venue has no service periods, so `search_availability` finds nothing there while `hold` accepts any time. To search it, create an admin key, put it in `ADMIN_KEY`, and add a service period for each day of the week, 17:00 to 23:00 in the venue's time zone, Asia/Almaty:

```bash
DATABASE_URL=postgres://dastar_app:app@localhost:55432/postgres pnpm keys:create --label admin --capabilities admin --venues 0199a000-0000-7000-8000-000000000001
for day in 1 2 3 4 5 6 7; do
  curl -s -X POST localhost:8080/admin/venues/0199a000-0000-7000-8000-000000000001/schedules \
    -H "authorization: Bearer $ADMIN_KEY" -H "content-type: application/json" \
    -d '{"day_of_week":'"$day"',"opens":"17:00","closes":"23:00","duration_by_size":{"2":90,"4":120,"8":150}}'
done
```

A booking then lasts 90 minutes for up to two guests, 120 for up to four, and 150 for up to eight. From then on the API refuses holds outside these hours with `outside_schedule`.

### Audit any agent

Any agent that calls the API with its own key can be audited over plain HTTP, with no SDK. The builder opens a session and has the agent send its id with each call; the API records every call and its receipt under the session. After the conversation the builder posts what the agent said, with the booking claims it made, and Dastar sets each claim against what the session's own calls observed, and checks the calls' receipts against the engine's audit log.

Create a key that can read, hold, and cancel for the demo venue, with its printed value in `AGENT_KEY`. The key from [Run the reference API](#run-the-reference-api) can confirm, and a key that can confirm or administer cannot open a session. Then open one:

```bash
DATABASE_URL=postgres://dastar_app:app@localhost:55432/postgres pnpm keys:create --label agent --capabilities read,hold,cancel --venues 0199a000-0000-7000-8000-000000000001
curl -s -X POST localhost:8080/v1/sessions \
  -H "authorization: Bearer $AGENT_KEY" -H "content-type: application/json" \
  -d '{"venue_id":"0199a000-0000-7000-8000-000000000001"}'
```

The answer carries the session's `id`, to put in `SESSION`:

```json
{ "id": "0199b1c2-7d3e-7a10-8f21-5c4e9a6b3d70", "venue_id": "0199a000-0000-7000-8000-000000000001", "kind": "external", "started_at": "2026-11-18T10:14:31.052Z" }
```

The agent's calls carry the session in a `dastar-session` header. Here one hold on table T2, with the header; put the `reservation_id` of its receipt in `RESERVATION`:

```bash
curl -s -X POST localhost:8080/v1/venues/0199a000-0000-7000-8000-000000000001/holds \
  -H "authorization: Bearer $AGENT_KEY" -H "dastar-session: $SESSION" -H "idempotency-key: audit-1" -H "content-type: application/json" \
  -d '{"party_size":2,"starts_at":"2030-06-07T13:00:00Z","duration_minutes":90,"assignment":{"kind":"unit","id":"0199a000-0000-7000-8000-000000000102"}}'
```

The header is read on exactly nine routes: the hold, the holds list, availability, the reservation read, and cancel, seat, complete, confirm, and confirm-token. A call without it is not recorded. A typed client sends it when it is created with a session, `createDastarClient({ baseUrl, key, session })`, and the MCP server sends it when `DASTAR_SESSION_ID` is set.

Now post the transcript: two turns, the second with one claim. A claim names a reservation and the status the agent said it had, and may add the start time, the party size, and the words it rests on. The post prints 200 and the read returns the result:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:8080/v1/sessions/$SESSION/audit \
  -H "authorization: Bearer $AGENT_KEY" -H "content-type: application/json" \
  -d '{"turns":[
    {"role":"user","text":"A table for two on Friday evening, please."},
    {"role":"assistant","text":"I have held a table for two on Friday evening. A host confirms it.","claims":[{"reservation_id":"'"$RESERVATION"'","status":"held","starts_at":"2030-06-07T13:00:00Z","party_size":2,"quote":"I have held a table for two on Friday evening."}]}
  ]}'
curl -s localhost:8080/v1/sessions/$SESSION/audit -H "authorization: Bearer $AGENT_KEY"
```

The result, formatted here for reading, with ids and times that differ on every run:

```json
{
  "session_id": "0199b1c2-7d3e-7a10-8f21-5c4e9a6b3d70",
  "audited_at": "2026-11-18T10:16:40.215Z",
  "mode": "coarse",
  "claims": { "total": 1, "backed": 1, "unbacked": 0 },
  "results": [
    {
      "turn": 1,
      "claim": {
        "reservation_id": "0199b1c3-4a52-7c9e-9b0d-2e7f61a8c405",
        "status": "held",
        "starts_at": "2030-06-07T13:00:00Z",
        "party_size": 2,
        "quote": "I have held a table for two on Friday evening."
      },
      "verdict": "backed",
      "observed": {
        "call": 41,
        "tool": "hold",
        "at": "2026-11-18T10:15:12.884Z",
        "status": "held",
        "effective_status": "held",
        "starts_at": "2030-06-07T13:00:00Z",
        "party_size": 2,
        "hold_expires_at": "2026-11-18T10:25:12.884Z"
      },
      "receipts": [
        { "reservation_id": "0199b1c3-4a52-7c9e-9b0d-2e7f61a8c405", "status": "held", "version": 1, "audit_id": 2, "trace_id": "c1f0d2a4-6b3e-4f58-9a17-0e5d8b7c2a91" }
      ],
      "receipts_omitted": 0,
      "current_status": "held",
      "current_differs": false
    }
  ],
  "receipts": { "recorded": 1, "verified": 1, "unverified": [] },
  "unknown_outcomes": 0,
  "confirmations": 0,
  "undeclared": "not checked"
}
```

What it says:

- The claim is `backed`: the latest thing the session's calls showed about that reservation was a hold with the claimed status, start time, and party size. A claim the calls do not support is `unbacked` with a `reason`: `no_observation`, `observed_later`, `status_mismatch`, `starts_at_mismatch`, or `party_size_mismatch`. A hold counts as `expired` when the claim is read at a time past its `hold_expires_at`, whether or not the sweeper had stored that.
- `mode` is `coarse` because the turns carry no time, so each claim is read against the session's last call. Give every turn an `at` and the mode is `timed`: each claim is read against what the session had seen by then, comparing the turn's time with the API's clock.
- `receipts` counts the receipts the session's calls returned and how many the engine's audit log bears out, with the same reservation, status, version, and trace id. A receipt that does not match is listed in `unverified`. The verdicts read the recorded calls whether or not their receipts are verified, so an unverified receipt is a reason to distrust the result.
- `confirmations` is 0. It counts the confirms made in the session. The agent's key cannot confirm, because a key that can confirm or administer cannot open a session, so a confirm in the session means someone gave the agent a confirm token.
- `current_status` is the reservation's status when the audit ran, and `current_differs` is true when it is not the status the session last saw. It shows when someone else changed the reservation after the agent saw it, such as staff confirming it, or a hold running out.
- `unknown_outcomes` counts calls the session recorded as started and never as completed, such as one the API stopped serving before its answer was recorded.
- `undeclared` says what the audit does not do yet: statements the agent made without declaring them as claims are not checked.

Posting a transcript again replaces the session's earlier transcript and result; `GET /v1/sessions/{id}/audit` reads the latest, and `GET /v1/sessions/{id}` shows the session's `calls` and `last_seen_at`. A transcript is 1 to 500 turns, with at most 50 claims on a turn. Text and quotes are stored with emails and numbers masked: an email address reads `[email]`, a number of 7 to 15 digits `[phone]`, one of 16 or more `[number]`; ids, ISO dates and times stay. Names are not detected, so redact guest details before posting. A session records up to 10,000 calls. An external session not seen for 30 days is gone, audit included. [LIMITATIONS.md](LIMITATIONS.md) lists what the audit does not cover.

### The reference agent

[`apps/agent`](apps/agent) is Dastar's own booking agent: a person chats, and a model searches availability, holds, and cancels through the same API, key boundary, and session recorder that any outside agent uses, so the API records its calls the way it records anyone's. Before the person sees a reply, each reservation statement the reply declares is checked against what those calls observed and against the reservation's status now; a reply that fails is regenerated, and after three failures it is replaced by a message built from reads of the reservations. The agent only holds: the person confirms with a button the app shows, which sends a single-use token that the model never sees.

It is a separate process that calls the API over HTTP and keeps its own tables in the same database. It reads eight settings, and four more are optional:

- `DATABASE_URL`: the application role's connection string, as for the API.
- `DASTAR_URL`: the reference API's address, `http://127.0.0.1:8080` here.
- `DASTAR_VENUE_ID`: the venue the agent serves.
- `AGENT_KEY` and `AGENT_KEY_ID`: the key the tools run with, which can read, hold, and cancel and nothing else, and its id.
- `DEMO_CONFIRM_KEY`: a second key, which can read and confirm; the agent reads each hold with it and mints the token the button sends. It must differ from `AGENT_KEY`.
- `DASTAR_TOKEN_KEY`: 32 bytes in base64, which the agent seals the tokens it keeps with.
- `ANTHROPIC_API_KEY`: the model provider's key.
- Optional: `AGENT_MODEL` (default `claude-opus-5-5`), `AGENT_EFFORT` (default `medium`; one of `low`, `medium`, `high`, `xhigh`, `max`), `AGENT_HOST` (default `127.0.0.1`), and `AGENT_PORT` (default `8081`).

With the database and the API from the sections above still running, create the two keys. Each prints a JSON object with its `id` and its `key`: the first one's id goes in `AGENT_KEY_ID` and its key in `AGENT_KEY`, the second one's key in `DEMO_CONFIRM_KEY`. Create the token key with `openssl rand -base64 32`, then start the agent:

```bash
DATABASE_URL=postgres://dastar_app:app@localhost:55432/postgres pnpm keys:create --label agent --capabilities read,hold,cancel --venues 0199a000-0000-7000-8000-000000000001
DATABASE_URL=postgres://dastar_app:app@localhost:55432/postgres pnpm keys:create --label demo --capabilities read,confirm --venues 0199a000-0000-7000-8000-000000000001

export DATABASE_URL=postgres://dastar_app:app@localhost:55432/postgres DASTAR_URL=http://127.0.0.1:8080
export DASTAR_VENUE_ID=0199a000-0000-7000-8000-000000000001 DASTAR_TOKEN_KEY=$(openssl rand -base64 32)
export AGENT_KEY=dsk_... AGENT_KEY_ID=the-agent-keys-id DEMO_CONFIRM_KEY=dsk_... ANTHROPIC_API_KEY=the-providers-key
pnpm --filter @dastar/agent start
```

Before it listens, on 127.0.0.1:8081, the agent checks that the venue exists, that `AGENT_KEY` reads the venue's holds and is refused both confirming and administering, that `DEMO_CONFIRM_KEY` reads them and can confirm, and that `AGENT_KEY_ID` is the id of `AGENT_KEY`. A failed check prints one line and exits 1; the line about a key names the `keys:create` command that creates the right one. Each start opens one empty audit session to confirm the key's id. `search_availability` finds slots only in a venue with service periods, so add them as in [Agent tools and MCP](#agent-tools-and-mcp). Then ask for a table:

```bash
curl -s -X POST localhost:8081/demo/chat \
  -H "content-type: application/json" \
  -d '{"message":"Please hold a table for 2 on 7 June 2030 at 19:00."}'
```

The answer, formatted here for reading, with ids and times that differ on every run and the token not shown:

```json
{
  "session_id": "0199b2d4-5e6f-7a81-9c03-4d7b1e2a8f56",
  "reply": {
    "message": "I've put a hold on a table for 2 at Dastarkhan on Friday 7 June 2030 at 19:00, for 90 minutes. It isn't booked yet. Please confirm it with the button beside this reply before 15:28, venue time, or the hold will run out.",
    "claims": [
      { "reservation_id": "0199b2d5-0a3c-7e14-b8d2-6f90a1c47e33", "status": "held", "starts_at": "2030-06-07T14:00:00Z", "party_size": 2 }
    ]
  },
  "holds": [
    {
      "reservation_id": "0199b2d5-0a3c-7e14-b8d2-6f90a1c47e33",
      "party_size": 2,
      "starts_at": "2030-06-07T14:00:00Z",
      "duration_minutes": 90,
      "hold_expires_at": "2026-11-18T10:28:40.502Z",
      "confirm_token": "…"
    }
  ],
  "guardrail": { "fired": false, "regenerations": 0, "fallback": false }
}
```

Send the next message with the `session_id`; a conversation takes up to 50 messages of 1 to 2,000 characters, one at a time, and a message sent while the previous one is still being answered is refused with 409 `turn_in_progress`. Every refusal is Problem Details in the API's shape. `reply` is the model's message and the claims it declared, and `guardrail` says whether a reply was held back, how many times the model was asked again, and whether the message is the fallback. `holds` has one entry for each reservation the conversation holds that is still held, built from a read of the reservation and never from the model's words, so a front end shows its party size, time, and expiry from there. The route has no authentication and binds loopback unless `AGENT_HOST` says otherwise.

The person confirms by sending the entry's token to the confirm route with no key, as a button's request does; here `$TOKEN` holds the entry's `confirm_token`:

```bash
curl -s -X POST localhost:8080/v1/reservations/0199b2d5-0a3c-7e14-b8d2-6f90a1c47e33/confirm \
  -H "content-type: application/json" -d '{"confirm_token":"'"$TOKEN"'"}'
```

The token never reaches the model, a log line, a stored turn, or a recorded call. The agent keeps it encrypted, with AES-256-GCM under `DASTAR_TOKEN_KEY`, in its own table, and returns it in `holds` alone. The conversation is a reference session: its turns are stored with the model that answered, a hash of the prompt, the calls and tokens the turn took, and whether it ended in the fallback, and `POST /v1/sessions/{id}/audit` refuses it, so no key can replace what the agent recorded. [SECURITY.md](SECURITY.md) and [LIMITATIONS.md](LIMITATIONS.md) list what this protects and what it leaves open.

[`agent-live.yml`](.github/workflows/agent-live.yml) is the live check: it runs the agent against the real model. No push or pull request starts it. It is started by hand, from the repository's Actions tab or with `gh workflow run agent-live.yml -f mode=probe`, with a `mode` of `probe` or `conversations`, and it fails at once, saying so, unless the repository secret `ANTHROPIC_API_KEY` is set. A run costs what its calls to the model cost on that key's account.

- `probe` makes about five requests with the agent's real tools and reply format, canned tool results, and no database, to check that the provider accepts them together.
- `conversations`, the default, sets up Postgres 18, the migrations and roles, the demo venue and a schedule for it, the three keys, and the API, then runs five conversations one after another, each in a new session, through the same turn the route runs: book a table; book and then cancel; change the party size; ask after the job has confirmed the hold with its token; ask the agent to confirm. Each is judged on state and not on wording: a live hold whose token confirms it, a recorded cancel and no hold left, one live hold at the new size, a reply claiming the reservation confirmed that is not the fallback, and a reservation still held with no confirm call recorded.

The job uploads `agent-live.json`, with each turn's reply, guardrail outcome, model, and token counts and never a token, and the API's log as `api.log`. It exits 1 unless every conversation passes.

## Measure it

Five more harness commands measure what the tests cannot: behavior under load, under pool exhaustion, over time, and during migrations. Each writes a JSON report under `apps/harness/results/` and reads its verdict from the database, not from client timeouts. With the database from the previous sections still running:

```bash
docker exec dastar-demo psql -U dastar_owner -d postgres -c "alter role dastar_worker password 'worker'"
export OWNER=postgres://dastar_owner:owner@localhost:55432/postgres
export APP=postgres://dastar_app:app@localhost:55432/postgres
export WORKER=postgres://dastar_worker:worker@localhost:55432/postgres

pnpm mixed --owner-url $OWNER --app-url $APP --worker-url $WORKER --seconds 60
pnpm exhaust --owner-url $OWNER --app-url $APP
pnpm load --owner-url $OWNER --app-url $APP --worker-url $WORKER --steps 10,25,50 --step-seconds 30
pnpm load --owner-url $OWNER --app-url $APP --worker-url $WORKER --steps 10,25,50 --step-seconds 30 --target http
pnpm churn --owner-url $OWNER --app-url $APP --worker-url $WORKER --seconds 300 --sample-seconds 30
pnpm migrate-under-load --admin-url $OWNER --app-url $APP --worker-url $WORKER
```

- `mixed` runs every writer at once on a small contended floor: unit and combo holds, confirmations, cancellations, token mints, capacity edits, the sweeper, and holds pushed to the edge of expiry. It passes only when Postgres reports no deadlock, no overlap, no party outside its capacity, and no answer outside the expected set, and every one of those paths was actually taken: an operation that hardly ever succeeded, or a sweeper that expired almost nothing, makes the run `inconclusive`.
- `exhaust` starts the reference API, fills its pool behind one blocked unit, and checks that further requests, including one for an unrelated unit, are refused with 503 at the acquire timeout. One variant releases the blocker and checks recovery; the other holds it past the statement timeout and checks that nothing is left behind. Both then retry every key.
- `load` offers a fixed, seeded arrival plan in steps across four request shapes. Offered load is planned up front, so saturation shows up as a growing backlog, latency, and errors instead of a slower test. It reports what was answered while each step's clock ran, what was still waiting at its end, and how long the run took to drain, and the report keeps every request. With the engine target it also records the phases only the engine handle can see: pool wait, the unit-lock statements, and the transaction. With `--target http` the same plan goes through the reference API, which is where end-to-end latency is judged. A run whose confirmations, cancellations, or sweeper failed, whose requests went unanswered, or whose holds got answers no healthy run produces, or whose records do not add up to the plan, is reported as invalid and no verdict is taken from it.
- `churn` cycles holds, cancellations, confirmations, and expiries, turns the sweeper off for a fifth of the run, and samples table and index size, dead tuples, WAL, autovacuum activity, and the latency of granted holds, apart from refused ones. It judges storage only if the workload itself ran clean, the occupancy in the windows it compares is alike, and the sweeper-off phase really piled up dead holds that were then cleared, and a run shorter than the design's bounded run reports `inconclusive`.
- `migrate-under-load` creates a database of its own, applies a live-safe migration set one file at a time under steady traffic, then applies a plain index build and a table rewrite once each to record what blocking does. Each migration is judged by the requests that were in flight while it ran, whenever they arrived, and by the traffic that followed it. That the files applied and what the run shows about traffic are reported apart, and the second is `inconclusive` when too few requests met a migration.

Every command exits 0 on a positive verdict, 1 on a negative verdict or an invalid run, 2 on a usage error, and 3 on `inconclusive`, which is not a pass. A percentile is printed only when enough samples lie beyond it; `n/a` means too few, never zero. A request that ended inside a phase is a lower bound on it, shown as `a..b` or `>=a`: it can break a limit and cannot meet one. `load`, `mixed`, `churn`, and `migrate-under-load` run the sweeper the design describes (every 5 seconds, 20 rows, repeated while rows remain) unless told otherwise, and every report records the sweeper it ran with. `mixed` shortens holds through the owner role to exercise expiry; its report labels that expiry as synthetic.

Numbers from a laptop are provisional and are not compared with the design targets. [bench/README.md](bench/README.md) is the runbook for a run on the target hardware class, and [BENCHMARKS.md](BENCHMARKS.md) records one.

When you are done:

```bash
docker rm -f dastar-demo
```

## How it works

Suppose a venue has tables A and B, which can also be booked together. A reservation for A+B must block both individual tables for its entire time range. Two requests arriving together must not each acquire part of that assignment.

Dastar represents an assignment as one reservation with one occupancy row per unit. This constraint on `reservation_unit` rejects overlapping active rows for the same unit:

```sql
EXCLUDE USING gist (unit_id WITH =, during WITH &&)
WHERE (active)
```

Ranges use half-open bounds: a booking ending at 19:00 can be followed by one starting at 19:00. A deferred check verifies that the reservation has exactly the unit rows its assignment requires. Cancellation and expiry deactivate those rows while retaining the booking history.

The hold command claims an idempotency key, coordinates locks, clears expired overlapping holds, and attempts the booking in one transaction. The reservation, audit entries, outbox events, and stored outcome commit together.

The application role has restricted table and column privileges. It cannot remove the exclusion constraint, edit audit rows, or directly deactivate occupancy rows. These protections apply within the documented application-role boundary; database owners remain trusted. [SECURITY.md](SECURITY.md) states both boundaries, and [CORRECTNESS.md](CORRECTNESS.md) lists each invariant with the test that would show it broken.

## Use the engine

Inside this workspace the package is `@dastar/db`. Connect a pool as the application role and build one handle per process.

```ts
import { Pool } from "pg";
import { createDastar } from "@dastar/db";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 16 });
// Required: a connection the engine discards can still emit a late error, which pg-pool re-emits here.
pool.on("error", (err) => console.error("pool error", err));

const dastar = createDastar({ pool, cancellerConnectionString: process.env.DATABASE_URL });

// starts inside the venue's service periods, smallest fitting table first; each slot is exactly what a hold accepts
const { slots } = await dastar.availability({ venueId, partySize: 4, from: "2030-06-07T15:00:00Z", to: "2030-06-07T21:00:00Z" });
const slot = slots[0]!; // { startsAt, durationMinutes, assignment }

const held = await dastar.hold({
  venueId, actor: "key:web", traceId: "req-1", idempotencyKey: "guest-42-friday",
  partySize: 4, ...slot,
});

if (held.ok) {
  await dastar.confirm({ reservationId: held.receipt.reservationId, actor: "key:staff", traceId: "req-2", venueId });
} else {
  console.log(held.error.code); // hold_conflict, party_does_not_fit, blackout
}
```

Each call checks out a pooled connection, runs one transaction, and returns the connection only after the command has settled. A command past its deadline is cancelled in the database and its connection is discarded. Commands never join a host transaction. Other failures throw a `DastarError` with a stable `code`. Authentication is the host's job: the library trusts the `actor` it is given.

## What exists today

| Area | Implemented |
|---|---|
| Domain | `@dastar/core`, with no database dependency: error codes, the reservation state table, hold input and receipt types, and the workload bounds, each checked against the schema by the engine's tests, and availability as pure functions over instants |
| Inventory | Venues, units with capacity ranges, fixed unit combinations, weekly service periods, and blackouts, changed through admin commands that refuse, or with force cancel, the live reservations a change would strand |
| Availability | Bookable starts for a party in a window, from service periods in the venue's time zone, blackouts, and live occupancy, ranked smallest fit first; each slot is exactly what a hold accepts |
| Reservations | Hold, confirm, seat, complete, cancel, batch expiry, token minting, reads, and a listing of an actor's live holds, behind one pool-owned API |
| Connections | Acquire timeout, command deadline with bounded cancellation, and discard of any connection whose state is uncertain |
| Retry handling | Stored hold outcomes scoped by venue, actor, and idempotency key, with a 24-hour retention policy; one retry on deadlock or serialization failure |
| History | Trigger-written audit records, reservation versions, and transactional outbox writes |
| Database protection | Exclusion and membership constraints, lifecycle guards, a fit check on insert and on confirmation, blackout guards under a venue-level lock, guards that keep live reservations off inactive units and combinations, restricted roles, and row-level security that confines each transaction to the venue it declares |
| Migrations | Ordered, checksummed files with lock timeouts; concurrent index builds with validated recovery |
| Verification | Raw-SQL attacks, cross-venue attacks under row-level security, transition and lifecycle tests, two-connection interleavings, a real deadlock, the connection contract, and a model-based test that runs random command sequences against a reference model and checks the state, the audit and outbox trails, and the invariants after every step |
| Worker | The sweeper as its own process, connected as `dastar_worker`: every 5 seconds, 20 holds per batch, repeated while due holds remain; retention every minute, 500 rows per batch, for idempotency rows past their 24-hour purge time, published outbox rows older than seven days, and external audit sessions, with their calls and turns, from 10 minutes after they stop being live (30 days after they were last seen); also importable into a host process |
| Harness | A race command and a naive counterexample, both runnable against any Postgres 18, and the measurement commands below |
| Reference API | Thirteen v1 routes, fifteen admin routes for units, combinations, schedules, blackouts, and a venue's keys, hashed keys with capabilities and venue scope, confirmation by key or by single-use token, Problem Details, readiness, an OpenAPI document committed and checked against the routes, a Swagger UI page, and a typed TypeScript client generated from the document |
| Agent tools | Four tools, `search_availability`, `hold`, `cancel`, and `get_reservation`, with inputs from the committed document and no confirm tool; a session keeps one idempotency key per hold request and cancels only the reservations it created; an MCP server over stdio that refuses keys able to confirm or administer, and records its calls in an audit session when `DASTAR_SESSION_ID` is set |
| Agent audit | Audit sessions opened by a key that cannot confirm or administer; a `dastar-session` header on nine v1 routes that records each call and its receipt, never a key, confirm token, external reference, cancel reason, or problem detail; transcript intake that masks emails and numbers; a deterministic matcher that sets each declared claim against the session's calls and the reservation's current status, with receipts checked against the audit log; 30-day retention of external sessions; the client's `session` option; `starts_at` on the reservation read and the holds list |
| Reference agent | `apps/agent`, a separate process that serves `POST /demo/chat` and calls the API over HTTP through the typed client and the agent tools, with a key that can read, hold, and cancel and the session header on every call; a provider interface with an Anthropic adapter; a turn of at most six calls to the model, a deadline of 120 seconds, and a guardrail that sets each declared claim against the session's calls and the reservation's status now, regenerates a failing reply twice, and then answers with a message built from reads; turns stored with their model, prompt hash, and token counts; confirm tokens minted with a second key and kept encrypted; the person confirms with a token and no key; start-up key checks; a live check against the model that is started by hand |

Authentication and capability checks belong to the host application; the reference API shows one way to do them. The library itself does not authenticate callers; token-free confirmation and token minting require authorization by the host. Webhook delivery is still planned.

## Evidence and current limits

The [prototype report](docs/design/results-2026-09-10-prototype.md) records a passing Postgres 18 test run, eight controlled interleavings with no observed deadlocks, and initial single-connection timing samples. It includes the machine, commands, measurements, and open questions.

The suites added since then cover the two findings that report left open. Commands own their connections, so a command can no longer commit or discard a host transaction. A capacity edit racing a confirmation near a hold's expiry is closed by lock order and a fit check on confirmation, with two-connection regression tests in both orders. They also cover a real two-connection deadlock that exercises the hold retry, confirmation racing holds, and the connection contract: timeouts, cancellation, and discarded connections.

Those results cover the tested scenarios. [BENCHMARKS.md](BENCHMARKS.md) records a run on a dedicated machine of the target class: at 50 holds per second for ten minutes, hold p99 was 25 ms over HTTP against a limit of 500 ms, every workload target in the design was met with zero deadlocks, and pool exhaustion and recovery, autovacuum under churn, and migrations under load all passed. Two earlier provisional runs on shared machines ([2026-09-28](docs/design/results-2026-09-28-provisional.md), [2026-10-10](docs/design/results-2026-10-10-provisional.md)) found no engine problem, and the harness and runbook problems they found were fixed before it. Per-unit advisory locks currently serialize requests for the same unit even when their dates do not overlap. [LIMITATIONS.md](LIMITATIONS.md) lists every known cost and gap.

This is an early implementation for evaluation, not yet validated under production load.

## Where it fits

Dastar models **exclusive units**: a restaurant table, a specific room, a rental item, or a vehicle. Each unit belongs to at most one occupying reservation over a given time range. A unit's capacity determines which party sizes fit; a combination reserves all of its members together.

Quantity-based inventory, such as selling individual tickets from a pool of fifty seats, is outside this model. Payments, guest identity, notifications, and authentication are the host application's responsibility. The database confines each transaction to the venue it declares; which venues a caller may act for is the host's decision.

## Next

1. **Finish agent integration:** a judge that finds the booking statements an agent made without declaring them as claims, which neither the audit nor the reference agent's guardrail checks yet, and the evals that measure the guardrail.
2. **Add operations and a demo:** signed webhook delivery, deployment guidance, and a public example with a chat page and authentication and a spend cap on `/demo/chat`.

The agent workflow is **agents hold, humans confirm**: the tools can hold and cancel but not confirm. [The reference agent](#the-reference-agent) follows it, and the person's confirmation is a token and no key. [Audit any agent](#audit-any-agent) checks the declared claims of any agent.

The [system design](docs/design/design.md) contains the decisions, invariant definitions, and milestone acceptance criteria; the seven decisions the engine's guarantees rest on, and the one that makes the reference agent an API client, are also recorded as [ADRs](docs/adr/README.md).

## Explore the code

- [Domain types and the state table](packages/core/src)
- [Public API and connection contract](packages/db/src/handle.ts)
- [Schema and migrations](packages/db/migrations)
- [Reservation commands](packages/db/src/commands)
- [Raw-SQL attack tests](packages/db/test/attack.test.ts)
- [Concurrency interleavings](packages/db/test/interleavings.test.ts) and [capacity edits versus confirmation](packages/db/test/capacity-expiry.test.ts)
- [Race and naive harness](apps/harness)
- [Reference API](apps/api), its [OpenAPI document](apps/api/openapi.json), and the [typed client](packages/client)
- [Agent tools](packages/agent-tools) and the [MCP server](packages/mcp)
- [Reference agent](apps/agent), its [prompt](apps/agent/prompts/reference-v1.md), and the [live check](.github/workflows/agent-live.yml)
- [Sweeper worker](packages/worker)
- [Correctness](CORRECTNESS.md), [Limitations](LIMITATIONS.md), [Security](SECURITY.md), [Decisions](docs/adr/README.md)
- [Prototype results and open questions](docs/design/results-2026-09-10-prototype.md)

Bug reports and reproducible counterexamples are welcome in [Issues](https://github.com/Zhan017/dastar/issues). Include the command, expected behavior, and observed result.

## License

[Apache-2.0](LICENSE).

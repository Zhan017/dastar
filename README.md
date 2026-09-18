# Dastar

**A reservation engine with double-booking protection enforced by Postgres.**

Tables that seat different party sizes. Tables that combine. Holds that expire. Guests racing for the same reservation. Dastar is a TypeScript and Postgres engine for these cases, with a database constraint at the center of its concurrency model.

The name comes from *dastarkhan*, the Kazakh table where guests are honored.

**Status: engine prototype.** The database core, a pool-owned TypeScript API, a reference HTTP API, a concurrency harness, and their tests are implemented and run in CI on Node.js 22 and 26. Availability search, agent tools, and a public demo are planned. The package is not yet published to npm.

[Run the tests](#run-the-tests) · [See the race](#see-the-race) · [Run the API](#run-the-reference-api) · [How it works](#how-it-works) · [Use the engine](#use-the-engine)

[Correctness](CORRECTNESS.md) · [Limitations](LIMITATIONS.md) · [Security](SECURITY.md) · [Prototype results](docs/design/results-2026-09-10-prototype.md) · [System design](docs/design/design.md)

## Run the tests

You need Node.js 22 or newer, pnpm 10, and a running Docker daemon.

```bash
git clone https://github.com/Zhan017/dastar.git
cd dastar
pnpm install
pnpm test
```

`pnpm test` runs every package: the database suite and the harness suite. Each starts a real `postgres:18` container, applies the migrations, and creates isolated test databases. The first run may need to download the image.

To run only the database package, or to type-check:

```bash
pnpm test:db
pnpm typecheck
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

A small HTTP server over the same engine: five routes, hashed keys with capabilities and venue scope, and Problem Details errors. With the database from the previous section still running:

```bash
pnpm seed --owner-url postgres://dastar_owner:owner@localhost:55432/postgres
DATABASE_URL=postgres://dastar_app:app@localhost:55432/postgres pnpm keys:create --label demo --capabilities hold,confirm,cancel,read
DATABASE_URL=postgres://dastar_app:app@localhost:55432/postgres pnpm api
```

`seed` prints a venue id and its unit ids. `keys:create` prints a key once; only its hash is stored. From another terminal, with those values in `VENUE`, `UNIT`, and `KEY`:

```bash
curl -s -X POST localhost:8080/v1/venues/$VENUE/holds \
  -H "authorization: Bearer $KEY" -H "idempotency-key: friday-1" -H "content-type: application/json" \
  -d '{"party_size":2,"starts_at":"2030-06-07T19:00:00Z","duration_minutes":90,"assignment":{"kind":"unit","id":"'$UNIT'"}}'
```

The response carries a receipt and `hold_expires_at`, never a token. A key with `confirm` can confirm directly, or mint a single-use token at `/v1/reservations/{id}/confirm-token`; whoever holds that token confirms without a key. `GET /openapi.json` describes every route, and `/health/ready` reports whether the database is reachable and migrated.

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

const held = await dastar.hold({
  venueId, actor: "key:web", traceId: "req-1", idempotencyKey: "guest-42-friday",
  partySize: 4, startsAt: "2030-06-07T19:00:00Z", durationMinutes: 90,
  assignment: { kind: "unit", id: tableId },
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
| Inventory | Venues, units with capacity ranges, and fixed unit combinations |
| Reservations | Hold, confirm, cancel, batch expiry, token minting, and reads, behind one pool-owned API |
| Connections | Acquire timeout, command deadline with bounded cancellation, and discard of any connection whose state is uncertain |
| Retry handling | Stored hold outcomes scoped by venue, actor, and idempotency key, with a 24-hour retention policy; one retry on deadlock or serialization failure |
| History | Trigger-written audit records, reservation versions, and transactional outbox writes |
| Database protection | Exclusion and membership constraints, lifecycle guards, a fit check on insert and on confirmation, and restricted roles |
| Migrations | Ordered, checksummed files with lock timeouts; concurrent index builds with validated recovery |
| Verification | Raw-SQL attacks, transition and lifecycle tests, two-connection interleavings, a real deadlock, and the connection contract |
| Harness | A race command and a naive counterexample, both runnable against any Postgres 18 |
| Reference API | Five v1 routes, hashed keys with capabilities and venue scope, confirmation by key or by single-use token, Problem Details, readiness, and an OpenAPI document |

Authentication and capability checks belong to the host application; the reference API shows one way to do them. The library itself does not authenticate callers; token-free confirmation and token minting require authorization by the host. Webhook delivery and retention workers are still planned.

## Evidence and current limits

The [prototype report](docs/design/results-2026-09-10-prototype.md) records a passing Postgres 18 test run, eight controlled interleavings with no observed deadlocks, and initial single-connection timing samples. It includes the machine, commands, measurements, and open questions.

The suites added since then cover the two findings that report left open. Commands own their connections, so a command can no longer commit or discard a host transaction. A capacity edit racing a confirmation near a hold's expiry is closed by lock order and a fit check on confirmation, with two-connection regression tests in both orders. They also cover a real two-connection deadlock that exercises the hold retry, confirmation racing holds, and the connection contract: timeouts, cancellation, and discarded connections.

Those results cover the tested scenarios. Target-load throughput, pool exhaustion and recovery, sustained vacuum behavior, and migrations under load remain unmeasured. Per-unit advisory locks currently serialize requests for the same unit even when their dates do not overlap. [LIMITATIONS.md](LIMITATIONS.md) lists every known cost and gap.

This is an early implementation for evaluation, not yet validated under production load.

## Where it fits

Dastar models **exclusive units**: a restaurant table, a specific room, a rental item, or a vehicle. Each unit belongs to at most one occupying reservation over a given time range. A unit's capacity determines which party sizes fit; a combination reserves all of its members together.

Quantity-based inventory, such as selling individual tickets from a pool of fifty seats, is outside this model. Payments, guest identity, notifications, authentication, and tenant isolation are the host application's responsibility.

## Next

1. **Complete the engine release:** run the contention and recovery measurements on target hardware.
2. **Add availability:** schedules, blackouts, and assignment ranking.
3. **Add agent integration:** hold-only tools, a human confirmation flow, and an auditor that checks declared booking claims against receipts and observed state.
4. **Add operations and a demo:** signed webhook delivery, deployment guidance, and a public example.

The intended agent workflow is **agents hold, humans confirm**. That integration is future work; the engine supplies the reservation and token primitives it will use.

The [system design](docs/design/design.md) contains the decisions, invariant definitions, and milestone acceptance criteria.

## Explore the code

- [Public API and connection contract](packages/db/src/handle.ts)
- [Schema and migrations](packages/db/migrations)
- [Reservation commands](packages/db/src/commands)
- [Raw-SQL attack tests](packages/db/test/attack.test.ts)
- [Concurrency interleavings](packages/db/test/interleavings.test.ts) and [capacity edits versus confirmation](packages/db/test/capacity-expiry.test.ts)
- [Race and naive harness](apps/harness)
- [Reference API](apps/api)
- [Correctness](CORRECTNESS.md), [Limitations](LIMITATIONS.md), [Security](SECURITY.md)
- [Prototype results and open questions](docs/design/results-2026-09-10-prototype.md)

Bug reports and reproducible counterexamples are welcome in [Issues](https://github.com/Zhan017/dastar/issues). Include the command, expected behavior, and observed result.

## License

[Apache-2.0](LICENSE).

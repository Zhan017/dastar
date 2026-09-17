# Dastar

**A reservation engine with double-booking protection enforced by Postgres.**

Tables that seat different party sizes. Tables that combine. Holds that expire. Guests racing for the same reservation. Dastar is a TypeScript and Postgres engine for these cases, with a database constraint at the center of its concurrency model.

The name comes from *dastarkhan*, the Kazakh table where guests are honored.

**Status: SQL prototype.** The database core and its tests are implemented. The HTTP API, availability search, agent tools, and public demo are planned. The package is not yet published to npm.

[Run the tests](#run-the-tests) · [How it works](#how-it-works) · [Prototype results](docs/design/results-2026-09-10-prototype.md) · [System design](docs/design/design.md)

## Run the tests

You need Node.js 22 or newer, pnpm 10, and a running Docker daemon. The recorded prototype run used Node.js 26; Node.js 22 compatibility has not yet been verified.

```bash
git clone https://github.com/Zhan017/dastar.git
cd dastar
pnpm install
pnpm test:db
```

The suite starts a real `postgres:18` container, applies the migrations, and creates isolated test databases. The first run may need to download the image.

To type-check:

```bash
pnpm typecheck
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

The application role has restricted table and column privileges. It cannot remove the exclusion constraint, edit audit rows, or directly deactivate occupancy rows. These protections apply within the documented application-role boundary; database owners remain trusted.

## What exists today

| Area | Implemented |
|---|---|
| Inventory | Venues, units with capacity ranges, and fixed unit combinations |
| Reservations | Hold, confirm, cancel, batch expiry, token minting, and reads |
| Retry handling | Stored hold outcomes scoped by venue, actor, and idempotency key, with a 24-hour retention policy |
| History | Trigger-written audit records, reservation versions, and transactional outbox writes |
| Database protection | Exclusion and membership constraints, lifecycle guards, and restricted roles |
| Verification | Raw-SQL attacks, transition tests, lifecycle tests, and controlled two-connection interleavings |

Authentication and capability checks belong to the host application. The current library does not authenticate callers; token-free confirmation and token minting require authorization by the host. Webhook delivery and retention workers are still planned.

## Evidence and current limits

The [prototype report](docs/design/results-2026-09-10-prototype.md) records a passing Postgres 18 test run, eight controlled interleavings with no observed deadlocks, and initial single-connection timing samples. It includes the machine, commands, measurements, and open questions.

Those results cover the tested scenarios. Target-load throughput, pool exhaustion and recovery, sustained vacuum behavior, and migrations under load remain unmeasured. Per-unit advisory locks currently serialize requests for the same unit even when their dates do not overlap.

This is an early implementation for evaluation. Transaction composition and the interaction between capacity edits and confirmation near expiry still need validation before production integration. Commands run on connections they check out from a pool you supply and never join a host transaction.

## Where it fits

Dastar models **exclusive units**: a restaurant table, a specific room, a rental item, or a vehicle. Each unit belongs to at most one occupying reservation over a given time range. A unit's capacity determines which party sizes fit; a combination reserves all of its members together.

Quantity-based inventory, such as selling individual tickets from a pool of fifty seats, is outside this model. Payments, guest identity, notifications, authentication, and tenant isolation are the host application's responsibility.

## Next

1. **Complete the engine release:** resolve prototype findings, run the contention and recovery tests, and add a reference HTTP API and reproducible concurrency demo.
2. **Add availability:** schedules, blackouts, and assignment ranking.
3. **Add agent integration:** hold-only tools, a human confirmation flow, and an auditor that checks declared booking claims against receipts and observed state.
4. **Add operations and a demo:** signed webhook delivery, deployment guidance, and a public example.

The intended agent workflow is **agents hold, humans confirm**. That integration is future work; the database prototype supplies the reservation and token primitives it will use.

The [system design](docs/design/design.md) contains the decisions, invariant definitions, and milestone acceptance criteria.

## Explore the code

- [Schema and migrations](packages/db/migrations)
- [Reservation commands](packages/db/src/commands)
- [Raw-SQL attack tests](packages/db/test/attack.test.ts)
- [Concurrency interleavings](packages/db/test/interleavings.test.ts)
- [Prototype results and open questions](docs/design/results-2026-09-10-prototype.md)

Bug reports and reproducible counterexamples are welcome in [Issues](https://github.com/Zhan017/dastar/issues). Include the command, expected behavior, and observed result.

## License

[Apache-2.0](LICENSE).

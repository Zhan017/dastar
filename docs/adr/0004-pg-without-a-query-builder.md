# ADR 4: `pg` directly, with hand-written SQL

Status: accepted. Design decision D46, superseding D5.

## Context

D5 chose Kysely with plain SQL migrations and generated types. By the time the commands existed, every statement in them was hand-written SQL: the overlap lock set, the savepoint, the advisory locks, the idempotency claim, and the sweeper's `for update skip locked` batch are all shapes a query builder either cannot express or expresses only as raw fragments. The constraints and triggers that carry the guarantees (ADR 1) are SQL by nature.

## Decision

The engine uses `pg` directly with parameterized, hand-written SQL. Migrations stay plain SQL files, ordered and checksummed, run by the engine's own runner.

## Alternatives considered

- **Kysely (D5).** Type-safe queries and generated table types; here it would have wrapped statements that are already written out in full, adding a dependency and a layer without removing any SQL.
- **Drizzle.** Same trade, with a schema definition in TypeScript that would duplicate the migrations.

## Consequences

- One fewer dependency in the package a host embeds, and the SQL a reviewer reads is the SQL that runs.
- No generated types: row shapes are typed by hand at each query, and a column rename is caught by the tests, not the compiler. The suites run against a real Postgres 18 for this reason.
- Migration files remain the single source of the schema; the runner validates nontransactional index builds (D47) and records checksums, so an edited applied migration is refused.

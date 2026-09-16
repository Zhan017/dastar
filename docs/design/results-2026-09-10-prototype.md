# SQL prototype results

Date: 2026-09-10. Code: tag `m1-prototype`, the commit this file describes; the file itself is committed after it. Machine: Apple M3, 16 GB, macOS 26.6.2. Postgres: postgres:18 in Docker via testcontainers, max_connections=200, deadlock_timeout=200ms, Docker 27.4.0.

Environment note: the workspace pins Node 22 in `.nvmrc`; this run used Node v26.6.0. The suite ran on Node 26 and passed; it has not been run on Node 22.

## Full run

`cd packages/db && pnpm typecheck && pnpm vitest run` — typecheck clean, then:

| File | Cases |
|---|---|
| migrate.test.ts | 4 |
| schema.test.ts | 4 |
| clock.test.ts | 6 |
| transitions.test.ts | 37 |
| guards.test.ts | 15 |
| attack.test.ts | 14 |
| hold.test.ts | 10 |
| idempotency.test.ts | 5 |
| lifecycle.test.ts | 11 |
| interleavings.test.ts | 8 (plus the `afterAll` deadlock-delta assertion) |
| timing.test.ts | 1 |

Total: 115 tests, 11 files, all passed. Wall time: 9.49s real (vitest-reported duration 8.63s).

## Designed guarantees (spec 7.1)

| Guarantee | Test file | Cases | Result | What it does not show |
|---|---|---|---|---|
| G1 invariants 1, 2, 4 to 9 against dastar_app | attack.test.ts, guards.test.ts, transitions.test.ts | 66 (14 + 15 + 37) | pass, no failing case | Invariant 6 is exercised by one three-step sequence; its counting property over random sequences is M2 model-based work. Invariant 8's history clause is now pinned by one guards case. |
| G2 idempotency outcome ownership within retention | idempotency.test.ts, hold.test.ts | 15 (5 + 10) | pass, no failing case | Retention purge is exercised by one deletion as the worker; the purge worker itself is M2. |
| G3 token lifecycle | lifecycle.test.ts (token cases), guards.test.ts (DA013 cases) | 5 (3 + 2) | pass, no failing case | Single-connection cases only. |
| G4 effective status | lifecycle.test.ts (effective-status case), clock.test.ts | 7 (1 + 6) | pass, no failing case | Single-connection cases only. |

## Hypotheses (spec 7.1)

| Hypothesis | What ran | Result | What it does not show |
|---|---|---|---|
| H1 zero deadlocks on reference paths | interleavings.test.ts, 8 named cases, pg_stat_database.deadlocks before and after | Deadlock delta 0 in every run observed: seven runs during implementation, two of them inside the full suite. | Evidence for these eight interleavings only. The fourth-review case demonstrates that disjoint holds queue on the shared combo rows; it cannot by itself falsify wrong id-order locking, because the overlap rows are locked in one statement and the pause follows it, so removing the ordering would not change its outcome. That falsification needs the mixed-load run in the next plan. The mixed-load run in 15.1 has not run. |
| H2 hold duration | timing.test.ts, 300 successes and 300 conflicts, one connection | Run 1: `H2 single-connection: success p50=4.4ms p95=8.2ms p99=20.6ms; conflict p50=4.7ms p95=19.5ms p99=41.5ms`. Run 2: `H2 single-connection: success p50=4.6ms p95=9.7ms p99=16.3ms; conflict p50=4.6ms p95=7.9ms p99=13.8ms`. Run 3: `H2 single-connection: success p50=6.5ms p95=37.3ms p99=74.0ms; conflict p50=4.7ms p95=8.9ms p99=15.4ms`. | Laptop, no contention, no pool; not the 4 vCPU target |
| H3 throughput at target | not run | | Next plan |
| H4 pool exhaustion and recovery | not run | | Next plan, needs the API pool |
| H5 autovacuum under churn | not run | | Next plan |
| H6 migrations under load | not run | | Next plan |

## Deviations from the spec recorded during implementation

- `reservation.created_by` added for the live-holds cap (spec 6.5 names the cap but no column).
- Schema USAGE granted in migration 0003 alongside the functions rather than in 0005 (spec 6.1).
- `trg_config_version` is a fourth security-definer writer and the app role's UPDATE on `venue` is column-scoped, excluding `config_version` (spec 6.1, 6.4).
- `confirm` and `cancel` check the locked row's stored status, after any supplied expected version, and raise `invalid_transition` for an illegal source state, because the trigger treats a same-status write as a metadata update by design (spec section 8).
- `DastarErrorCode` gained `internal` for unmapped errors (spec section 11).
- The migration runner refuses `long-blocks-writes` and `long-blocks-all` impacts without `allowBlocking` (spec 6.3).
- The venue config-version trigger required by spec 6 was missing until the final review; added as `t48_venue_config_version` (spec 6, 6.4).
- The plan placed `duration_out_of_range` among stored idempotency outcomes; corrected to match D30, it is a validation failure that leaves the key free (D30, 10.1 step 8).
- `trg_version` was security definer in the plan; corrected, since it only edits the row being written (6.1).

The spec has already been updated for all but the first and fifth of these (`created_by` and the `internal` error code); those two are recorded here only.

## Verified plan assumptions

- `select ... order by id for update` locks rows in id order: confirmed by running `explain (costs off) select id from dastar.reservation where id = any($1::uuid[]) order by id for update` against two uuids in a cloned database (throwaway file `packages/db/test/explain.tmp.test.ts`, deleted after capturing this output):

  ```
  LockRows
    ->  Sort
          Sort Key: id
          ->  Bitmap Heap Scan on reservation
                Recheck Cond: (id = ANY ('{11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222}'::uuid[]))
                ->  Bitmap Index Scan on reservation_pkey
                      Index Cond: (id = ANY ('{11111111-1111-1111-1111-111111111111,22222222-2222-2222-2222-222222222222}'::uuid[]))
  ```

  `LockRows` appears above `Sort`, confirming rows are locked in id order after sorting. `LockRows` above `Sort` is a planner property, not a language guarantee; the mixed-load run in the next plan is what would catch a regression.
- Custom settings are user-settable as dastar_app: the attack case that sets the custom setting `dastar.internal` and then attempts a unit-row update still got 42501, confirming custom settings are user-settable and prove nothing.

## Open questions carried to the next plan

1. H3 throughput at the 6.5 target — not run.
2. H4 pool exhaustion and recovery — not run.
3. H5 autovacuum under churn — not run.
4. H6 migrations under load — not run.
5. The mixed-load falsification of id-order locking with overlapping dead combos — not run.
6. The sweeper test in lifecycle.test.ts depends on file order because `expireDue` is database-wide.
7. `getReservation` has no try/catch.
8. The `rowCount === 0` version_conflict throws in confirm and cancel are unreachable after the pre-checks.
9. Unused `cancel` import in timing.test.ts.
10. `void sorted` dead code in seed.ts.
11. Closed: `migrate()` takes `maxAttempts` (total attempts, default 5) and `lockTimeout` as options.
12. Closed: the nontransactional path resets `lock_timeout` in a `finally` and is restricted to one concurrent index statement per file with validated recovery (`migrate-concurrent.test.ts`).
13. In schema.test.ts, the schema tests assert SQLSTATE only, not constraint name.
14. In 0002_schema.sql, `reservation_unit.during` has no own bounds CHECK; Task 4's DA008 guard requires equality with the checked reservation's `during`, so this closes there.
15. In 0003_functions.sql, the schema grant also names `dastar_worker` and `dastar_readonly`, consistent with 0005's intent.
16. In clock.test.ts, the `unit_lock_key` test asserts type string, not 64-bit width.
17. In guards.test.ts, DA008's "reservation not found" branch is untested and arguably FK territory.
18. In 0004_triggers.sql, `trg_token_guard` reads `old.hold_expires_at` only; the column is immutable for the app role, so this is theoretical.
19. In 0005_grants.sql, a comment notes that readonly's function EXECUTE is intentional.
20. In attack.test.ts, the unit-row attack case bundles the 42501 and DA010 assertions in one `it`.
21. In hold.ts, post-commit throws in the replay branch route through a no-op rollback.
22. In hold.ts, `overlap.rowCount!` uses a non-null assertion; `?? 0` would be defensive.
23. In get.ts, `getReservation` issues two statements outside a transaction (distinct from its missing try/catch).
24. In confirm.ts, an empty-string `confirmToken` is treated as absent.
25. Parked: in interleavings.test.ts, the fourth-review interleaving case is evidence of queueing, not of id-order correctness; no single-pause test can interpose between row locks taken by one statement, so falsifying wrong id-order locking needs the mixed-load run in item 5.
26. In interleavings.test.ts, cases 5, 6, and 8 assert wait type Lock without narrowing the event.
27. Closed: `hold()`'s retry on 40P01 and its give-up on the second occurrence are exercised in `hold-retry.test.ts` (a real deadlock with two connections, and injected failures for the exhaustion path).
28. Closed: the interleavings `afterAll` reads `pg_stat_database.deadlocks` until the value is stable for 1.2 s (`deadlockCountStable`).
29. `dastar.schema_migration` is created by the runner, not by a numbered migration, so the migration set is not self-applicable with psql.
30. `unit_combo.unit_ids` has no distinct-members or in-venue check; a duplicated member makes a combo unbookable; CHECK constraints cannot hold subqueries, so this is trigger or function territory for M2.
31. `unit_lock_key` uses md5, unavailable on FIPS builds; `hashtextextended` is a drop-in.
32. Partly closed: `handle.test.ts` connects as `dastar_readonly` for the cancellation case; no test yet asserts what that role can read.
33. Closed: commands run only through the pool-owned handle (`createDastar`), which checks out and releases its own connection; the client-taking functions are internal.

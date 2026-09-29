# Provisional measurement run

Date: 2026-09-28. Code: `1682120` on `main` (the merge of the worker and quickstart change), unmodified. Nothing here is a claim against the design's targets: the machine is not the target hardware class, and the commands ran without `--target-hardware`, so every `load` report is labeled `provisional` and applies no targets. The run exists to find problems before a day on the target machine is paid for, and it found three, all in the harness or the runbook, none in the engine.

## Machine

A shared cloud container: 4 vCPU (Intel Xeon @ 2.10 GHz), 15 GB, Linux 6.18. Docker 29.3.1, Node.js v22.22.2. Postgres 18.6 from `bench/compose.yaml`, unchanged: `max_connections=200`, `shared_buffers=2GB`, `effective_cache_size=6GB`, everything else the image default.

The target class is 4 vCPU and 8 GB on a machine of its own. This one has the same CPU count and more memory, but its CPUs are shared with other tenants, and nothing here controls for that. The reference API ran as its own process on the host (`node --import tsx src/server.ts` with `POOL_MAX=16`), not in the Compose image, because image builds in this environment needed a proxy workaround; Postgres, the API, and the harness shared the machine, as the target shape says.

## Commands

The `bench/README.md` sequence, in its order, each without `--target-hardware`:

```bash
pnpm race --owner-url $OWNER --app-url $APP --n 5000
pnpm mixed --owner-url $OWNER --app-url $APP --worker-url $WORKER --seconds 600
pnpm exhaust --owner-url $OWNER --app-url $APP --api-url http://localhost:8080 --api-key $KEY
pnpm load --owner-url $OWNER --app-url $APP --worker-url $WORKER --target http --api-url http://localhost:8080 --steps 10,25,50 --step-seconds 60 --sustain 50x600
pnpm load --owner-url $OWNER --app-url $APP --worker-url $WORKER --steps 10,25,50 --step-seconds 60 --sustain 50x600
for mix in overlapping distinct_dates disjoint_units combos; do
  pnpm load --owner-url $OWNER --app-url $APP --worker-url $WORKER --blend $mix --steps 10,25,50,100 --step-seconds 120
done
pnpm migrate-under-load --admin-url $OWNER --app-url $APP --worker-url $WORKER --rate 50 --preload 200000
pnpm churn --owner-url $CHURN --app-url $CHURN_APP --worker-url $CHURN_WORKER
```

Two were run again after an `inconclusive` first run, each on a fresh database, as described under their rows: `migrate-under-load --rate 200` and `churn --ops 2000000`. The JSON reports (92 MB, most of it the per-request records of the `load` runs) stayed on the machine and were not kept; the numbers below are the commands' printed summaries.

## Results

| Command | Verdict | Summary |
|---|---|---|
| `race --n 5000` | pass | 1 winner, 4999 `hold_conflict`, 0 overlapping pairs, 0 retries, 34.6 s |
| `mixed --seconds 600` | pass | 32 workers, about 305 000 operations; 0 deadlocks, 0 overlaps, 0 fit violations, 0 unexpected answers, 0 retries; expiry owner-aged (synthetic): 47 582 aged, 12 642 expired (3614 by the sweeper, 9028 by competing holds); sweeper 0 errors |
| `exhaust` | pass | every check in both variants: refusal with 503 `pool_timeout` and Retry-After at the acquire timeout, including the unrelated unit; 16 queued holds drained in 314 ms after release; every queued request answered 503 `timeout` at the statement timeout; no backend idle in transaction, no advisory lock left, idempotency rows only for committed outcomes, retries replayed or executed fresh as they should |
| `load --target http` | valid | see the acceptance table |
| `load` (engine) | valid | see the acceptance table |
| `load --blend overlapping` | **invalid** | by construction, see finding 1; 0 deadlocks, 0 overlaps, e2e p99 37 ms at 100/s, all but 46 holds conflicts |
| `load --blend distinct_dates` | valid | unit-lock p99 3.9, 6.3, 8.0, 9.3 ms at 10, 25, 50, 100/s; e2e p99 at most 46 ms; backlog at most 1 |
| `load --blend disjoint_units` | valid | e2e p99 at most 40 ms at every step up to 100/s; backlog at most 1 |
| `load --blend combos` | valid | e2e p99 61 ms and transaction p99 45 ms at 100/s, the costliest shape; backlog at most 1, at most 26 holds waiting at once |
| `migrate-under-load --rate 50` | inconclusive | two catalog-only migrations met 2 requests each; 6454 requests, 0 errors |
| `migrate-under-load --rate 200` | pass | see the migrations table |
| `churn` | inconclusive | reached 100 000 operations in 188 s: 3 samples, and a sweeper-off phase shorter than the TTL; see finding 2 |
| `churn --ops 2000000` | inconclusive | ran the full 1800 s bound; dead holds did not pile up with the sweeper off; see finding 3 |

### Acceptance runs, sustained step: 50 holds per second for 600 seconds, the target blend

| Measure | HTTP | Engine | Design target (not applied here) |
|---|---|---|---|
| Offered / achieved per second | 30 092 / 50.2 | 30 092 / 50.1 | 50 |
| Hold end-to-end p50 / p95 / p99 | 11.8 / 19.3 / 41.8 ms | 10.1 / 15.9 / 27.9 ms | p95 ≤ 150 ms, p99 ≤ 500 ms, over HTTP |
| Error rate, conflicts excluded | 0.00 % | 0.00 % | ≤ 0.1 % |
| Pool-acquire wait p99 | not visible | 0.2 ms | ≤ 50 ms, at the engine |
| Unit-lock phase p99, distinct dates | not visible | 6.1 ms | ≤ 100 ms, at the engine |
| Transaction p99 | not visible | 23.7 ms | none |
| Deadlocks | 0 | 0 | 0 |
| Backlog at the step's end | 2 | 2 | none |
| Drain after the last arrival | 8 ms | 4 ms | none |
| Dispatch lag p99 | 3.6 ms | 1.5 ms | a few ms, or the harness competes for CPU |
| Follow-ups | 6014 ok | 6014 ok | none |
| Sweeper | 12 962 expired, 0 errors | 14 075 expired, 0 errors | none |

The ramp steps before it (10, 25, and 50 per second for 60 seconds each) were valid in both runs, with e2e p99 between 21 and 69 ms and a backlog of at most 5. Both runs used seed 1, so they offered the same plan.

### Migrations under load at 200 requests per second over 200 000 preloaded rows

| Migration | Kind | Took | In flight | Errors | Traffic after it, p99 |
|---|---|---|---|---|---|
| nullable column | live-safe | 37 ms | 13 | 0 | 106 ms |
| concurrent index | live-safe | 223 ms | 43 | 0 | 62 ms |
| replace trigger function | live-safe | 36 ms | 13 | 0 | 83 ms |
| NOT VALID constraint | live-safe | 92 ms | 25 | 0 | 55 ms |
| validate constraint | live-safe | 67 ms | 26 | 0 | 65 ms |
| plain index | blocking, recorded | 171 ms | 37 | 0 | 65 ms |
| table rewrite | blocking, recorded | 1019 ms | 205 | 0 | 434 ms |

25 532 requests, 0 errors, 0 outside every window; baseline e2e p99 33.5 ms. The table rewrite held 205 requests for up to 985 ms and none failed.

### Churn over 1800 seconds, natural 60-second TTL

959 601 operations: 52 545 granted holds, 875 961 `hold_conflict`, 25 747 cancellations, 5348 confirmations; the sweeper expired 7881 holds in 557 batches with 0 errors, and 30 autovacuum runs completed. The exclusion index grew to 2.69 MB by the fourth minute and stayed between 2.69 and 2.71 MB to the end. The heap grew from 2.6 to 7.4 MB, in step with the retained reservation rows, which are kept by design (cancellation and expiry deactivate a booking but retain its history), not bloat; dead tuples stayed between 7 and 15 percent after the first four minutes. Granted-hold p95 moved from about 25 ms in the first half to about 29 ms in the last quarter.

## Hypotheses

| Hypothesis | What ran | Result on this machine | What it does not show |
|---|---|---|---|
| H1 zero deadlocks on reference paths | `mixed` 600 s, both acceptance `load` runs, the four diagnostics | 0 deadlocks everywhere, 0 retries in `mixed` | Not the target hardware; one seed |
| H3 throughput at target | both acceptance `load` runs | 50 per second sustained with no backlog; every 6.5 target inside its limit by a wide margin | Provisional: shared CPUs, and no targets applied by the harness |
| H4 pool exhaustion and recovery | `exhaust` | every check passed in both variants | The pool of 16 and the 5 s acquire timeout are the provisional values from section 14; no other sizes tried |
| H5 autovacuum under churn | `churn`, twice | inconclusive; the exclusion index plateaued and dead tuples stayed bounded over 1800 s | The sweeper-off recovery was never exercised, see finding 3 |
| H6 migrations under load | `migrate-under-load --rate 200` | pass | One fixture set; blocking migrations recorded, not judged |

On the decision rule of section 6.5 this run points at the first branch, the baseline stands: the unit-lock phase on distinct dates stays near 6 to 9 ms up to 100 per second, far from dominating p99. The decision itself waits for the target-hardware run.

## Findings

1. **The overlapping diagnostic can never be valid.** `--blend overlapping` sends every hold to ten units and sixteen start times on one evening; after the first few dozen win, every hold conflicts, so almost none of the planned confirmations and cancellations have a hold to act on (46 of 4494 here), and the validity gate that requires half of them marks the run invalid on any machine. The gate exists to validate the target blend. Proposed: judge that condition only when the blend can produce holds to act on, or state in the runbook that this diagnostic reads the conflict path only and what to read from it.
2. **The runbook's `churn` command stops at the operation bound on a fast machine.** 100 000 operations took 188 s here, which leaves three samples and a sweeper-off phase shorter than the 60-second TTL, so the verdict is `inconclusive` by arithmetic. Proposed: pass `--ops 2000000` in the runbook so that the 1800-second bound governs, as it did in the second run; the judge already accepts either bound.
3. **The churn workload clears its own dead holds.** A hold expires overlapping dead holds inline (10.1 step 5), and about 91 percent of `churn`'s holds compete for the same slots, so a dead hold is cleared by the next competing hold within seconds whether the sweeper runs or not: with the sweeper off for 360 s, dead holds peaked at 31 against a mean of 14.6 before. The sweeper-off phase therefore cannot show recovery. Proposed: give `churn` a share of holds on slots nothing else requests, so that some dead holds are reachable only by the sweeper.

None of the three changes an engine result. Each needs a harness or runbook change before the target-hardware run, or that run will repeat these verdicts.

## After the fixes

Run on 2026-09-29 against the same database and machine, with the fixes to findings 1 to 3 applied (the harness changes that accompany this file).

**Finding 1.** `load --blend overlapping --steps 10,25,50,100 --step-seconds 30` is now `valid`: follow-ups are judged against the granted holds they could act on. 0 deadlocks, 0 overlaps; e2e p99 48 and 23 ms at 50 and 100 per second. Its first step read p95 3.6 s and pool-wait p99 3.0 s: Postgres had just been restarted cold and the sweeper was expiring 4883 dead holds left in that database by the earlier runs; the later steps are back to the levels above.

**Findings 2 and 3.** `churn --ops 2000000` on a fresh database ran the full 1800 s and reached a verdict: **fail**.

| Window | Dead holds pending, per sample | Exclusion index | Active unit rows |
|---|---|---|---|
| before (0.15 to 0.40) | 230, 180, 6, 90, 0, 0, 12, 24, 5, 26 | 3.30 to 3.85 MB | 4640 to 5055 |
| sweeper off (0.40 to 0.60) | 48, 3228, 5942, 8965, 12 071, 15 093 | 3.89 to 5.50 MB | 4813 to 19 673 |
| recovery | 18 062, then 21 one minute later | 6.12 to 6.63 MB | 22 614, then 4340 |
| after (0.75 to 1.00) | 67, 92, 146, 159, 186, 212, 263, 229 | 6.77 MB, flat | 4044 to 4753 |

1 020 993 operations, 241 631 granted holds (175 254 on slots of their own), sweeper 96 997 expired in 4979 batches with 0 errors; granted-hold p95 between 24 and 32 ms throughout.

The fix did what it was for: with the sweeper off, dead holds piled up to 15 093, and the sweeper cleared them within two minutes of resuming. The verdict's two reasons both need a decision before the target-hardware run rather than a threshold change:

- **Dead holds "not cleared", mean 179.3 after against 22.4 before.** A fifth of the holds on slots of their own means about 48 holds a second die with nobody else to clear them, so between two sweeper ticks five seconds apart up to about 240 accumulate and are then taken. One sample a minute catches that sawtooth at a drifting phase: the before window already reads between 0 and 230, and the after window between 67 and 263. The rule compares window means with a floor of 10 rows, which at this rate measures sampling phase. A robust reading counts only dead holds older than a sweep interval or two, the ones the sweeper should already have taken. Separately, a smaller share on private slots (around 3 percent) would still pile up well over a thousand dead holds while the sweeper is off and would keep the workload near the original one: every private hold is granted, so the 20 percent share raised granted holds 4.6 times over the earlier run.
- **Exclusion index "went from 3.85 to 6.77 MB".** Active unit rows rose from about 4800 to 22 600 while the sweeper was off, the index grew with them, and afterwards it stayed at exactly 6.77 MB for the last eleven minutes with no rise. A GiST index does not return pages without a rebuild, so a sweeper outage leaves the index at its peak, which then serves as the plateau. The rule that compares the largest size before and after reads that as failure; whether it should is a design question for H5.

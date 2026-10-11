# Second provisional measurement run

Date: 2026-10-10. Code: `bfe779f` on `main` (the merge of the core package, the ADRs, the demo seed, and the lint checks), unmodified; CI passed on it (tests on Node 22 and 26, the quickstart, and the race job). Nothing here is a claim against the design's targets: the machine is not the target hardware class, and the commands ran without `--target-hardware`, so every `load` report is labeled `provisional` and applies no targets. The run repeats the [2026-09-28 run](results-2026-09-28-provisional.md) with its three harness fixes and the revised churn rules in place, on a different machine. It found no engine problem, confirmed the fixes, and found two runbook problems and one latency observation to carry into the target-hardware run.

## Machine

A shared server: AMD Ryzen 7 7700 (8 cores, 16 threads), 61 GB, Ubuntu 24.04, Linux 7.0. Docker 28.3.3, Node.js v22.23.2. Postgres 18.6 with the settings of `bench/compose.yaml` (`max_connections=200`, `shared_buffers=2GB`, `effective_cache_size=6GB`, `shm_size` 1 GB, everything else the image default), started as one container limited to 4 CPUs and 8 GB without swap, the size of the target class, at a quarter of Docker's default CPU weight.

The target class is 4 vCPU and 8 GB on a machine of its own. This server runs other workloads, about a hundred containers, so the limits bound what Postgres could use but not what it competed with. During the run the server's 1-minute load averaged 3.2 and peaked at 7.4 on 16 CPUs, and available memory never fell below 17 GB. The reference API ran as its own process (`node --import tsx src/server.ts`, `POOL_MAX=16`, bound to 127.0.0.1), and the harness ran each command from the entry point `pnpm <command>` uses, `apps/harness/src/cli.ts`, loaded with `node --import tsx`. Neither had a CPU limit; both ran at a lower scheduling priority. A watchdog would have stopped the run had the server's load or memory crossed set limits; it never did.

## Commands

The `bench/README.md` sequence, in its order, each without `--target-hardware`, against one fresh database, with `churn` on a second fresh database:

```bash
race --n 5000
mixed --seconds 600
exhaust --api-url http://127.0.0.1:$API_PORT --api-key $KEY
load --target http --api-url http://127.0.0.1:$API_PORT --steps 10,25,50 --step-seconds 60 --sustain 50x600
load --steps 10,25,50 --step-seconds 60 --sustain 50x600
for mix in overlapping distinct_dates disjoint_units combos; do
  load --blend $mix --steps 10,25,50,100 --step-seconds 120
done
migrate-under-load --rate 200 --preload 200000
churn --ops 2000000
```

Connection flags are omitted above. `migrate-under-load` ran at 200 requests per second instead of the runbook's 50, because the previous run showed 50 to be too thin to judge. The JSON reports (101 MB, most of it the per-request records of the `load` runs) were kept.

## Results

| Command | Verdict | Summary |
|---|---|---|
| `race --n 5000` | pass | 1 winner, 4999 `hold_conflict`, 0 overlapping pairs, 0 retries, 15.0 s |
| `mixed --seconds 600` | pass | 32 workers, 637 708 operations; 0 deadlocks, 0 overlaps, 0 fit violations, 0 unexpected answers, 0 retries; expiry owner-aged (synthetic): 46 718 aged, 4379 expired (644 by the sweeper, 3735 by competing holds); sweeper 0 errors |
| `exhaust` | pass | every check in both variants, as in the previous run; 16 queued holds drained in 138 ms after release |
| `load --target http` | valid | see the acceptance table |
| `load` (engine) | valid | see the acceptance table |
| `load --blend overlapping` | valid | 0 deadlocks, 0 overlaps; e2e p99 7.1 ms at 100/s; 51 holds granted, all in the first step, the rest conflicts; follow-ups ran for the granted holds and were skipped for the rest, which the fixed validity gate accepts |
| `load --blend distinct_dates` | valid | unit-lock p99 0.3, 0.6, 2.4, 3.3 ms at 10, 25, 50, 100/s; e2e p99 at most 8.7 ms; backlog at most 1 |
| `load --blend disjoint_units` | valid | e2e p99 at most 9.4 ms at every step up to 100/s; backlog at most 1 |
| `load --blend combos` | valid | e2e p99 8.9 ms and transaction p99 8.8 ms at 100/s, the costliest shape at that rate; backlog at most 1, at most 6 holds waiting at once |
| `migrate-under-load --rate 200` | inconclusive | three catalog-only migrations met 2, 4, and 2 requests; 25 325 requests, 0 errors; see finding 1 |
| `churn --ops 2000000` | pass | ended at the operation bound after 1482 s; see the churn section and findings 2 and 3 |

### Acceptance runs, sustained step: 50 holds per second for 600 seconds, the target blend

| Measure | HTTP | Engine | Design target (not applied here) |
|---|---|---|---|
| Offered / achieved per second | 30 092 / 50.2 | 30 092 / 50.2 | 50 |
| Hold end-to-end p50 / p95 / p99 | 5.8 / 7.5 / 9.2 ms | 4.0 / 5.5 / 7.0 ms | p95 ≤ 150 ms, p99 ≤ 500 ms, over HTTP |
| Error rate, conflicts excluded | 0.00 % | 0.00 % | ≤ 0.1 % |
| Pool-acquire wait p99 | not visible | 0.1 ms | ≤ 50 ms, at the engine |
| Unit-lock phase p99, distinct dates | not visible | 1.3 ms | ≤ 100 ms, at the engine |
| Transaction p99 | not visible | 6.9 ms | none |
| Deadlocks | 0 | 0 | 0 |
| Backlog at the step's end | 0 | 0 | none |
| Drain after the last arrival | 0 ms | 0 ms | none |
| Dispatch lag p99 | 0.7 ms | 0.8 ms | a few ms, or the harness competes for CPU |
| Follow-ups | 6014 ok | 6014 ok | none |
| Sweeper | 12 989 expired, 0 errors | 14 083 expired, 0 errors | none |

The ramp steps before it (10, 25, and 50 per second for 60 seconds each) were valid in both runs, with e2e p99 between 6.6 and 13.5 ms and a backlog of at most 2. Both runs used seed 1, so they offered the same plan, the same one the previous run offered.

### Migrations under load at 200 requests per second over 200 000 preloaded rows

| Migration | Kind | Took | In flight | Errors | Traffic after it, p99 |
|---|---|---|---|---|---|
| nullable column | live-safe | 11 ms | 2 | 0 | 8.5 ms |
| concurrent index | live-safe | 85 ms | 14 | 0 | 10.2 ms |
| replace trigger function | live-safe | 12 ms | 4 | 0 | 9.4 ms |
| NOT VALID constraint | live-safe | 13 ms | 2 | 0 | 10.2 ms |
| validate constraint | live-safe | 40 ms | 10 | 0 | 9.7 ms |
| plain index | blocking, recorded | 62 ms | 15 | 0 | 10.4 ms |
| table rewrite | blocking, recorded | 407 ms | 85 | 0 | 10.1 ms |

25 325 requests, 0 errors, 0 outside every window; baseline e2e p99 8.1 ms. The table rewrite held 85 requests for up to 364 ms and none failed. Every fixture applied.

### Churn, natural 60-second TTL

2 000 007 operations in 1482 s: 117 470 granted holds (57 964 on slots of their own), 1 812 917 `hold_conflict`, 57 954 cancellations, 11 666 confirmations; the sweeper expired 32 011 holds in 1723 batches with 0 errors, and 25 autovacuum runs completed. The run ended at the operation bound, so its windows are fractions of the operations rather than of 1800 s.

| Window | Dead holds pending / overdue | Exclusion index | Active unit rows | Granted-hold p95 |
|---|---|---|---|---|
| before (0.15 to 0.40) | 37 to 104 / 0 in every sample | 6.05 to 6.41 MB | 3146 to 3485 | 7.4 to 8.0 ms |
| sweeper off (0.40 to 0.60) | 17 / 0, 1141 / 926, 2130 / 1939, 3184 / 3011, 4254 / 4073, 5300 / 5109 | 6.41 MB | 2884 to 7979 | 10.3 to 10.8 ms |
| recovery | 70 / 0 at the first sample after the sweeper resumed | 6.41 MB | 2818 | 10.7 ms |
| after (0.75 to 1.00) | 10 to 91 / 0 in every sample | 6.41 MB, flat | 2625 to 2836 | 10.4 to 12.2 ms |

With the sweeper off, overdue dead holds piled up to 5109, and the first sample after it resumed found none. The exclusion index reached 6.41 MB at the seventh minute and stayed there to the end, through the sweeper-off phase, while active unit rows rose to 7979. The heap grew from 3.9 to 16.2 MB in step with the 117 470 retained reservation rows, as section 15.1 expects of retained history; heap dead tuples stayed between 6.4 and 11.7 percent from the third minute on and were 3.6 percent at the end. After the last sample, 61 dead holds were left; the cleanup expired 65 in 4 batches, outside the verdict.

## Hypotheses

| Hypothesis | What ran | Result on this machine | What it does not show |
|---|---|---|---|
| H1 zero deadlocks on reference paths | `mixed` 600 s, both acceptance `load` runs, the four diagnostics | 0 deadlocks everywhere, 0 retries in `mixed` | Not the target hardware; one seed |
| H3 throughput at target | both acceptance `load` runs | 50 per second sustained with no backlog; every 6.5 target inside its limit by a wide margin | Provisional: a shared server, and no targets applied by the harness |
| H4 pool exhaustion and recovery | `exhaust` | every check passed in both variants | The pool of 16 and the 5 s acquire timeout only |
| H5 autovacuum under churn | `churn --ops 2000000` | pass under the revised rules, unchanged since 2026-10-05 | One run; latency stepped up during it, see finding 3 |
| H6 migrations under load | `migrate-under-load --rate 200` | inconclusive: three migrations too fast for the request rate | One fixture set; blocking migrations recorded, not judged |

On the decision rule of section 6.5 this run points at the first branch again, the baseline stands: the unit-lock phase on distinct dates stays at or under 3.3 ms up to 100 per second, far from dominating p99. The decision itself waits for the target-hardware run.

## Findings

1. **`migrate-under-load` can be too thin at 200 per second on a fast machine.** Three catalog-only migrations took 11 to 13 ms here, against 36 to 92 ms in the previous run, so at 200 requests per second only 2, 4, and 2 requests were in flight during them, under the 5 the verdict needs. The verdict was `inconclusive`, as the runbook intends for thin evidence; nothing failed. A migration that takes `t` seconds is met by about `rate × (t + e2e)` requests, counting those already in flight when it starts; for a 12 ms migration and a 5 ms request, five requests need about 300 per second on average, and arrivals vary, so 500 is a safer starting point. Proposed: state in the runbook that the rate must rise until `thinEvidence` is empty, with 500 per second as the starting point on fast hardware, and run this command again at that rate.
2. **The runbook's `churn --ops 2000000` does not make the time bound govern on every machine.** On this machine 2 000 000 operations took 1482 s, so the run ended at the operation bound. Its verdict stands: progress is the larger of the time and operation fractions, so the windows and the sweeper-off phase scale with whichever bound ends the run, and the judge accepts either. The runbook's sentence that `--ops 2000000` lets the 30-minute bound govern is true only on slower machines. Proposed: reword it to say either bound may end the run, or raise the operation count so the time bound governs everywhere; the second changes the workload, so it should be decided before the target-hardware run.
3. **Granted-hold latency stepped up during `churn` and stayed up.** Granted-hold p95 was 7.4 to 8.0 ms in the first seven minutes, 10.3 ms in the sample at 481 s, and 9.9 to 12.2 ms in every sample after it. The step appears in the interval ending at 481 s, almost all of it before the sweeper-off phase began. The rule passed it: the after window's mean, 11.2 ms, is 1.47 times the before window's 7.6 ms, under the limit of 1.5 times plus 1 ms (12.4 ms), and its fitted rise across the last quarter, 1.4 ms, is under 25 percent plus 1 ms (3.8 ms). The server's load was not higher after the step than before it: the 1-minute load averaged 6.7 during the before window and 5.5 during the after window. The previous run's passing churn reported granted-hold p95 between 34 and 42 ms throughout. This run does not show the cause. Section 15.1's condition is that latency does not trend upward across the run; the harness reads that as the two limits above, and a step that then stays level passes them. Whether it should is a question for H5, like the exclusion-index plateau before it, and the target-hardware run should be read for the same pattern.

None of the three changes an engine result. Findings 1 and 2 need a runbook change before the target-hardware run; finding 3 is something that run should look for.

## Compared with the 2026-09-28 run

The same seeded plans ran with latencies two to five times lower: at the sustained step, HTTP e2e p50 was 5.8 ms against 11.8 ms and p99 9.2 ms against 41.8 ms, and the race finished in 15.0 s against 34.6 s. The machines differ in CPU model and clock, in how busy their neighbors were, and in whether the API and harness shared Postgres's four CPUs, so the difference describes the machines, not a change in the engine, and neither run is a claim. The three fixes from that run held: the overlapping diagnostic is valid, churn reached a verdict at the runbook's settings, and with the sweeper off dead holds piled up and were cleared.

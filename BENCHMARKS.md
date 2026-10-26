# Benchmarks

Every workload target in section 6.5 of the [system design](docs/design/design.md) was met on a dedicated 4 vCPU machine. At 50 holds per second for 600 seconds, hold end-to-end latency over HTTP was 19.0 ms at p95 and 25.4 ms at p99 (limits 150 and 500 ms), with 0.00 percent errors excluding conflicts (limit 0.1). At the engine handle, pool-acquire wait was 0.11 ms at p99 and the unit-lock phase on distinct dates 7.7 ms at p99 (limits 50 and 100 ms). There were zero deadlocks, and the race at N=5000 had one winner and zero overlaps. On the design's decision rule the baseline stands: the per-unit lock stays as it is.

Date: 2026-10-23. Code: `6bd7314` on `main` (the merge of the model-based test), unmodified; CI passed on it. Commands: the [runbook](bench/README.md) in its order, both acceptance runs with `--target-hardware`. The JSON reports were kept (96 MB, most of it the per-request records of the `load` runs). One machine and one seeded plan: this is evidence for the tested workload, not a capacity limit.

## Machine

A Hetzner Cloud CCX23 in Helsinki: 4 dedicated vCPUs (2 cores with 2 threads each) of an AMD EPYC Milan at about 2 GHz under KVM, 16 GB, Ubuntu 24.04.1, Linux 6.8. Docker 27.5.1 with Compose 2.32.4, Node.js v22.23.4, pnpm 10.12.1. The machine was created for this run, and nothing else ran on it. Postgres 18.6 and the reference API ran as `bench/compose.yaml` sets them up: Postgres with `max_connections=200`, `shared_buffers=2GB`, `effective_cache_size=6GB`, `shm_size` 1 GB, every other setting the image default, no CPU or memory limit; the API in its own container with `POOL_MAX=16`; both published on 127.0.0.1 only. The harness ran on the same machine, as the target shape says.

The design's class is 4 vCPU and 8 GB. This machine has the 4 vCPUs and twice the memory; it is the smallest dedicated 4 vCPU type the provider offers. Postgres's settings are those of the 8 GB class, so the extra memory is not expected to change these numbers, but no run with an 8 GB cap was made.

## Commands

```bash
race --n 5000
mixed --seconds 600
exhaust --api-url http://localhost:8080 --api-key $KEY
load --target http --api-url http://localhost:8080 --steps 10,25,50 --step-seconds 60 --sustain 50x600 --target-hardware
load --steps 10,25,50 --step-seconds 60 --sustain 50x600 --target-hardware
for mix in overlapping distinct_dates disjoint_units combos; do
  load --blend $mix --steps 10,25,50,100 --step-seconds 120
done
migrate-under-load --rate 500 --preload 200000
churn --ops 2000000   # on a second, fresh database
```

Connection flags are omitted. `migrate-under-load` ran at 500 requests per second rather than the 200 the runbook's command then said, as the runbook's note on fast machines advises; the command now says 500. The run took 1 hour 42 minutes.

## Results

| Command | Verdict | Summary |
|---|---|---|
| `race --n 5000` | pass | 1 winner, 4999 `hold_conflict`, 0 overlapping pairs, 0 retries, 26.5 s |
| `mixed --seconds 600` | pass | 32 workers, 423 777 operations; 0 deadlocks, 0 overlaps, 0 fit violations, 0 unexpected answers, 0 retries; expiry owner-aged (synthetic): 51 084 aged, 8383 expired (1706 by the sweeper, 6677 by competing holds); sweeper 0 errors |
| `exhaust` | pass | every check in both variants; 16 queued holds drained in 319 ms after release |
| `load --target http --target-hardware` | targets met | see the acceptance table |
| `load --target-hardware` (engine) | targets met | see the acceptance table |
| `load --blend overlapping` | valid | 0 deadlocks, 0 overlaps; e2e p99 25.8 ms at 100/s; 55 holds granted, all in the first step, the rest conflicts |
| `load --blend distinct_dates` | valid | unit-lock p99 3.7, 8.7, 14.5, 11.6 ms at 10, 25, 50, 100/s; e2e p99 at most 34.0 ms; backlog at most 2 |
| `load --blend disjoint_units` | valid | e2e p99 at most 28.1 ms at every step up to 100/s; backlog at most 3 |
| `load --blend combos` | valid | e2e p99 30.8 ms and transaction p99 30.7 ms at 100/s; backlog at most 4 |
| `migrate-under-load --rate 500` | pass | every live-safe migration met 14 to 136 requests in flight; 63 479 requests, 0 errors |
| `churn --ops 2000000` | pass | 1 349 344 operations in 1800 s; see the churn section |

The four diagnostic runs omit `--target-hardware`, as the runbook's commands do, so their reports are labeled `provisional` and apply no targets: they show each request shape alone, past the target rate.

### Acceptance runs, sustained step: 50 holds per second for 600 seconds, the target blend

| Measure | HTTP | Engine | Design target |
|---|---|---|---|
| Offered in total / achieved per second | 30 092 / 50.2 | 30 092 / 50.2 | 50 per second |
| Hold end-to-end p50 / p95 / p99 | 13.6 / 19.0 / 25.4 ms | 13.6 / 17.7 / 22.2 ms | p95 ≤ 150 ms, p99 ≤ 500 ms, over HTTP: met |
| Error rate, conflicts excluded | 0.00 % | 0.00 % | ≤ 0.1 %, over HTTP: met |
| Pool-acquire wait p99 | not visible | 0.11 ms | ≤ 50 ms, at the engine: met |
| Unit-lock phase p99, distinct dates | not visible | 7.7 ms | ≤ 100 ms, at the engine: met |
| Transaction p99 | not visible | 22.0 ms | none |
| Deadlocks | 0 | 0 | 0: met |
| Backlog at the step's end | 2 | 2 | none |
| Drain after the last arrival | 8 ms | 6 ms | none |
| Dispatch lag p99 | 1.1 ms | 1.0 ms | a few ms, or the harness competes for CPU |
| Follow-ups | 6014 ok | 6014 ok | none |
| Sweeper | 12 926 expired, 0 errors | 14 106 expired, 0 errors | none |

The ramp steps before it (10, 25, and 50 per second for 60 seconds each) were valid in both runs, with e2e p99 between 22.4 and 27.9 ms and a backlog of at most 5. Both runs used seed 1, the plan the provisional runs offered. Each check is judged where it can be seen: end-to-end latency and the error rate over HTTP, pool wait and the lock phase at the engine; each run reports the checks it cannot see as `not_measured`.

### Migrations under load at 500 requests per second over 200 000 preloaded rows

| Migration | Kind | Took | In flight | Errors | Traffic after it, p99 |
|---|---|---|---|---|---|
| nullable column | live-safe | 32 ms | 25 | 0 | 32.9 ms |
| concurrent index | live-safe | 247 ms | 136 | 0 | 40.3 ms |
| replace trigger function | live-safe | 27 ms | 14 | 0 | 38.4 ms |
| NOT VALID constraint | live-safe | 46 ms | 29 | 0 | 52.5 ms |
| validate constraint | live-safe | 82 ms | 48 | 0 | 41.4 ms |
| plain index | blocking, recorded | 108 ms | 64 | 0 | 72.6 ms |
| table rewrite | blocking, recorded | 732 ms | 406 | 0 | 545.3 ms |

63 479 requests, 0 errors, 0 outside every window; baseline e2e p99 31.5 ms. The table rewrite held 406 requests for up to 738 ms and none failed; the traffic after it had a p99 of 545 ms while the queue it built drained. Every fixture applied.

### Churn, natural 60-second TTL

1 349 344 operations in 1800 s: 103 355 granted holds (38 632 on slots of their own), 1 184 365 `hold_conflict`, 51 287 cancellations, 10 337 confirmations; the sweeper expired 26 193 holds in 1472 batches with 0 errors, and 30 autovacuum runs completed. The run ended at the time bound.

| Window | Dead holds pending / overdue | Exclusion index | Active unit rows | Granted-hold p95 |
|---|---|---|---|---|
| before (0.15 to 0.40) | 5 to 71 / 0 in every sample | 3.43 MB | 2230 to 2319 | 15.9 to 16.6 ms |
| sweeper off (0.40 to 0.60) | 74 / 0, 741 / 601, 1372 / 1248, 2018 / 1870, 2696 / 2547, 3333 / 3210 | 3.43 to 3.71 MB | 2323 to 5601 | 16.3 to 17.3 ms |
| the two samples after the sweeper resumed (1081 s, 1141 s) | 4028 / 3881, then 71 / 0 | 3.87, then 3.88 MB | 6293, then 2218 | 17.1, then 16.8 ms |
| after (0.75 to 1.00) | 13 to 99 / 0 in every sample | 3.91 MB, flat | 2076 to 2298 | 16.2 to 20.1 ms |

With the sweeper off, overdue dead holds piled up to 3210 by its last sample and stood at 3881 as it resumed; the sample a minute later found none. The exclusion index grew from 3.43 to 3.91 MB during and just after the outage and stayed there to the end. The heap grew from 2.1 to 13.5 MB in step with the 103 355 retained reservation rows, as section 15.1 expects of retained history; heap dead tuples were 4.8 to 8.6 percent in the last quarter. Granted-hold p95 stayed between 15.9 and 20.1 ms through the whole run. After the last sample, 41 dead holds were left; the cleanup expired 41 in 3 batches, outside the verdict.

## Hypotheses

| Hypothesis | What ran | Result | What it does not show |
|---|---|---|---|
| H1 zero deadlocks on reference paths | `mixed` 600 s, both acceptance runs, the four diagnostics | 0 deadlocks everywhere, 0 retries in `mixed` | One seed, one machine |
| H2 hold transaction duration | every `load` run | transaction p99 22.0 ms at the target rate, 30.7 ms for combinations at twice it | One machine |
| H3 throughput and latency at target | both acceptance runs | every 6.5 target met by a wide margin | The 6.5 shape and one seed only |
| H4 pool exhaustion and recovery | `exhaust` | every check passed in both variants | The pool of 16 and the 5 s acquire timeout only |
| H5 autovacuum under churn | `churn --ops 2000000` | pass | One 30-minute run |
| H6 migrations under load | `migrate-under-load --rate 500` | pass: no request lost during or after a live-safe migration | One fixture set; blocking migrations recorded, not judged |

## Decision

Section 6.5's rule: all targets met, the baseline stands. The unit-lock phase on distinct dates, the direct measure of the per-unit lock's cost, had a p99 of 7.7 ms at the target rate and at most 14.5 ms up to twice it: well under its 100 ms limit, and less than half of the end-to-end p99 at every step that measured it. The lock protocol stays as it is, and the refinement D39 describes is not scheduled.

## Findings

1. **A latency floor of about 13 ms.** Hold end-to-end p50 was 13 to 18 ms at every step from 10 to 100 per second, for refused holds as well as granted ones and at the engine handle as well as over HTTP, and the engine's transaction p99 was within 0.6 ms of its end-to-end p99 at every step but one (2.0 ms). That is about two to four times the second provisional run on a shared 16-thread server: at the sustained step, p50 was 13.6 against 5.8 ms over HTTP and 13.6 against 4.0 ms at the engine. The race, which serializes on one unit, took 26.5 s here against 15.0 s there. This run does not show the cause. The one disk figure taken after it, 290 µs per synchronous 8 kB write (`pg_test_fsync`, `open_datasync`), does not point at the disk; the rest of that measurement was cut short. No verdict depends on it: end-to-end p99 at the target rate is a twentieth of its limit.
2. **The runbook's migration command now uses 500 per second.** At 500 every live-safe migration met 14 to 136 requests in flight, against the 5 the verdict needs; the 2026-10-10 run at 200 met 2 to 4 for the fastest ones. The runbook's text already advised raising the rate on fast machines.
3. **No latency step under churn.** The 2026-10-10 run's granted-hold p95 stepped up by about 3 ms in the eighth minute and stayed there. Here it stayed between 15.9 and 20.1 ms for the whole run. The machines differ, so this does not explain the earlier step.

## Compared with the provisional runs

The same seeded plans. At the sustained step, HTTP end-to-end p50 and p99 were 13.6 and 25.4 ms here, 5.8 and 9.2 ms on the [shared 16-thread server](docs/design/results-2026-10-10-provisional.md), and 11.8 and 41.8 ms on the [shared 4 vCPU container](docs/design/results-2026-09-28-provisional.md). The machines differ in CPU model, clock, virtualization, and neighbors, so the differences describe the machines. Only this run is on a machine of the target class with nothing else on it, which is why only this run applies the targets.

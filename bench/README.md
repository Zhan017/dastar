# Benchmark runbook

How to produce numbers that can be compared with the provisional targets in the [system design](../docs/design/design.md), section 6.5. Those targets assume one machine of the 4 vCPU, 8 GB class running Postgres 18, the reference API, and the harness. Runs on any other machine are provisional: useful for finding problems, not for claims.

## What the targets are, and which run can see each

Shape: one venue, 40 units, 10 combos. Offered load of 50 holds per second for 10 minutes, blended 40 percent overlapping slots on the ten most popular units, 30 percent distinct dates on the same units, 20 percent other units, 10 percent combos; confirmations and cancellations at 20 percent of hold volume; the sweeper every 5 seconds in batches of 20.

| Target | Limit | Judged by |
|---|---|---|
| Hold end-to-end latency | p95 at or under 150 ms, p99 at or under 500 ms | `load --target http`, from the planned arrival to the API's answer |
| Error rate, conflicts excluded | at or under 0.1 percent | `load --target http` |
| Pool-acquire wait | p99 at or under 50 ms | `load` with the engine target: the command's checkout only |
| Unit-lock phase on the distinct-dates mix | p99 at or under 100 ms | `load` with the engine target |
| Deadlocks | zero | both, and `mixed` |
| Race at N=5000 | one winner, zero overlaps | `race` |

Two runs of the same seeded plan are needed because no single place sees everything. Over HTTP a request also pays for authentication, validation, and a second pool checkout for the key lookup, and that is what a caller waits for, so end-to-end is judged there. Pool wait and the lock phase are invisible from outside the process, so they are judged at the engine handle, and each check in the report names its scope. A check the run cannot observe is reported as `not_measured`, a percentile with too few samples as `no_data`, and a percentile whose bounds straddle the limit as `inconclusive`; a run with any of the last two is `inconclusive`. Nothing passes by being absent.

The targets are defined for one workload: 50 holds per second for 600 seconds, the 40/30/20/10 blend, confirmations and cancellations at 20 percent of hold volume, the design's sweeper, 40 units and 10 combos. The report lists every way the judged step differs from it under `targets.workload`. A lighter or different run can end in `missed`; it cannot end in `met`.

Before any target is judged the run itself is: `validity` fails when confirmations or cancellations failed, when fewer than half of the planned ones had a hold to act on, when the sweeper reported an error or never ran, when an invariant broke, when a request got no complete answer, when more than 0.1 percent of holds got an answer no healthy run produces (an authorization or validation refusal, a live-holds cap, an internal error), or, at the engine handle, when holds were refused for load. An invalid run's targets read `invalid` whatever its holds did. `load` exits 1 for an invalid run or a missed target, 3 for an inconclusive verdict, and 0 otherwise.

What the engine target calls phases are client-side spans, not server wait times. The unit-lock phase is the lock statements for the assignment's units: one round trip each plus any advisory-lock wait. The transaction phase runs from just before BEGIN of the final attempt to the handle's answer. A request that ends inside the lock phase, for example at the statement timeout, is kept as a censored sample at the time it had spent there, so the slowest requests are not dropped from the distribution. A censored sample is a lower bound. A percentile that depends on one prints as `a..b`, or `>=a` when the upper side is unbounded; it can miss a limit, and it meets one only if the limit would hold even had those requests never finished. The report keeps the flag on every request.

Over HTTP every request has a 30-second deadline of the harness's own, covering headers and body, so a stalled response cannot keep a run from finishing. A request past it is `transport_timeout`, and a connection that failed is `transport_error`; both are counted apart from the API's own `timeout` answers, both are lower bounds on latency, and neither says anything about the database: after the run the harness looks up each such hold's idempotency row and reports, for the holds among them, how many the database holds as granted, as refused, and with no outcome observed yet; the last is not a failure, because an outstanding request can still commit.

An API key is one actor, and a venue allows an actor at most 100 live holds, so the HTTP run creates 64 keys and rotates them.

## Set up

On the machine, with Docker, Node.js 22 or newer, and pnpm:

```bash
git clone https://github.com/Zhan017/dastar.git && cd dastar
pnpm install --frozen-lockfile

export DASTAR_OWNER_PASSWORD=$(openssl rand -hex 16)
export DASTAR_APP_PASSWORD=$(openssl rand -hex 16)
export DASTAR_WORKER_PASSWORD=$(openssl rand -hex 16)
docker compose -f bench/compose.yaml up -d postgres

export OWNER=postgres://dastar_owner:$DASTAR_OWNER_PASSWORD@localhost:5432/dastar
export APP=postgres://dastar_app:$DASTAR_APP_PASSWORD@localhost:5432/dastar
export WORKER=postgres://dastar_worker:$DASTAR_WORKER_PASSWORD@localhost:5432/dastar
pnpm migrate --owner-url $OWNER
docker compose -f bench/compose.yaml exec -T postgres psql -U dastar_owner -d dastar \
  -c "alter role dastar_app password '$DASTAR_APP_PASSWORD'" -c "alter role dastar_worker password '$DASTAR_WORKER_PASSWORD'"

docker compose -f bench/compose.yaml --profile api up -d --build api
curl -fsS localhost:8080/health/ready
export KEY=$(DATABASE_URL=$APP pnpm -s keys:create --label bench --capabilities hold | grep -o 'dsk_[A-Za-z0-9_-]*')
```

Postgres and the API are published on 127.0.0.1 only; the API image sets `HOST=0.0.0.0` inside its own container, because the API's default is loopback. `DASTAR_PG_PORT` and `DASTAR_API_PORT` move the host ports if 5432 or 8080 is taken. The Compose file sets `max_connections=200`, `shared_buffers=2GB`, and `effective_cache_size=6GB`; every other setting is the image default, and each report records the Postgres version string.

## Run

In this order, so a correctness failure stops the day before time is spent on throughput:

```bash
pnpm race --owner-url $OWNER --app-url $APP --n 5000
pnpm mixed --owner-url $OWNER --app-url $APP --worker-url $WORKER --seconds 600
pnpm exhaust --owner-url $OWNER --app-url $APP --api-url http://localhost:8080 --api-key $KEY

# acceptance: the same plan twice, once where end-to-end is judged and once where the phases are visible
pnpm load --owner-url $OWNER --app-url $APP --worker-url $WORKER --target http --api-url http://localhost:8080 \
  --steps 10,25,50 --step-seconds 60 --sustain 50x600 --target-hardware
pnpm load --owner-url $OWNER --app-url $APP --worker-url $WORKER \
  --steps 10,25,50 --step-seconds 60 --sustain 50x600 --target-hardware

# diagnosis: each request shape alone, past the target rate
for mix in overlapping distinct_dates disjoint_units combos; do
  pnpm load --owner-url $OWNER --app-url $APP --worker-url $WORKER --blend $mix --steps 10,25,50,100 --step-seconds 120
done

pnpm migrate-under-load --admin-url $OWNER --app-url $APP --worker-url $WORKER --rate 50 --preload 200000
```

`load --target http --target-hardware` refuses to start an API of its own: for a claim, the API must run in its own process, as the Compose file arranges. The harness and the database share the machine, as the target shape says. Watch `dispatch lag p99` in the `load` output: if the arrival dispatcher itself falls behind by more than a few milliseconds, the harness is competing for CPU, and the run should be repeated with the harness on a second machine, and the results should say which.

`churn` reads table-wide storage statistics, so give it a database nothing else has written to:

```bash
docker compose -f bench/compose.yaml exec -T postgres createdb -U dastar_owner dastar_churn
export CHURN=${OWNER%/dastar}/dastar_churn
pnpm migrate --owner-url $CHURN
pnpm churn --owner-url $CHURN --app-url ${APP%/dastar}/dastar_churn --worker-url ${WORKER%/dastar}/dastar_churn
```

It runs for 30 minutes or 100 000 operations, whichever comes first, under the venue's natural 60-second TTL.

## Read the results

Every command prints a summary and writes `apps/harness/results/<command>-<timestamp>.json`. Keep the JSON files. The `load` report holds every request with its planned, start, and answer times, so any question the summary does not answer can be answered from it.

- `load`: read `run valid` first. Then `achieved/s` counts what was answered while a step's clock ran; `backlog` is what had arrived by the end of the step and was still waiting; the peak of holds waiting at one instant comes from every request's arrival and answer time, not from per-second samples; the drain time runs to the last answer of any request, confirmations and cancellations included. Offered load that is not achieved, a backlog that grows from step to step, or a long drain is saturation, whatever the latency columns say. A response whose body is not the JSON object the route returns is `malformed_response` and, like a target that throws, invalidates the run; every planned request has a record, and a run whose records do not add up is invalid.
- Decision rule from the design: every target met, the baseline stands. The unit-lock phase on distinct dates dominating p99 while everything else passes schedules the per-unit lock refinement. Anything else: find the cause before touching the lock protocol.
- A nonzero deadlock count in `mixed` or `load` is a finding about lock order, not noise. The `mixed` report keeps the Postgres detail text of the first twenty retries.
- `mixed` has four verdicts. `invalid`: the sweeper or the aging connection failed. `fail`: a deadlock, an overlap, a party outside its capacity, or an answer outside the expected set. `inconclusive`: nothing went wrong, but an operation succeeded fewer than ten times, or fewer than ten holds were aged or expired by the sweeper, so a path the run exists to exercise was hardly taken. `pass` otherwise. The floor spans fourteen days so that a dead hold outlives the next competing request often enough for the sweeper to take part. `expiry.bySweeper` counts this venue only; `sweep.expired` is the sweeper's work across the database, which on a shared database includes earlier runs' dead holds.
- `exhaust` is pass or fail per check; a failed check prints the evidence it saw. It passes only when both variants ran and every check passed.
- `churn` has four verdicts. `invalid` means the workload itself failed (an unexpected answer, a sweeper error or a sweeper that never ran, a failed aging statement, a sampler failure, no successful hold), so its storage numbers describe a broken run. `inconclusive` means the run cannot be judged: too few samples or autovacuum cycles, windows whose occupancy differs, a sweeper-off phase that piled nothing up, or a run that reached neither of the design's bounds (1800 s or 100 000 operations). `pass` and `fail` compare a window before the sweeper-off phase with the last quarter of the run, and also fit the trend inside the last quarter, because two similar averages do not show a plateau. Hold latency is judged on granted holds only; refused holds are timed apart, because a refusal is cheaper and a shift in the mix of answers would otherwise move the percentile on its own. The thresholds are this harness's provisional reading of the design's pass condition; the report lists them. The measured run ends with its last sample. Dead holds still left then are reported as `cleanup.pendingDeadAtEnd` and expired afterwards in the sweeper's own batch size, and `cleanup.cleared` says whether that cleanup finished inside its budget; no sample, and so no verdict, sees that cleanup. The terminal sample after the workers stop is partial: its storage numbers are judged, its latency is reported and not judged.
- `migrate-under-load` reports two things apart. `fixturesApplied` says the seven files ran without error, which shows the runner works and nothing about traffic. `underLoad` is the verdict on traffic: each live-safe migration is judged by the requests in flight while it ran, including those that arrived before it began, and by the traffic between it and the next one. A request shed for backlog counts with the window its arrival fell in. It is `invalid` when the baseline is too small or already failing, the sweeper failed or never ran, or requests failed outside every window; `fail` when a request was lost during or after a live-safe migration, or a live-safe migration did not apply; `inconclusive` when fewer than five requests met one; `pass` otherwise. A catalog-only migration lasts milliseconds, so at a modest rate `inconclusive` is the honest result: raise `--rate` until `thinEvidence` is empty. The plain index build and the table rewrite are recorded, not judged: a blocking one that does not apply is recorded there too and leaves `fixturesApplied` false.

## Synthetic expiry

A venue's hold TTL cannot be shorter than 60 seconds. `mixed` therefore uses an owner connection to move a few live holds to within 1.5 seconds of expiry, one row per statement so that connection can never be part of a lock cycle. Its report labels the expiry `owner-aged`: it exercises the expiry paths under contention and says nothing about behavior under the natural TTL. `churn` from the command line never does this; its report says `natural-ttl`. An application role cannot shorten a hold.

Every report records the sweeper it ran with. The default is the design's. `--sweep-every-ms` and `--sweep-limit` change it, and a result measured with another sweeper describes another system.

## Tear down

```bash
docker compose -f bench/compose.yaml --profile api down -v
```

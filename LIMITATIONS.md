# Limitations

Known costs and gaps, each with the decision or measurement behind it.

- **Serialization per unit.** Two holds that share a unit never run concurrently, even for different dates, because each takes the unit's advisory lock for the length of its transaction. Single-connection hold duration is a few milliseconds; the `load` command's distinct-dates mix measures the cost under load.
- **One shared pool.** Requests for unrelated units queue behind holds that wait on a busy unit's lock. A request that cannot get a connection within the acquire timeout fails with `pool_timeout`.
- **Commands own their connections.** A command checks out a pooled connection and never joins a host transaction. Composition inside a host transaction is not supported. The host must attach an error listener to the pool it supplies; a client the engine discards can still emit a late error, which the pool re-emits.
- **Cancellation needs a canceller connection.** A command past its deadline is cancelled through a separate connection. Without one configured, the engine tries a pooled connection for half a second; if the pool is exhausted, a backend blocked on a lock keeps running until its statement timeout after its connection is discarded. A connection whose command passed its deadline is always discarded, so each deadline event costs one reconnection.
- **Nontransactional migrations are restricted.** A file declared `transaction: no` must be one `create index concurrently if not exists` or `drop index concurrently if exists` statement in the spelling Postgres itself produces. Recovery from a failed concurrent build is automatic only when the leftover index matches the file's definition.
- **No tenant isolation in the database yet.** Venue scope is declared by the host; row-level security is planned.
- **Holds occupy inventory for their TTL.** The levers under a rush are a short per-venue TTL and the per-actor live-holds cap.
- **No published numbers yet.** Throughput at the target rate, pool exhaustion and recovery, vacuum under churn, and migrations under load each have a harness command (`load`, `exhaust`, `churn`, `migrate-under-load`, and `mixed` for deadlocks). Until a run on the target hardware class is published under `docs/design/`, nothing is claimed about them.
- **The shortest hold is 60 seconds.** The schema bounds a venue's hold TTL to between one minute and one hour. The `mixed` run, and `churn` when asked, shorten individual holds through the owner role to exercise expiry; an application cannot.
- **Quantity inventory is out of scope.** Dastar models exclusive units, not pools of identical tickets.
- **One API key is one actor.** The per-actor live-holds cap, at most 100 per venue, therefore applies to everything one key holds at a time. A caller that holds more than that at once needs several keys; the HTTP load run spreads its requests over 64.
- **The reference API has no rate limiting.** The per-actor live-holds cap is the only built-in brake; put a limiter in front of it.
- **Key lookups and readiness are plain reads.** They wait a bounded time for a connection and have their own read deadline. A read past its deadline discards its connection without cancelling the backend; the role's statement timeout then ends the statement.
- **Request bodies are limited to 64 KB**, and numeric inputs have ceilings; larger values are refused as validation errors.

# Limitations

Known costs and gaps, each with the decision or measurement behind it.

- **Serialization per unit.** Two holds that share a unit never run concurrently, even for different dates, because each takes the unit's advisory lock for the length of its transaction. Single-connection hold duration is a few milliseconds; the cost under load is unmeasured until the load run.
- **One shared pool.** Requests for unrelated units queue behind holds that wait on a busy unit's lock. A request that cannot get a connection within the acquire timeout fails with `pool_timeout`.
- **Commands own their connections.** A command checks out a pooled connection and never joins a host transaction. Composition inside a host transaction is not supported.
- **Cancellation needs a canceller connection.** A command past its deadline is cancelled through a separate connection. Without one configured, a backend blocked on a lock keeps running until its statement timeout after its connection is discarded.
- **Nontransactional migrations are restricted.** A file declared `transaction: no` must be one `create index concurrently if not exists` or `drop index concurrently if exists` statement in the spelling Postgres itself produces. Recovery from a failed concurrent build is automatic only when the leftover index matches the file's definition.
- **No tenant isolation in the database yet.** Venue scope is declared by the host; row-level security is planned.
- **Holds occupy inventory for their TTL.** The levers under a rush are a short per-venue TTL and the per-actor live-holds cap.
- **Unmeasured until the load runs:** throughput at the target rate, pool exhaustion and recovery, vacuum under churn, migrations under load. The results files under `docs/design/` say what has run.
- **Quantity inventory is out of scope.** Dastar models exclusive units, not pools of identical tickets.

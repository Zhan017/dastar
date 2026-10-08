# ADR 3: Commands own their connections

Status: accepted. Design decision D45.

## Context

The first engine API took a client from the caller. A command opens and commits its own transaction, and the hold retries its whole transaction on a deadlock, so on a client that was already inside a host transaction its `begin` and `commit` would commit or discard the host's work, and the retry could not run at all. A command that overruns also needs to be cancelled in the database, and a connection left in an unknown state must not go back into a pool.

## Decision

Commands run only through a handle built from a host-supplied pool: `createDastar({ pool })`. Each call checks out a client, runs one transaction, and releases the client only after the command has settled, with:

- an acquire timeout, failing with `pool_timeout`;
- a deadline past which the backend is cancelled through a bounded request, preferably over a dedicated canceller connection so an exhausted pool cannot block cancellation;
- discard of any connection whose state is uncertain: past its deadline, after a failed rollback probe, or after a connection error.

There are no host transactions: a command cannot join one.

## Alternatives considered

- **Accept caller clients and guard on transaction state.** Detects the problem instead of removing it, and leaves deadline handling to every host.
- **Compose inside host transactions with savepoints.** The hold's retry needs to restart its outer transaction, which a savepoint cannot do.

## Consequences

- A command can never commit or discard a host's work, and its connection handling is tested once, in the engine (`packages/db/test/handle.test.ts`): idle return, error return, acquire timeout, cancellation with a working, a failing, and a stalled canceller, two concurrent deadlines, and a terminated backend.
- Hosts cannot make a reservation atomic with their own writes (`LIMITATIONS.md`). What a host learns about a command arrives through its return value and the outbox events the command commits in its own transaction.
- The host must attach an `error` listener to the pool it supplies: a client the engine discards can still emit a late error, which pg-pool re-emits on the pool.
- Every deadline event costs one reconnection, because a connection whose command passed its deadline is always discarded.

import type { ClientBase } from "pg";

export async function deadlocks(owner: ClientBase): Promise<number> {
  const r = await owner.query("select deadlocks from pg_stat_database where datname = current_database()");
  return Number(r.rows[0].deadlocks);
}

/**
 * pg_stat_database.deadlocks is flushed by the detecting backend about once per second, so one read can
 * miss the latest deadlock. Reads until the value has not changed for 1.2 s, or returns the last value
 * after 6 s.
 */
export async function deadlocksStable(owner: ClientBase): Promise<number> {
  const started = Date.now();
  let last = await deadlocks(owner);
  let stableSince = Date.now();
  for (;;) {
    await new Promise((res) => setTimeout(res, 100));
    const next = await deadlocks(owner);
    if (next !== last) { last = next; stableSince = Date.now(); }
    if (Date.now() - stableSince >= 1_200 || Date.now() - started >= 6_000) return last;
  }
}

/** Live reservations whose party is outside their assignment's capacity range. Zero is the invariant. */
export async function fitViolations(owner: ClientBase): Promise<number> {
  const r = await owner.query(
    `select count(*)::int as n
       from dastar.reservation r
       left join dastar.unit u on r.assignment_kind = 'unit' and u.id = r.assignment_id
       left join dastar.unit_combo c on r.assignment_kind = 'combo' and c.id = r.assignment_id
      where dastar.effective_status(r.status, r.hold_expires_at) in ('held', 'confirmed', 'seated')
        and (r.party_size < coalesce(u.capacity_min, c.capacity_min) or r.party_size > coalesce(u.capacity_max, c.capacity_max))`,
  );
  return r.rows[0].n as number;
}

export type BackendState = { pid: number; state: string | null; waitType: string | null; waitEvent: string | null };

/** Backends of one application in the current database. */
export async function backends(owner: ClientBase, applicationName: string): Promise<BackendState[]> {
  const r = await owner.query(
    "select pid, state, wait_event_type, wait_event from pg_stat_activity where datname = current_database() and application_name = $1",
    [applicationName],
  );
  return r.rows.map((x) => ({ pid: x.pid as number, state: x.state as string | null, waitType: x.wait_event_type as string | null, waitEvent: x.wait_event as string | null }));
}

/** Advisory locks held or awaited by one application's backends in the current database. */
export async function advisoryLocks(owner: ClientBase, applicationName: string): Promise<number> {
  const r = await owner.query(
    `select count(*)::int as n
       from pg_locks l join pg_stat_activity a on a.pid = l.pid
      where a.datname = current_database() and a.application_name = $1 and l.locktype = 'advisory'`,
    [applicationName],
  );
  return r.rows[0].n as number;
}

/** Polls observed state; throws with `what` when the condition is not met in time. */
export async function waitFor(check: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > ms) throw new Error(`not reached within ${ms}ms: ${what}`);
    await new Promise((res) => setTimeout(res, 25));
  }
}

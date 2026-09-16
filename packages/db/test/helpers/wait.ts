import { Client, type ClientBase } from "pg";

export async function connectAs(connectionString: string, appName: string): Promise<Client> {
  const c = new Client({ connectionString, application_name: appName });
  await c.connect();
  return c;
}

/** Poll pg_stat_activity until the named backend is in the expected wait state. Observed state, never a sleep. */
export async function waitForBackend(
  owner: ClientBase,
  appName: string,
  expect: { type: "Lock" | "Client" | "Activity"; event?: string },
  deadlineMs = 5_000,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    const r = await owner.query(
      "select wait_event_type, wait_event, state from pg_stat_activity where datname = current_database() and application_name = $1",
      [appName],
    );
    const row = r.rows[0];
    if (row && row.wait_event_type === expect.type && (expect.event === undefined || row.wait_event === expect.event)) return;
    if (Date.now() - started > deadlineMs) {
      throw new Error(`backend ${appName} did not reach wait ${expect.type}/${expect.event ?? "*"} within ${deadlineMs}ms; last=${JSON.stringify(row)}`);
    }
    await new Promise((res) => setTimeout(res, 20));
  }
}

export async function deadlockCount(owner: ClientBase): Promise<number> {
  const r = await owner.query("select deadlocks from pg_stat_database where datname = current_database()");
  return Number(r.rows[0].deadlocks);
}

export function gate(): { wait: () => Promise<void>; open: () => void } {
  let open!: () => void;
  const p = new Promise<void>((r) => { open = r; });
  return { wait: () => p, open };
}

/** A hook that signals when the command reached it and then blocks until released. The test awaits `reached` before starting the competing command, so ordering is never assumed. */
export function pause(): { hook: () => Promise<void>; reached: Promise<void>; release: () => void } {
  const r = gate();
  const g = gate();
  return { hook: async () => { r.open(); await g.wait(); }, reached: r.wait(), release: g.open };
}

/**
 * pg_stat_database.deadlocks is flushed by the detecting backend at most about once per second,
 * so a single read can miss the last deadlock. Read until the value has not changed for 1.2 s,
 * or give up after 6 s and return the last value.
 */
export async function deadlockCountStable(owner: ClientBase): Promise<number> {
  const started = Date.now();
  let last = await deadlockCount(owner);
  let stableSince = Date.now();
  for (;;) {
    await new Promise((res) => setTimeout(res, 100));
    const next = await deadlockCount(owner);
    if (next !== last) { last = next; stableSince = Date.now(); }
    if (Date.now() - stableSince >= 1_200 || Date.now() - started >= 6_000) return last;
  }
}

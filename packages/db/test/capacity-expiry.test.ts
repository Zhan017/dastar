import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { setClock } from "./helpers/clock.js";
import { seedVenue, type Seed } from "./helpers/seed.js";
import { connectAs, waitForBackend, deadlockCountStable, pause } from "./helpers/wait.js";
import { hold, type HoldInput } from "../src/commands/hold.js";
import { confirm } from "../src/commands/confirm.js";

describe("capacity edit versus confirmation near expiry (invariant 4)", () => {
  let conn: Conn; let owner: Client; let A: Client; let B: Client; let seed: Seed; let n = 0; let deadlocksAtStart = 0;

  beforeAll(async () => {
    conn = await cloneDatabase("capacity_expiry_test");
    owner = await connect(conn.owner);
    A = await connectAs(conn.app, "A");
    B = await connectAs(conn.app, "B");
    await B.query("select set_config('dastar.actor', 'key:B', false), set_config('dastar.trace_id', 'b', false)");
    seed = await seedVenue(owner);
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100 where id = $1", [seed.venue]);
    deadlocksAtStart = await deadlockCountStable(owner);
  });
  afterAll(async () => {
    expect(await deadlockCountStable(owner)).toBe(deadlocksAtStart);
    await A.end(); await B.end(); await owner.end(); await dropDatabase("capacity_expiry_test");
  });

  function input(unit: string): HoldInput {
    n += 1;
    const start = new Date(Date.UTC(2042, 0, 1 + Math.floor(n / 8), 8 + (n % 8)));
    return { venueId: seed.venue, actor: "key:A", traceId: `t${n}`, idempotencyKey: `k${n}`, partySize: 4, startsAt: start.toISOString(), durationMinutes: 60, assignment: { kind: "unit", id: unit } };
  }
  async function heldId(unit: string): Promise<string> {
    const out = await hold(A, input(unit));
    if (!out.ok) throw new Error(out.error.code);
    return out.receipt.reservationId;
  }
  /**
   * Judged at the editor's later time: no confirmed, seated, or still-live held reservation sits outside
   * its unit's range. A hold the edit legitimately treated as expired is expired at that time and not counted.
   */
  async function invariant4HoldsAt(iso: string): Promise<void> {
    await setClock(owner, iso);
    const r = await owner.query(`
      select count(*)::int as n
        from dastar.reservation r join dastar.unit u on u.id = r.assignment_id
       where r.assignment_kind = 'unit'
         and dastar.effective_status(r.status, r.hold_expires_at) in ('held', 'confirmed', 'seated')
         and (r.party_size < u.capacity_min or r.party_size > u.capacity_max)`);
    await setClock(owner, null);
    expect(r.rows[0].n).toBe(0);
  }

  it("order A: confirm holds the unit lock; the late capacity shrink waits and is refused", async () => {
    const u = seed.units[0]!; // capacity 1..4, party 4
    const id = await heldId(u);
    const p = pause();
    const pC = confirm(A, { reservationId: id, actor: "key:A", traceId: "c", venueId: seed.venue }, { afterUnitLocks: p.hook });
    await p.reached;
    await setClock(B, "2040-01-01T00:00:00Z"); // B judges the hold expired
    const pEdit = B.query("update dastar.unit set capacity_max = 2 where id = $1", [u]);
    await waitForBackend(owner, "B", { type: "Lock", event: "advisory" });
    p.release();
    expect((await pC).status).toBe("confirmed");
    await expect(pEdit).rejects.toMatchObject({ code: "DA012" });
    await setClock(B, null);
    await invariant4HoldsAt("2040-01-01T00:00:00Z");
  });

  it("order B: the shrink holds the unit lock; the confirm that began before expiry waits and is refused", async () => {
    const u = seed.units[1]!;
    const id = await heldId(u);
    await B.query("begin");
    await B.query("select set_config('dastar.now', '2040-01-01T00:00:00Z', true)"); // B judges the hold expired
    await B.query("update dastar.unit set capacity_max = 2 where id = $1", [u]); // holds the unit lock until commit
    const pC = confirm(A, { reservationId: id, actor: "key:A", traceId: "c2", venueId: seed.venue });
    await waitForBackend(owner, "A", { type: "Lock", event: "advisory" });
    await B.query("commit");
    await expect(pC).rejects.toMatchObject({ code: "party_does_not_fit" });
    expect((await owner.query("select status from dastar.reservation where id = $1", [id])).rows[0].status).toBe("held");
    await invariant4HoldsAt("2040-01-01T00:00:00Z");
  });

  it("a combo confirmation locks every member unit before the row", async () => {
    const c = seed.combos[0]!;
    const out = await hold(A, { ...input(c.units[0]!), partySize: 6, assignment: { kind: "combo", id: c.id } });
    if (!out.ok) throw new Error(out.error.code);
    const p = pause();
    const pC = confirm(A, { reservationId: out.receipt.reservationId, actor: "key:A", traceId: "c3", venueId: seed.venue }, { afterUnitLocks: p.hook });
    await p.reached;
    const locks = await owner.query(
      "select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid = l.pid where a.datname = current_database() and a.application_name = 'A' and l.locktype = 'advisory' and l.granted",
    );
    expect(locks.rows[0].n).toBe(2);
    p.release();
    expect((await pC).status).toBe("confirmed");
  });
});

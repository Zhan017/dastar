import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { setClock } from "./helpers/clock.js";
import { seedVenue, type Seed } from "./helpers/seed.js";
import { hold, type HoldInput } from "../src/commands/hold.js";

describe("hold", () => {
  let conn: Conn; let owner: Client; let app: Client; let seed: Seed;
  let n = 0;
  beforeAll(async () => {
    conn = await cloneDatabase("hold_test");
    owner = await connect(conn.owner);
    app = await connect(conn.app);
    seed = await seedVenue(owner);
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100 where id = $1", [seed.venue]);
  });
  afterAll(async () => { await app.end(); await owner.end(); await dropDatabase("hold_test"); });

  function input(over: Partial<HoldInput> = {}): HoldInput {
    n += 1;
    const start = new Date(Date.UTC(2034, 0, 1 + Math.floor(n / 8), 8 + (n % 8)));
    return {
      venueId: seed.venue, actor: "key:test", traceId: `t${n}`, idempotencyKey: `k${n}`,
      partySize: 2, startsAt: start.toISOString(), durationMinutes: 60,
      assignment: { kind: "unit", id: seed.units[0]! }, ...over,
    };
  }

  it("creates a held reservation with rows, audit, outbox, and a stored response", async () => {
    const i = input();
    const out = await hold(app, i);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.receipt.status).toBe("held");
    expect(out.receipt.version).toBe(1);
    expect(out.receipt.traceId).toBe(i.traceId);
    expect(out.replayed).toBe(false);
    const r = (await app.query("select status, created_by, hold_expires_at from dastar.reservation where id = $1", [out.receipt.reservationId])).rows[0];
    expect(r.status).toBe("held");
    expect(r.created_by).toBe("key:test");
    expect(new Date(r.hold_expires_at).toISOString()).toBe(out.holdExpiresAt);
    const rows = await app.query("select unit_id, active from dastar.reservation_unit where reservation_id = $1", [out.receipt.reservationId]);
    expect(rows.rows).toEqual([{ unit_id: seed.units[0], active: true }]);
    const audit = await app.query("select id, action from dastar.audit_log where entity_id = $1", [out.receipt.reservationId]);
    expect(audit.rows).toEqual([{ id: String(out.receipt.auditId), action: "insert" }]);
    const ob = await app.query("select topic, payload->>'reservation_id' as rid from dastar.outbox where venue_id = $1 and topic = 'reservation.held' and payload->>'reservation_id' = $2", [seed.venue, out.receipt.reservationId]);
    expect(ob.rowCount).toBe(1);
    const idem = await app.query("select response from dastar.idempotency where venue_id = $1 and actor = 'key:test' and key = $2", [seed.venue, i.idempotencyKey]);
    expect(idem.rows[0].response.ok).toBe(true);
  });

  it("books a combo with one row per member", async () => {
    const combo = seed.combos[0]!;
    const out = await hold(app, input({ partySize: 6, assignment: { kind: "combo", id: combo.id } }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const rows = await app.query("select unit_id from dastar.reservation_unit where reservation_id = $1 order by unit_id", [out.receipt.reservationId]);
    expect(rows.rows.map((r) => r.unit_id)).toEqual(combo.units);
  });

  it("stores a conflict and replays it even after the winner cancels", async () => {
    const a = input();
    const winner = await hold(app, a);
    expect(winner.ok).toBe(true);
    const b = input({ startsAt: a.startsAt });
    const loser = await hold(app, b);
    expect(loser).toMatchObject({ ok: false, error: { code: "hold_conflict" }, replayed: false });
    await app.query("begin");
    await app.query("select set_config('dastar.actor','key:test',true)");
    await app.query("update dastar.reservation set status = 'cancelled', cancel_reason = 'x' where id = $1", [(winner as { receipt: { reservationId: string } }).receipt.reservationId]);
    await app.query("commit");
    const again = await hold(app, b);
    expect(again).toMatchObject({ ok: false, error: { code: "hold_conflict" }, replayed: true });
    const count = await app.query("select count(*)::int as c from dastar.reservation where during = $1::tstzrange and assignment_id = $2", [`[${a.startsAt},${new Date(new Date(a.startsAt).getTime() + 3_600_000).toISOString()})`, seed.units[0]]);
    expect(count.rows[0].c).toBe(1);
  });

  it("clears an expired hold in its way and records the expiry", async () => {
    const a = input({ assignment: { kind: "unit", id: seed.units[1]! } });
    const first = await hold(app, a);
    expect(first.ok).toBe(true);
    const firstId = (first as { receipt: { reservationId: string } }).receipt.reservationId;
    await setClock(app, new Date(new Date(a.startsAt).getTime() - 3_600_000).toISOString());
    const second = await hold(app, input({ startsAt: a.startsAt, assignment: { kind: "unit", id: seed.units[1]! } }));
    await setClock(app, null);
    expect(second.ok).toBe(true);
    const old = (await app.query("select status from dastar.reservation where id = $1", [firstId])).rows[0];
    expect(old.status).toBe("expired");
    const audit = await app.query("select actor, action from dastar.audit_log where entity_id = $1 order by id", [firstId]);
    expect(audit.rows.at(-1)).toEqual({ actor: "system:conflict", action: "update:held>expired" });
    const ob = await app.query("select count(*)::int as c from dastar.outbox where topic = 'reservation.expired' and payload->>'reservation_id' = $1", [firstId]);
    expect(ob.rows[0].c).toBe(1);
  });

  it("stores party_does_not_fit and duration_out_of_range; assignment not found is party_does_not_fit", async () => {
    const big = input({ partySize: 9 });
    expect(await hold(app, big)).toMatchObject({ ok: false, error: { code: "party_does_not_fit" } });
    expect(await hold(app, big)).toMatchObject({ ok: false, error: { code: "party_does_not_fit" }, replayed: true });
    const badDuration = input({ durationMinutes: 13 * 60 });
    await expect(hold(app, badDuration)).rejects.toMatchObject({ code: "duration_out_of_range" });
    const idem = await app.query("select 1 from dastar.idempotency where venue_id = $1 and actor = $2 and key = $3", [badDuration.venueId, badDuration.actor, badDuration.idempotencyKey]);
    expect(idem.rowCount).toBe(0);
    expect(await hold(app, input({ assignment: { kind: "unit", id: "00000000-0000-7000-8000-000000000000" } }))).toMatchObject({ ok: false, error: { code: "party_does_not_fit" } });
  });

  it("rejects a different payload under the same key without creating anything", async () => {
    const a = input();
    await hold(app, a);
    await expect(hold(app, { ...a, partySize: 3 })).rejects.toMatchObject({ code: "idempotency_mismatch" });
  });

  it("replays a success with the same receipt", async () => {
    const a = input();
    const first = await hold(app, a);
    const second = await hold(app, a);
    expect(second).toEqual({ ...first, replayed: true });
    const c = await app.query("select count(*)::int as c from dastar.reservation where created_by = 'key:test' and during = $1::tstzrange", [`[${a.startsAt},${new Date(new Date(a.startsAt).getTime() + 3_600_000).toISOString()})`]);
    expect(c.rows[0].c).toBe(1);
  });

  it("enforces the live-holds cap without storing an outcome", async () => {
    await owner.query("update dastar.venue set max_live_holds_per_actor = 2 where id = $1", [seed.venue]);
    const actor = "key:capped";
    await hold(app, input({ actor, assignment: { kind: "unit", id: seed.units[2]! } }));
    await hold(app, input({ actor, assignment: { kind: "unit", id: seed.units[2]! } }));
    const third = input({ actor, assignment: { kind: "unit", id: seed.units[2]! } });
    await expect(hold(app, third)).rejects.toMatchObject({ code: "too_many_live_holds" });
    const idem = await app.query("select 1 from dastar.idempotency where actor = $1 and key = $2", [actor, third.idempotencyKey]);
    expect(idem.rowCount).toBe(0);
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100 where id = $1", [seed.venue]);
  });

  it("refuses an inactive assignment without storing an outcome", async () => {
    await owner.query("update dastar.unit set active = false where id = $1", [seed.units[5]]);
    const i = input({ assignment: { kind: "unit", id: seed.units[5]! } });
    await expect(hold(app, i)).rejects.toMatchObject({ code: "assignment_inactive" });
    expect((await app.query("select 1 from dastar.idempotency where key = $1", [i.idempotencyKey])).rowCount).toBe(0);
    await owner.query("update dastar.unit set active = true where id = $1", [seed.units[5]]);
  });

  it("refuses an overlap set above 64 rows with a retryable error", async () => {
    const u = seed.units[3]!;
    const base = Date.UTC(2035, 5, 1, 8);
    for (let k = 0; k < 65; k++) {
      const out = await hold(app, input({ actor: `key:bulk${k}`, startsAt: new Date(base + k * 5 * 60_000).toISOString(), durationMinutes: 5, assignment: { kind: "unit", id: u } }));
      expect(out.ok).toBe(true);
    }
    await setClock(app, new Date(base + 24 * 3_600_000).toISOString());
    const big = input({ startsAt: new Date(base).toISOString(), durationMinutes: 12 * 60, assignment: { kind: "unit", id: u } });
    await expect(hold(app, big)).rejects.toMatchObject({ code: "overlap_set_too_large", retryable: true });
    await setClock(app, null);
  });

  it("reports an unknown venue as not_found", async () => {
    await expect(hold(app, input({ venueId: "00000000-0000-0000-0000-000000000000" }))).rejects.toMatchObject({ code: "not_found", sqlstate: "23503" });
    const state = await owner.query("select state from pg_stat_activity where pid = (select pg_backend_pid())");
    expect(state.rowCount).toBe(1);
    expect((await hold(app, input())).ok).toBe(true);
  });
});

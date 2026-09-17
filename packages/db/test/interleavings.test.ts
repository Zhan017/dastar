import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { setClock } from "./helpers/clock.js";
import { seedVenue, type Seed } from "./helpers/seed.js";
import { connectAs, waitForBackend, deadlockCountStable, pause } from "./helpers/wait.js";
import { hold, type HoldInput, type HoldOutcome } from "../src/commands/hold.js";
import { confirm } from "../src/commands/confirm.js";
import { cancel } from "../src/commands/cancel.js";
import { expireDue } from "../src/commands/expire.js";
import { mintConfirmToken } from "../src/commands/mint-token.js";
import { getReservation } from "../src/commands/get.js";

describe("named interleavings (H1)", () => {
  let conn: Conn; let owner: Client; let A: Client; let B: Client; let W: Client; let seed: Seed;
  let deadlocksAtStart = 0; let n = 0;

  beforeAll(async () => {
    conn = await cloneDatabase("interleavings_test");
    owner = await connect(conn.owner);
    A = await connectAs(conn.app, "A"); B = await connectAs(conn.app, "B"); W = await connectAs(conn.worker, "W");
    await owner.query("select set_config('dastar.actor', 'owner', false), set_config('dastar.trace_id', 'owner', false)");
    seed = await seedVenue(owner);
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100 where id = $1", [seed.venue]);
    deadlocksAtStart = await deadlockCountStable(owner);
  });
  afterAll(async () => {
    expect(await deadlockCountStable(owner)).toBe(deadlocksAtStart);
    await A.end(); await B.end(); await W.end(); await owner.end(); await dropDatabase("interleavings_test");
  });

  function input(actor: string, over: Partial<HoldInput> = {}): HoldInput {
    n += 1;
    const start = new Date(Date.UTC(2038, 0, 1 + Math.floor(n / 8), 8 + (n % 8)));
    return { venueId: seed.venue, actor, traceId: `t${n}`, idempotencyKey: `${actor}-k${n}`, partySize: 2, startsAt: start.toISOString(), durationMinutes: 60, assignment: { kind: "unit", id: seed.units[0]! }, ...over };
  }
  const combo = (a: number, b: number) => seed.combos.find((c) => c.units.includes(seed.units[a]!) && c.units.includes(seed.units[b]!))!;
  async function expiredHold(client: Client, over: Partial<HoldInput>): Promise<string> {
    const out = await hold(client, input("key:dead", over));
    if (!out.ok) throw new Error(out.error.code);
    await owner.query("update dastar.reservation set hold_expires_at = now() - interval '1 minute' where id = $1", [out.receipt.reservationId]);
    return out.receipt.reservationId;
  }
  const ok = (o: HoldOutcome) => { expect(o.ok).toBe(true); return (o as { receipt: { reservationId: string } }).receipt.reservationId; };

  it("shared unit: the second hold queues on the advisory lock, then conflicts", async () => {
    const i = input("key:A");
    const p = pause();
    const pA = hold(A, i, { afterUnitLocks: p.hook });
    await p.reached;
    const pB = hold(B, input("key:B", { startsAt: i.startsAt }));
    await waitForBackend(owner, "B", { type: "Lock", event: "advisory" });
    p.release();
    const [a, b] = await Promise.all([pA, pB]);
    ok(a);
    expect(b).toMatchObject({ ok: false, error: { code: "hold_conflict" } });
  });

  it("third review: a retained expiry lock never meets a fresh insert, because the second hold queues first", async () => {
    const start = input("x").startsAt;
    await expiredHold(A, { startsAt: start, assignment: { kind: "unit", id: seed.units[1]! } });
    const p = pause();
    const pA = hold(A, input("key:A", { startsAt: start, partySize: 6, assignment: { kind: "combo", id: combo(0, 1).id } }), { afterUnitLocks: p.hook });
    await p.reached;
    const pB = hold(B, input("key:B", { startsAt: start, assignment: { kind: "unit", id: seed.units[0]! } }));
    await waitForBackend(owner, "B", { type: "Lock", event: "advisory" });
    p.release();
    const [a, b] = await Promise.all([pA, pB]);
    ok(a);
    expect(b).toMatchObject({ ok: false, error: { code: "hold_conflict" } });
  });

  it("fourth review: disjoint holds sharing expired combos lock them in id order and both win", async () => {
    const start = input("x").startsAt;
    await expiredHold(A, { startsAt: start, partySize: 6, assignment: { kind: "combo", id: combo(0, 2).id } });
    await expiredHold(A, { startsAt: start, partySize: 6, assignment: { kind: "combo", id: combo(1, 3).id } });
    const p = pause();
    const pA = hold(A, input("key:A", { startsAt: start, partySize: 6, assignment: { kind: "combo", id: combo(0, 3).id } }), { afterOverlapLocks: p.hook });
    await p.reached;
    const pB = hold(B, input("key:B", { startsAt: start, partySize: 6, assignment: { kind: "combo", id: combo(1, 2).id } }));
    await waitForBackend(owner, "B", { type: "Lock" });
    const bWait = (await owner.query(
      "select wait_event from pg_stat_activity where datname = current_database() and application_name = 'B'",
    )).rows[0].wait_event;
    expect(["transactionid", "tuple"]).toContain(bWait);
    p.release();
    const [a, b] = await Promise.all([pA, pB]);
    ok(a); ok(b);
  });

  it("confirm vs sweeper: whoever locks the row first decides", async () => {
    const id = ok(await hold(A, input("key:A", { assignment: { kind: "unit", id: seed.units[2]! } })));
    const p = pause();
    const pC = confirm(A, { reservationId: id, actor: "key:A", traceId: "c", venueId: seed.venue }, { afterLock: p.hook });
    await p.reached;
    await setClock(W, "2040-01-01T00:00:00Z");
    const swept = await expireDue(W, { limit: 50 });
    await setClock(W, null);
    expect(swept.expired).not.toContain(id);
    p.release();
    expect((await pC).status).toBe("confirmed");

    const id2 = ok(await hold(A, input("key:A", { assignment: { kind: "unit", id: seed.units[3]! } })));
    await setClock(W, "2040-01-01T00:00:00Z");
    const swept2 = await expireDue(W, { limit: 50 });
    await setClock(W, null);
    expect(swept2.expired).toContain(id2);
    await expect(confirm(A, { reservationId: id2, actor: "key:A", traceId: "c", venueId: seed.venue })).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("confirm vs confirm: the loser sees invalid_transition, or version_conflict with expected_version", async () => {
    const id = ok(await hold(A, input("key:A", { assignment: { kind: "unit", id: seed.units[4]! } })));
    const p = pause();
    const pA = confirm(A, { reservationId: id, actor: "key:A", traceId: "a", venueId: seed.venue }, { afterLock: p.hook });
    await p.reached;
    const pB = confirm(B, { reservationId: id, actor: "key:B", traceId: "b", venueId: seed.venue, expectedVersion: 1 });
    await waitForBackend(owner, "B", { type: "Lock" });
    p.release();
    expect((await pA).status).toBe("confirmed");
    await expect(pB).rejects.toMatchObject({ code: "version_conflict" });
    await expect(confirm(B, { reservationId: id, actor: "key:B", traceId: "b2", venueId: seed.venue })).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("hold vs an in-flight cancel of a live overlapping reservation: the hold waits, then wins", async () => {
    const i = input("key:X", { assignment: { kind: "unit", id: seed.units[5]! } });
    const x = ok(await hold(A, i));
    const p = pause();
    const pCancel = cancel(A, { reservationId: x, actor: "key:X", traceId: "cx", venueId: seed.venue, reason: "guest" }, { afterLock: p.hook });
    await p.reached;
    const pB = hold(B, input("key:B", { startsAt: i.startsAt, assignment: { kind: "unit", id: seed.units[5]! } }));
    await waitForBackend(owner, "B", { type: "Lock" });
    p.release();
    await pCancel;
    ok(await pB);
  });

  it("capacity edit vs hold, both orders", async () => {
    const u = seed.units[0]!;
    const p = pause();
    const pA = hold(A, input("key:A", { partySize: 4, assignment: { kind: "unit", id: u } }), { afterUnitLocks: p.hook });
    await p.reached;
    await B.query("select set_config('dastar.actor','key:B',false)");
    const pEdit = B.query("update dastar.unit set capacity_max = 2 where id = $1", [u]);
    await waitForBackend(owner, "B", { type: "Lock", event: "advisory" });
    p.release();
    ok(await pA);
    await expect(pEdit).rejects.toMatchObject({ code: "DA012" });

    const u2 = seed.units[1]!;
    await B.query("update dastar.unit set capacity_max = 2 where id = $1", [u2]);
    const out = await hold(A, input("key:A", { partySize: 4, assignment: { kind: "unit", id: u2 } }));
    expect(out).toMatchObject({ ok: false, error: { code: "party_does_not_fit" } });
    await B.query("update dastar.unit set capacity_max = 4 where id = $1", [u2]);
  });

  it("mint vs confirm: a mint that waits behind a confirm is refused", async () => {
    const id = ok(await hold(A, input("key:A", { assignment: { kind: "unit", id: seed.units[2]! } })));
    const p = pause();
    const pC = confirm(A, { reservationId: id, actor: "key:A", traceId: "a", venueId: seed.venue }, { afterLock: p.hook });
    await p.reached;
    const pM = mintConfirmToken(B, { reservationId: id, actor: "key:B", traceId: "m", venueId: seed.venue });
    await waitForBackend(owner, "B", { type: "Lock" });
    p.release();
    expect((await pC).status).toBe("confirmed");
    await expect(pM).rejects.toMatchObject({ code: "token_requires_held" });
  });

  it("confirm vs hold on the same unit and slot, both orders: the later one waits on the unit lock", async () => {
    const u = seed.units[5]!;
    // order 1: confirm holds the unit lock; a hold for the same slot waits, then conflicts with the confirmed row
    const i1 = input("key:A", { assignment: { kind: "unit", id: u } });
    const id = ok(await hold(A, i1));
    const p = pause();
    const pC = confirm(A, { reservationId: id, actor: "key:A", traceId: "cv", venueId: seed.venue }, { afterUnitLocks: p.hook });
    await p.reached;
    const pB = hold(B, input("key:B", { startsAt: i1.startsAt, assignment: { kind: "unit", id: u } }));
    await waitForBackend(owner, "B", { type: "Lock", event: "advisory" });
    p.release();
    expect((await pC).status).toBe("confirmed");
    expect(await pB).toMatchObject({ ok: false, error: { code: "hold_conflict" } });

    // order 2: a hold holds the unit lock; a confirm of another reservation on the unit waits, then succeeds
    const i2 = input("key:A", { assignment: { kind: "unit", id: u } });
    const id2 = ok(await hold(A, i2));
    const p2 = pause();
    const pH = hold(A, input("key:A", { startsAt: i2.startsAt, assignment: { kind: "unit", id: u } }), { afterUnitLocks: p2.hook });
    await p2.reached;
    const pC2 = confirm(B, { reservationId: id2, actor: "key:B", traceId: "cv2", venueId: seed.venue });
    await waitForBackend(owner, "B", { type: "Lock", event: "advisory" });
    p2.release();
    expect(await pH).toMatchObject({ ok: false, error: { code: "hold_conflict" } });
    expect((await pC2).status).toBe("confirmed");
  });

  it("a read sees one snapshot: a confirmation that lands between the row and the history is invisible to it", async () => {
    const id = ok(await hold(A, input("key:A", { assignment: { kind: "unit", id: seed.units[3]! } })));
    const before = await getReservation(A, id);
    const p = pause();
    const pRead = getReservation(A, id, { afterRow: p.hook });
    await p.reached;
    expect((await confirm(B, { reservationId: id, actor: "key:B", traceId: "snap", venueId: seed.venue })).status).toBe("confirmed");
    p.release();
    const view = await pRead;
    expect(view?.status).toBe("held");
    expect(view?.history).toEqual(before?.history);
    const after = await getReservation(A, id);
    expect(after?.status).toBe("confirmed");
    expect(after?.history.length).toBeGreaterThan(before!.history.length);
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool, type Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { setClock } from "./helpers/clock.js";
import { seedVenue, type Seed } from "./helpers/seed.js";
import { connectAs, waitForBackend, pause, outcome, type Outcome } from "./helpers/wait.js";
import { createDastar } from "../src/handle.js";
import { hold, type HoldInput, type Receipt } from "../src/commands/hold.js";
import { confirm } from "../src/commands/confirm.js";
import { cancel } from "../src/commands/cancel.js";
import { seat, complete, type StatusHooks } from "../src/commands/seat.js";
import { expireDue } from "../src/commands/expire.js";

type Status = "held" | "confirmed" | "seated" | "completed" | "cancelled" | "expired";

describe("seat and complete", () => {
  let conn: Conn; let owner: Client; let app: Client; let worker: Client;
  let lockA: Client; let lockB: Client;
  let A: Seed; let B: Seed;
  let n = 0;
  const ABSENT = "00000000-0000-7000-8000-000000000000";
  const LOCK_B = "seat-lock-B";

  beforeAll(async () => {
    conn = await cloneDatabase("seat_test");
    owner = await connect(conn.owner);
    app = await connect(conn.app);
    worker = await connect(conn.worker);
    lockA = await connectAs(conn.app, "seat-lock-A");
    lockB = await connectAs(conn.app, LOCK_B);
    A = await seedVenue(owner);
    B = await seedVenue(owner);
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100 where id = any($1::uuid[])", [[A.venue, B.venue]]);
  });
  afterAll(async () => {
    await lockB.end(); await lockA.end(); await worker.end(); await app.end(); await owner.end();
    await dropDatabase("seat_test");
  });

  const ctx = (seed: Seed = A) => ({ actor: "key:desk", traceId: `seat-t${++n}`, venueId: seed.venue });

  /** One hold through the engine; every call gets its own day, so no overlap is in the way. */
  async function place(seed: Seed): Promise<string> {
    n += 1;
    const start = new Date(Date.UTC(2049, 0, 1 + n, 19));
    const input: HoldInput = {
      venueId: seed.venue, actor: "key:desk", traceId: `seat-h${n}`, idempotencyKey: `seat-k${n}`,
      partySize: 2, startsAt: start.toISOString(), durationMinutes: 90, assignment: { kind: "unit", id: seed.units[0]! },
    };
    const out = await hold(app, input);
    if (!out.ok) throw new Error(out.error.code);
    return out.receipt.reservationId;
  }

  /**
   * A reservation of `seed` whose stored status is `status`. The expired one is a hold made on a clock an hour in
   * the past, so it is already due, and the sweeper stores the expiry; no live hold is due, so the sweep reaches
   * no other reservation.
   */
  async function reservationIn(status: Status, seed: Seed = A): Promise<string> {
    if (status === "expired") {
      await setClock(app, new Date(Date.now() - 3_600_000).toISOString());
      const id = await place(seed).finally(() => setClock(app, null));
      const swept = await expireDue(worker, { limit: 100 });
      if (!swept.expired.includes(id)) throw new Error("the sweeper did not expire the hold");
      return id;
    }
    const id = await place(seed);
    if (status === "held") return id;
    if (status === "cancelled") {
      await cancel(app, { reservationId: id, ...ctx(seed), reason: "guest" });
      return id;
    }
    await confirm(app, { reservationId: id, ...ctx(seed) });
    if (status === "confirmed") return id;
    await seat(app, { reservationId: id, ...ctx(seed) });
    if (status === "seated") return id;
    await complete(app, { reservationId: id, ...ctx(seed) });
    return id;
  }

  /** Everything a command could change about one reservation, read as the owner. */
  async function snapshot(id: string) {
    const r = (await owner.query("select status, version, cancel_reason from dastar.reservation where id = $1", [id])).rows[0];
    const audit = (await owner.query("select count(*)::int as c from dastar.audit_log where entity_id = $1", [id])).rows[0].c as number;
    const outbox = (await owner.query("select count(*)::int as c from dastar.outbox where payload->>'reservation_id' = $1", [id])).rows[0].c as number;
    const units = (await owner.query("select unit_id, active from dastar.reservation_unit where reservation_id = $1 order by unit_id", [id])).rows;
    return { status: r.status as string, version: r.version as number, cancelReason: r.cancel_reason as string | null, audit, outbox, units };
  }
  const topics = async (id: string): Promise<string[]> =>
    (await owner.query("select topic from dastar.outbox where payload->>'reservation_id' = $1 order by id", [id])).rows.map((r) => r.topic as string);
  const auditActions = async (id: string): Promise<string[]> =>
    (await owner.query("select action from dastar.audit_log where entity_id = $1 order by id", [id])).rows.map((r) => r.action as string);

  /** The error a settled command failed with; a command that succeeded fails the test. */
  function failure(o: Outcome<unknown>): unknown {
    if (o.ok) throw new Error("the command succeeded; it was expected to fail");
    return o.error;
  }
  /** The receipt of a settled command; a command that failed rethrows its error. */
  function receipt(o: Outcome<Receipt>): Receipt {
    if (!o.ok) throw o.error instanceof Error ? o.error : new Error(String(o.error));
    return o.value;
  }

  /**
   * Two commands race for one reservation row. `first` runs on connection A and stops right after it has locked the row;
   * `second` starts only once A is there, on connection B, and A is released only when B's backend is observed waiting on a
   * lock. The order is observed, never assumed: B queued behind A's row lock and read the row after A committed.
   */
  async function raceForRow<T, U>(first: (hooks: StatusHooks) => Promise<T>, second: () => Promise<U>): Promise<{ first: Outcome<T>; second: Outcome<U> }> {
    const p = pause();
    const a = outcome(first({ afterLock: p.hook }));
    try {
      await p.reached;
      const b = outcome(second());
      await waitForBackend(owner, LOCK_B, { type: "Lock" });
      p.release();
      return { first: await a, second: await b };
    } finally {
      p.release();
    }
  }

  it("confirmed, then seated, then completed: versions increment, events and audit rows follow, unit rows stay active", async () => {
    const id = await reservationIn("confirmed");
    expect((await snapshot(id)).version).toBe(2);

    const seatCtx = ctx();
    const seated = await seat(app, { reservationId: id, ...seatCtx });
    expect(seated).toEqual({ reservationId: id, status: "seated", version: 3, auditId: expect.any(Number), traceId: seatCtx.traceId });
    const completeCtx = ctx();
    const completed = await complete(app, { reservationId: id, ...completeCtx });
    expect(completed).toEqual({ reservationId: id, status: "completed", version: 4, auditId: expect.any(Number), traceId: completeCtx.traceId });
    expect(completed.auditId).toBeGreaterThan(seated.auditId);

    const ob = await owner.query("select topic, payload from dastar.outbox where payload->>'reservation_id' = $1 order by id", [id]);
    expect(ob.rows.map((r) => r.topic)).toEqual(["reservation.held", "reservation.confirmed", "reservation.seated", "reservation.completed"]);
    expect(ob.rows[2].payload).toMatchObject({ reservation_id: id, venue_id: A.venue, status: "seated", version: 3, party_size: 2, assignment: { kind: "unit", id: A.units[0] } });
    expect(ob.rows[3].payload).toMatchObject({ reservation_id: id, venue_id: A.venue, status: "completed", version: 4 });

    const audit = await owner.query("select id, action, actor, trace_id from dastar.audit_log where entity_id = $1 order by id", [id]);
    expect(audit.rows.map((r) => r.action)).toEqual(["insert", "update:held>confirmed", "update:confirmed>seated", "update:seated>completed"]);
    expect(audit.rows[2]).toMatchObject({ id: String(seated.auditId), actor: "key:desk", trace_id: seatCtx.traceId });
    expect(audit.rows[3]).toMatchObject({ id: String(completed.auditId), actor: "key:desk", trace_id: completeCtx.traceId });

    const rows = await owner.query("select unit_id, active from dastar.reservation_unit where reservation_id = $1", [id]);
    expect(rows.rows).toEqual([{ unit_id: A.units[0], active: true }]);
    const stored = await snapshot(id);
    expect(stored).toMatchObject({ status: "completed", version: 4, cancelReason: null });
  });

  for (const from of ["held", "seated", "completed", "cancelled", "expired"] as const) {
    it(`seat from ${from} answers invalid_transition and changes nothing`, async () => {
      const id = await reservationIn(from);
      const before = await snapshot(id);
      expect(before.status).toBe(from);
      await expect(seat(app, { reservationId: id, ...ctx() })).rejects.toMatchObject({ code: "invalid_transition", message: `cannot seat ${from === "expired" ? "an" : "a"} ${from} reservation` });
      expect(await snapshot(id)).toEqual(before);
    });
  }

  for (const from of ["held", "confirmed", "completed", "cancelled", "expired"] as const) {
    it(`complete from ${from} answers invalid_transition and changes nothing`, async () => {
      const id = await reservationIn(from);
      const before = await snapshot(id);
      expect(before.status).toBe(from);
      await expect(complete(app, { reservationId: id, ...ctx() })).rejects.toMatchObject({ code: "invalid_transition", message: `cannot complete ${from === "expired" ? "an" : "a"} ${from} reservation` });
      expect(await snapshot(id)).toEqual(before);
    });
  }

  it("expected_version: a mismatch answers version_conflict and changes nothing, the matching version succeeds", async () => {
    const id = await reservationIn("confirmed");
    const before = await snapshot(id);
    expect(before.version).toBe(2);
    await expect(seat(app, { reservationId: id, ...ctx(), expectedVersion: 1 })).rejects.toMatchObject({ code: "version_conflict" });
    await expect(seat(app, { reservationId: id, ...ctx(), expectedVersion: 7 })).rejects.toMatchObject({ code: "version_conflict" });
    expect(await snapshot(id)).toEqual(before);

    expect(await seat(app, { reservationId: id, ...ctx(), expectedVersion: 2 })).toMatchObject({ status: "seated", version: 3 });
    const seated = await snapshot(id);
    // the version seat left is the only one complete accepts
    await expect(complete(app, { reservationId: id, ...ctx(), expectedVersion: 2 })).rejects.toMatchObject({ code: "version_conflict" });
    expect(await snapshot(id)).toEqual(seated);
    expect(await complete(app, { reservationId: id, ...ctx(), expectedVersion: 3 })).toMatchObject({ status: "completed", version: 4 });
  });

  it("another venue's id answers not_found and changes nothing; the right venue finds it", async () => {
    const confirmedInB = await reservationIn("confirmed", B);
    const seatedInB = await reservationIn("seated", B);
    const beforeConfirmed = await snapshot(confirmedInB);
    const beforeSeated = await snapshot(seatedInB);

    await expect(seat(app, { reservationId: confirmedInB, ...ctx(A) })).rejects.toMatchObject({ code: "not_found", message: "reservation not found" });
    await expect(complete(app, { reservationId: seatedInB, ...ctx(A) })).rejects.toMatchObject({ code: "not_found", message: "reservation not found" });
    await expect(seat(app, { reservationId: ABSENT, ...ctx(A) })).rejects.toMatchObject({ code: "not_found" });
    await expect(complete(app, { reservationId: ABSENT, ...ctx(A) })).rejects.toMatchObject({ code: "not_found" });
    expect(await snapshot(confirmedInB)).toEqual(beforeConfirmed);
    expect(await snapshot(seatedInB)).toEqual(beforeSeated);

    expect(await seat(app, { reservationId: confirmedInB, ...ctx(B) })).toMatchObject({ status: "seated", version: 3 });
    expect(await complete(app, { reservationId: seatedInB, ...ctx(B) })).toMatchObject({ status: "completed", version: 4 });
  });

  it("cancel from seated still works after seat, stores the reason, and frees the units", async () => {
    const id = await reservationIn("confirmed");
    await seat(app, { reservationId: id, ...ctx() });
    const r = await cancel(app, { reservationId: id, ...ctx(), reason: "guest left" });
    expect(r).toMatchObject({ reservationId: id, status: "cancelled", version: 4 });
    expect(await snapshot(id)).toMatchObject({ status: "cancelled", version: 4, cancelReason: "guest left" });
    const rows = await owner.query("select active from dastar.reservation_unit where reservation_id = $1", [id]);
    expect(rows.rows).toEqual([{ active: false }]);
    const audit = await owner.query("select action from dastar.audit_log where entity_id = $1 order by id", [id]);
    expect(audit.rows.map((x) => x.action)).toEqual(["insert", "update:held>confirmed", "update:confirmed>seated", "update:seated>cancelled"]);
    await expect(complete(app, { reservationId: id, ...ctx() })).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("expected_version is checked before the status: a wrong version on a held reservation is version_conflict, the right one invalid_transition", async () => {
    const id = await reservationIn("held");
    const before = await snapshot(id);
    expect(before.version).toBe(1);
    await expect(seat(app, { reservationId: id, ...ctx(), expectedVersion: 7 })).rejects.toMatchObject({ code: "version_conflict", message: "expected_version does not match" });
    await expect(seat(app, { reservationId: id, ...ctx(), expectedVersion: 1 })).rejects.toMatchObject({ code: "invalid_transition", message: "cannot seat a held reservation" });
    expect(await snapshot(id)).toEqual(before);
  });

  it("seat vs seat: the second waits on the row lock, then finds the reservation seated; one event, one audit row, one version step", async () => {
    const id = await reservationIn("confirmed");
    const before = await snapshot(id);
    expect(before).toMatchObject({ status: "confirmed", version: 2 });

    const r = await raceForRow(
      (hooks) => seat(lockA, { reservationId: id, ...ctx() }, hooks),
      () => seat(lockB, { reservationId: id, ...ctx() }),
    );
    expect(receipt(r.first)).toMatchObject({ reservationId: id, status: "seated", version: 3 });
    expect(failure(r.second)).toMatchObject({ code: "invalid_transition", message: "cannot seat a seated reservation" });

    expect(await snapshot(id)).toMatchObject({ status: "seated", version: before.version + 1, audit: before.audit + 1, outbox: before.outbox + 1 });
    expect(await topics(id)).toEqual(["reservation.held", "reservation.confirmed", "reservation.seated"]);
    expect(await auditActions(id)).toEqual(["insert", "update:held>confirmed", "update:confirmed>seated"]);
  });

  it("seat vs cancel, cancel first: cancel wins, and seat finds the reservation cancelled", async () => {
    const id = await reservationIn("confirmed");
    const r = await raceForRow(
      (hooks) => cancel(lockA, { reservationId: id, ...ctx(), reason: "guest" }, hooks),
      () => seat(lockB, { reservationId: id, ...ctx() }),
    );
    expect(receipt(r.first)).toMatchObject({ reservationId: id, status: "cancelled", version: 3 });
    expect(failure(r.second)).toMatchObject({ code: "invalid_transition", message: "cannot seat a cancelled reservation" });

    expect(await snapshot(id)).toMatchObject({ status: "cancelled", version: 3, cancelReason: "guest", units: [{ unit_id: A.units[0], active: false }] });
    expect(await topics(id)).toEqual(["reservation.held", "reservation.confirmed", "reservation.cancelled"]);
    expect(await auditActions(id)).toEqual(["insert", "update:held>confirmed", "update:confirmed>cancelled"]);
  });

  it("seat vs cancel, seat first: seat wins, and cancel, which a seated reservation allows, acts on the seated row", async () => {
    const id = await reservationIn("confirmed");
    const r = await raceForRow(
      (hooks) => seat(lockA, { reservationId: id, ...ctx() }, hooks),
      () => cancel(lockB, { reservationId: id, ...ctx(), reason: "guest left" }),
    );
    expect(receipt(r.first)).toMatchObject({ reservationId: id, status: "seated", version: 3 });
    // cancel waited, then read what seat committed: it cancelled from seated at version 3, not from confirmed at version 2
    expect(receipt(r.second)).toMatchObject({ reservationId: id, status: "cancelled", version: 4 });

    expect(await snapshot(id)).toMatchObject({ status: "cancelled", version: 4, cancelReason: "guest left", units: [{ unit_id: A.units[0], active: false }] });
    expect(await topics(id)).toEqual(["reservation.held", "reservation.confirmed", "reservation.seated", "reservation.cancelled"]);
    expect(await auditActions(id)).toEqual(["insert", "update:held>confirmed", "update:confirmed>seated", "update:seated>cancelled"]);
  });

  it("complete vs cancel on a seated reservation, complete first: complete wins, and cancel finds the reservation completed", async () => {
    const id = await reservationIn("seated");
    const before = await snapshot(id);
    expect(before).toMatchObject({ status: "seated", version: 3 });

    const r = await raceForRow(
      (hooks) => complete(lockA, { reservationId: id, ...ctx() }, hooks),
      () => cancel(lockB, { reservationId: id, ...ctx(), reason: "guest" }),
    );
    expect(receipt(r.first)).toMatchObject({ reservationId: id, status: "completed", version: 4 });
    expect(failure(r.second)).toMatchObject({ code: "invalid_transition", message: "cannot cancel a completed reservation" });

    expect(await snapshot(id)).toMatchObject({ status: "completed", version: 4, cancelReason: null, audit: before.audit + 1, outbox: before.outbox + 1, units: [{ unit_id: A.units[0], active: true }] });
    expect(await topics(id)).toEqual(["reservation.held", "reservation.confirmed", "reservation.seated", "reservation.completed"]);
    expect(await auditActions(id)).toEqual(["insert", "update:held>confirmed", "update:confirmed>seated", "update:seated>completed"]);
  });

  it("the handle runs seat and complete as commands of their own, traced by the caller's trace id", async () => {
    const id = await reservationIn("confirmed");
    const pool = new Pool({ connectionString: conn.app, max: 2 });
    pool.on("error", () => undefined);
    const seen: { command: string; traceId: string | null }[] = [];
    const d = createDastar({ pool, onAcquire: (i) => { seen.push({ command: i.command, traceId: i.traceId }); } });
    try {
      const seatCtx = ctx();
      const completeCtx = ctx();
      expect(await d.seat({ reservationId: id, ...seatCtx })).toMatchObject({ status: "seated", version: 3, traceId: seatCtx.traceId });
      expect(await d.complete({ reservationId: id, ...completeCtx })).toMatchObject({ status: "completed", version: 4, traceId: completeCtx.traceId });
      await expect(d.seat({ reservationId: id, ...ctx() })).rejects.toMatchObject({ code: "invalid_transition" });
      expect(seen.slice(0, 2)).toEqual([{ command: "seat", traceId: seatCtx.traceId }, { command: "complete", traceId: completeCtx.traceId }]);
      expect(seen[2]).toMatchObject({ command: "seat" });
    } finally {
      await d.close();
      await pool.end();
    }
  });
});

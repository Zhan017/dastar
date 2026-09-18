import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { createHash } from "node:crypto";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { setClock } from "./helpers/clock.js";
import { seedVenue, type Seed } from "./helpers/seed.js";
import { hold, type HoldInput } from "../src/commands/hold.js";
import { confirm } from "../src/commands/confirm.js";
import { cancel } from "../src/commands/cancel.js";
import { expireDue } from "../src/commands/expire.js";
import { mintConfirmToken } from "../src/commands/mint-token.js";
import { getReservation } from "../src/commands/get.js";

describe("lifecycle", () => {
  let conn: Conn; let owner: Client; let app: Client; let worker: Client; let seed: Seed; let n = 0;
  beforeAll(async () => {
    conn = await cloneDatabase("lifecycle_test");
    owner = await connect(conn.owner); app = await connect(conn.app); worker = await connect(conn.worker);
    await owner.query("select set_config('dastar.actor', 'owner', false), set_config('dastar.trace_id', 'owner', false)");
    seed = await seedVenue(owner);
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100 where id = $1", [seed.venue]);
  });
  afterAll(async () => { await app.end(); await worker.end(); await owner.end(); await dropDatabase("lifecycle_test"); });

  const ctx = () => ({ actor: "key:life", traceId: `t${++n}`, venueId: seed.venue });
  function input(over: Partial<HoldInput> = {}): HoldInput {
    n += 1;
    const start = new Date(Date.UTC(2037, 0, 1 + Math.floor(n / 8), 8 + (n % 8)));
    return { venueId: seed.venue, actor: "key:life", traceId: `t${n}`, idempotencyKey: `k${n}`, partySize: 2, startsAt: start.toISOString(), durationMinutes: 60, assignment: { kind: "unit", id: seed.units[0]! }, ...over };
  }
  async function heldId(over: Partial<HoldInput> = {}): Promise<string> {
    const out = await hold(app, input(over));
    if (!out.ok) throw new Error(out.error.code);
    return out.receipt.reservationId;
  }

  it("confirm with a confirm-capable actor; version and outbox advance", async () => {
    const id = await heldId();
    const r = await confirm(app, { reservationId: id, ...ctx() });
    expect(r.status).toBe("confirmed");
    expect(r.version).toBe(2);
    const ob = await app.query("select count(*)::int as c from dastar.outbox where topic = 'reservation.confirmed' and payload->>'reservation_id' = $1", [id]);
    expect(ob.rows[0].c).toBe(1);
  });

  it("confirm respects expected_version", async () => {
    const id = await heldId();
    await expect(confirm(app, { reservationId: id, ...ctx(), expectedVersion: 7 })).rejects.toMatchObject({ code: "version_conflict" });
    await confirm(app, { reservationId: id, ...ctx(), expectedVersion: 1 });
  });

  it("confirm after expiry fails with hold_expired; after cancel with invalid_transition", async () => {
    const id = await heldId();
    await setClock(app, "2040-01-01T00:00:00Z");
    await expect(confirm(app, { reservationId: id, ...ctx() })).rejects.toMatchObject({ code: "hold_expired" });
    await setClock(app, null);
    const id2 = await heldId();
    await cancel(app, { reservationId: id2, ...ctx(), reason: "guest" });
    await expect(confirm(app, { reservationId: id2, ...ctx() })).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("a second confirm is invalid_transition, keeps the version, and emits no second event", async () => {
    const id = await heldId();
    const r = await confirm(app, { reservationId: id, ...ctx() });
    expect(r.version).toBe(2);
    await expect(confirm(app, { reservationId: id, ...ctx() })).rejects.toMatchObject({ code: "invalid_transition" });
    const row = await owner.query("select version from dastar.reservation where id = $1", [id]);
    expect(row.rows[0].version).toBe(2);
    const ob = await app.query("select count(*)::int as c from dastar.outbox where topic = 'reservation.confirmed' and payload->>'reservation_id' = $1", [id]);
    expect(ob.rows[0].c).toBe(1);
    await cancel(app, { reservationId: id, ...ctx(), reason: "guest" });
    await expect(cancel(app, { reservationId: id, ...ctx(), reason: "guest" })).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("mint, consume by confirm, and a stale token afterwards is rejected", async () => {
    const id = await heldId();
    const m = await mintConfirmToken(app, { reservationId: id, ...ctx() });
    expect(m.version).toBe(2);
    const stored = (await owner.query("select confirm_token_hash from dastar.reservation where id = $1", [id])).rows[0].confirm_token_hash as Buffer;
    expect(stored.equals(createHash("sha256").update(m.token).digest())).toBe(true);
    await expect(confirm(app, { reservationId: id, actor: "token", traceId: "x", venueId: seed.venue, confirmToken: "not-the-token" })).rejects.toMatchObject({ code: "forbidden" });
    const r = await confirm(app, { reservationId: id, actor: "token", traceId: "x", venueId: seed.venue, confirmToken: m.token, expectedVersion: m.version });
    expect(r.status).toBe("confirmed");
    expect((await owner.query("select confirm_token_hash from dastar.reservation where id = $1", [id])).rows[0].confirm_token_hash).toBeNull();
    const audit = await owner.query("select actor from dastar.audit_log where entity_id = $1 order by id desc limit 1", [id]);
    expect(audit.rows[0].actor).toBe(`token:${id}`);
  });

  it("a token is judged before the reservation is described: used, cleared, and wrong tokens are all just wrong", async () => {
    const used = await heldId();
    const m = await mintConfirmToken(app, { reservationId: used, ...ctx() });
    await confirm(app, { reservationId: used, actor: "token", traceId: "x", venueId: seed.venue, confirmToken: m.token });
    await expect(confirm(app, { reservationId: used, actor: "token", traceId: "x", venueId: seed.venue, confirmToken: m.token })).rejects.toMatchObject({ code: "forbidden" });
    await expect(confirm(app, { reservationId: used, actor: "token", traceId: "x", venueId: seed.venue, confirmToken: "guess" })).rejects.toMatchObject({ code: "forbidden" });

    const cancelled = await heldId();
    const m2 = await mintConfirmToken(app, { reservationId: cancelled, ...ctx() });
    await cancel(app, { reservationId: cancelled, ...ctx(), reason: "guest" });
    await expect(confirm(app, { reservationId: cancelled, actor: "token", traceId: "x", venueId: seed.venue, confirmToken: m2.token })).rejects.toMatchObject({ code: "forbidden" });

    const held = await heldId();
    await mintConfirmToken(app, { reservationId: held, ...ctx() });
    await expect(confirm(app, { reservationId: held, actor: "token", traceId: "x", venueId: seed.venue, confirmToken: "guess", expectedVersion: 99 })).rejects.toMatchObject({ code: "forbidden" });
    // a key caller, who is authenticated by the host, still gets the state-specific answers
    await expect(confirm(app, { reservationId: used, ...ctx() })).rejects.toMatchObject({ code: "invalid_transition" });
    await expect(confirm(app, { reservationId: held, ...ctx(), expectedVersion: 99 })).rejects.toMatchObject({ code: "version_conflict" });
  });

  it("an empty-string confirm token is not treated as absent; it is checked and rejected", async () => {
    const id = await heldId();
    await mintConfirmToken(app, { reservationId: id, ...ctx() });
    await expect(confirm(app, { reservationId: id, actor: "token", traceId: "x", venueId: seed.venue, confirmToken: "" })).rejects.toMatchObject({ code: "forbidden" });
    const row = await owner.query("select status from dastar.reservation where id = $1", [id]);
    expect(row.rows[0].status).toBe("held");
  });

  it("minting twice replaces the token; cancel clears it", async () => {
    const id = await heldId();
    const m1 = await mintConfirmToken(app, { reservationId: id, ...ctx() });
    const m2 = await mintConfirmToken(app, { reservationId: id, ...ctx() });
    expect(m2.token).not.toBe(m1.token);
    await expect(confirm(app, { reservationId: id, actor: "token", traceId: "x", venueId: seed.venue, confirmToken: m1.token })).rejects.toMatchObject({ code: "forbidden" });
    await cancel(app, { reservationId: id, ...ctx(), reason: "guest" });
    expect((await owner.query("select confirm_token_hash from dastar.reservation where id = $1", [id])).rows[0].confirm_token_hash).toBeNull();
  });

  it("mint on a confirmed or expired reservation is refused", async () => {
    const id = await heldId();
    await confirm(app, { reservationId: id, ...ctx() });
    await expect(mintConfirmToken(app, { reservationId: id, ...ctx() })).rejects.toMatchObject({ code: "token_requires_held" });
    const id2 = await heldId();
    await setClock(app, "2040-01-01T00:00:00Z");
    await expect(mintConfirmToken(app, { reservationId: id2, ...ctx() })).rejects.toMatchObject({ code: "token_requires_held" });
    await setClock(app, null);
  });

  it("cancel flips unit rows inactive and frees the slot", async () => {
    const i = input({ assignment: { kind: "unit", id: seed.units[1]! } });
    const id = await heldId(i);
    await cancel(app, { reservationId: id, ...ctx(), reason: "guest" });
    const rows = await owner.query("select active from dastar.reservation_unit where reservation_id = $1", [id]);
    expect(rows.rows).toEqual([{ active: false }]);
    const again = await hold(app, input({ startsAt: i.startsAt, assignment: { kind: "unit", id: seed.units[1]! } }));
    expect(again.ok).toBe(true);
  });

  it("the sweeper expires due holds in small batches with skip-locked, and only due ones", async () => {
    const ids = [await heldId({ assignment: { kind: "unit", id: seed.units[2]! } }), await heldId({ assignment: { kind: "unit", id: seed.units[3]! } })];
    const fresh = await heldId({ assignment: { kind: "unit", id: seed.units[4]! } });
    await setClock(worker, "2040-01-01T00:00:00Z");
    await owner.query("update dastar.reservation set hold_expires_at = '2050-01-01T00:00:00Z' where id = $1", [fresh]);
    const r = await expireDue(worker, { limit: 20 });
    await setClock(worker, null);
    for (const id of ids) expect(r.expired).toContain(id);
    expect(r.expired).not.toContain(fresh);
    const st = await owner.query("select id, status from dastar.reservation where id = any($1::uuid[])", [ids]);
    expect(st.rows.every((x) => x.status === "expired")).toBe(true);
    const audit = await owner.query("select actor from dastar.audit_log where entity_id = $1 order by id desc limit 1", [ids[0]]);
    expect(audit.rows[0].actor).toBe("system:sweeper");
  });

  it("get returns effective status by database time and stored status separately", async () => {
    const id = await heldId();
    const before = await getReservation(app, id);
    expect(before).toMatchObject({ status: "held", storedStatus: "held", version: 1 });
    await setClock(app, "2040-01-01T00:00:00Z");
    const after = await getReservation(app, id);
    expect(after).toMatchObject({ status: "expired", storedStatus: "held" });
    await setClock(app, null);
    expect(await getReservation(app, "00000000-0000-7000-8000-000000000000")).toBeNull();
    expect(before!.history.map((h) => h.action)).toEqual(["insert"]);
  });

  it("a malformed reservation id rejects with a DastarError, code internal", async () => {
    await expect(confirm(app, { reservationId: "not-a-uuid", ...ctx() })).rejects.toMatchObject({ name: "DastarError", code: "internal" });
    await app.query("select 1");
  });
});

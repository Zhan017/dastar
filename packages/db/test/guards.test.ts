import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { setClock } from "./helpers/clock.js";
import { seedVenue, type Seed } from "./helpers/seed.js";

describe("guards", () => {
  let conn: Conn; let owner: Client; let app: Client; let seed: Seed;
  let slot = 0;

  beforeAll(async () => {
    conn = await cloneDatabase("guards_test");
    owner = await connect(conn.owner);
    app = await connect(conn.app);
    await app.query("select set_config('dastar.actor', 'test', false), set_config('dastar.trace_id', 't1', false)");
    seed = await seedVenue(owner);
  });
  afterAll(async () => { await app.end(); await owner.end(); await dropDatabase("guards_test"); });

  function nextDuring(): string {
    slot += 1;
    const start = new Date(Date.UTC(2032, 0, 1 + Math.floor(slot / 10), 10 + (slot % 10)));
    return `[${start.toISOString()},${new Date(start.getTime() + 3_600_000).toISOString()})`;
  }

  async function insertReservation(c: Client, kind: "unit" | "combo", assignment: string, party: number, during = nextDuring()) {
    return (await c.query(
      `insert into dastar.reservation(venue_id, party_size, during, status, assignment_kind, assignment_id, hold_expires_at, created_by)
       values ($1, $2, $3::tstzrange, 'held', $4, $5, dastar.dastar_now() + interval '10 minutes', 'test') returning id, during`,
      [seed.venue, party, during, kind, assignment])).rows[0] as { id: string; during: string };
  }
  async function insertRows(c: Client, id: string, during: string, units: string[]) {
    for (const u of [...units].sort()) {
      await c.query("insert into dastar.reservation_unit(venue_id, reservation_id, unit_id, during) values ($1,$2,$3,$4::tstzrange)", [seed.venue, id, u, during]);
    }
  }
  async function held(units: string[] = [seed.units[0]!], kind: "unit" | "combo" = "unit", assignment = seed.units[0]!, party = 2) {
    await app.query("begin");
    const r = await insertReservation(app, kind, assignment, party);
    await insertRows(app, r.id, r.during, units);
    await app.query("commit");
    return r;
  }

  it("DA007: a write without an actor is refused", async () => {
    const bare = await connect(conn.owner);
    await expect(insertReservation(bare, "unit", seed.units[0]!, 2)).rejects.toMatchObject({ code: "DA007" });
    await bare.end();
  });

  it("DA003: party must fit the unit or combo", async () => {
    await expect(insertReservation(app, "unit", seed.units[0]!, 9)).rejects.toMatchObject({ code: "DA003" });
    await expect(insertReservation(app, "combo", seed.combos[0]!.id, 3)).rejects.toMatchObject({ code: "DA003" });
    await expect(insertReservation(app, "unit", "00000000-0000-7000-8000-000000000000", 2)).rejects.toMatchObject({ code: "DA003" });
  });

  it("DA001: an expired hold cannot be confirmed", async () => {
    const r = await held();
    await setClock(app, "2040-01-01T00:00:00Z");
    await expect(app.query("update dastar.reservation set status = 'confirmed' where id = $1", [r.id])).rejects.toMatchObject({ code: "DA001" });
    await setClock(app, null);
    await app.query("update dastar.reservation set status = 'confirmed' where id = $1", [r.id]);
  });

  it("DA008: unit rows must match the reservation range, be active, and belong to a held reservation", async () => {
    await app.query("begin");
    const r = await insertReservation(app, "unit", seed.units[1]!, 2);
    await expect(app.query("insert into dastar.reservation_unit(venue_id, reservation_id, unit_id, during) values ($1,$2,$3,'[2033-01-01 10:00+00, 2033-01-01 11:00+00)')",
      [seed.venue, r.id, seed.units[1]])).rejects.toMatchObject({ code: "DA008" });
    await app.query("rollback");
    await app.query("begin");
    const r2 = await insertReservation(app, "unit", seed.units[1]!, 2);
    await expect(app.query("insert into dastar.reservation_unit(venue_id, reservation_id, unit_id, during, active) values ($1,$2,$3,$4::tstzrange,false)",
      [seed.venue, r2.id, seed.units[1], r2.during])).rejects.toMatchObject({ code: "DA008" });
    await app.query("rollback");
  });

  it("DA010: unit rows must equal the assignment's members at commit", async () => {
    const combo = seed.combos[0]!;
    await app.query("begin");
    const r = await insertReservation(app, "combo", combo.id, 6);
    await insertRows(app, r.id, r.during, [combo.units[0]!]);
    await expect(app.query("commit")).rejects.toMatchObject({ code: "DA010" });

    await app.query("begin");
    const r2 = await insertReservation(app, "combo", combo.id, 6);
    await insertRows(app, r2.id, r2.during, [...combo.units, seed.units[4]!]);
    await expect(app.query("commit")).rejects.toMatchObject({ code: "DA010" });

    await app.query("begin");
    const r3 = await insertReservation(app, "unit", seed.units[2]!, 2);
    await insertRows(app, r3.id, r3.during, [seed.units[3]!]);
    await expect(app.query("commit")).rejects.toMatchObject({ code: "DA010" });

    const ok = await held(combo.units, "combo", combo.id, 6);
    expect(ok.id).toBeTruthy();
  });

  it("DA010: rows remain and become inactive after cancel", async () => {
    const combo = seed.combos[1]!;
    const r = await held(combo.units, "combo", combo.id, 6);
    await app.query("update dastar.reservation set status = 'cancelled', cancel_reason = 'x' where id = $1", [r.id]);
    const rows = await app.query("select active from dastar.reservation_unit where reservation_id = $1 order by unit_id", [r.id]);
    expect(rows.rows.map((x) => x.active)).toEqual([false, false]);
  });

  it("DA011: combo members and capacities are immutable", async () => {
    const combo = seed.combos[2]!;
    await expect(owner.query("update dastar.unit_combo set unit_ids = array[$2::uuid, $3::uuid] where id = $1", [combo.id, seed.units[4], seed.units[5]])).rejects.toMatchObject({ code: "DA011" });
    await expect(owner.query("update dastar.unit_combo set capacity_max = 9 where id = $1", [combo.id])).rejects.toMatchObject({ code: "DA011" });
    await owner.query("update dastar.unit_combo set label = 'renamed', active = false where id = $1", [combo.id]);
  });

  it("DA012: capacity cannot shrink below a live party; history does not count", async () => {
    const u = seed.units[3]!;
    const r = await held([u], "unit", u, 4);
    await expect(app.query("update dastar.unit set capacity_max = 2 where id = $1", [u])).rejects.toMatchObject({ code: "DA012" });
    await app.query("update dastar.reservation set status = 'cancelled', cancel_reason = 'x' where id = $1", [r.id]);
    await app.query("update dastar.unit set capacity_max = 2 where id = $1", [u]);
    await app.query("update dastar.unit set capacity_max = 4 where id = $1", [u]);
  });

  it("DA012: an expired-but-unswept hold does not block a capacity edit", async () => {
    const u = seed.units[2]!;
    await held([u], "unit", u, 4);
    await setClock(app, "2040-01-01T00:00:00Z");
    await app.query("update dastar.unit set capacity_max = 2 where id = $1", [u]);
    await setClock(app, null);
    await app.query("update dastar.unit set capacity_max = 4 where id = $1", [u]);
  });

  it("DA013: a token can be set only on a held, unexpired reservation; clearing is always allowed", async () => {
    const r = await held();
    const v0 = (await app.query("select version from dastar.reservation where id = $1", [r.id])).rows[0].version;
    await app.query("update dastar.reservation set confirm_token_hash = decode('aa','hex') where id = $1", [r.id]);
    const v1 = (await app.query("select version from dastar.reservation where id = $1", [r.id])).rows[0].version;
    expect(v1).toBe(v0 + 1);
    await setClock(app, "2040-01-01T00:00:00Z");
    await expect(app.query("update dastar.reservation set confirm_token_hash = decode('bb','hex') where id = $1", [r.id])).rejects.toMatchObject({ code: "DA013" });
    await setClock(app, null);
    await app.query("update dastar.reservation set status = 'confirmed', confirm_token_hash = null where id = $1", [r.id]);
    await expect(app.query("update dastar.reservation set confirm_token_hash = decode('cc','hex') where id = $1", [r.id])).rejects.toMatchObject({ code: "DA013" });
    await app.query("update dastar.reservation set confirm_token_hash = null where id = $1", [r.id]);
  });

  it("token: leaving held clears the hash even when the statement does not", async () => {
    const r1 = await held();
    await app.query("update dastar.reservation set confirm_token_hash = decode('ee','hex') where id = $1", [r1.id]);
    await app.query("update dastar.reservation set status = 'cancelled', cancel_reason = 'x' where id = $1", [r1.id]);
    const after1 = (await app.query("select confirm_token_hash from dastar.reservation where id = $1", [r1.id])).rows[0].confirm_token_hash;
    expect(after1).toBeNull();

    const r2 = await held();
    await app.query("update dastar.reservation set confirm_token_hash = decode('ee','hex') where id = $1", [r2.id]);
    await app.query("update dastar.reservation set status = 'confirmed' where id = $1", [r2.id]);
    const after2 = (await app.query("select confirm_token_hash from dastar.reservation where id = $1", [r2.id])).rows[0].confirm_token_hash;
    expect(after2).toBeNull();
  });

  it("DA004: audit rows cannot be changed or truncated, even by the owner", async () => {
    await expect(owner.query("update dastar.audit_log set actor = 'x' where id = (select min(id) from dastar.audit_log)")).rejects.toMatchObject({ code: "DA004" });
    await expect(owner.query("delete from dastar.audit_log where id = (select min(id) from dastar.audit_log)")).rejects.toMatchObject({ code: "DA004" });
    await expect(owner.query("truncate dastar.audit_log")).rejects.toMatchObject({ code: "DA004" });
  });

  it("audit: every insert and update writes a row with actor and trace, hash redacted", async () => {
    const r = await held();
    await app.query("update dastar.reservation set confirm_token_hash = decode('dd','hex') where id = $1", [r.id]);
    await app.query("update dastar.reservation set status = 'confirmed', confirm_token_hash = null where id = $1", [r.id]);
    const rows = (await app.query("select action, actor, trace_id, before, after from dastar.audit_log where entity_id = $1 order by id", [r.id])).rows;
    expect(rows.map((x) => x.action)).toEqual(["insert", "update:metadata", "update:held>confirmed"]);
    expect(rows.every((x) => x.actor === "test" && x.trace_id === "t1")).toBe(true);
    expect(rows.every((x) => !("confirm_token_hash" in (x.after ?? {})) && !("confirm_token_hash" in (x.before ?? {})))).toBe(true);
  });

  it("version: managed by trigger; a supplied value is overridden", async () => {
    const r = await held();
    await owner.query("select set_config('dastar.actor', 'owner', false)");
    await owner.query("update dastar.reservation set version = 99, external_ref = 'x' where id = $1", [r.id]);
    const v = (await owner.query("select version from dastar.reservation where id = $1", [r.id])).rows[0].version;
    expect(v).toBe(2);
  });

  it("config_version bumps on unit changes, not on reservations", async () => {
    const before = (await app.query("select config_version from dastar.venue where id = $1", [seed.venue])).rows[0].config_version;
    await held();
    const mid = (await app.query("select config_version from dastar.venue where id = $1", [seed.venue])).rows[0].config_version;
    expect(mid).toBe(before);
    await app.query("update dastar.unit set label = 'T1b' where id = $1", [seed.units[0]]);
    const after = (await app.query("select config_version from dastar.venue where id = $1", [seed.venue])).rows[0].config_version;
    expect(Number(after)).toBe(Number(before) + 1);
  });
});

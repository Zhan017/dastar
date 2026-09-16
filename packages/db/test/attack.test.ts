import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { setClock } from "./helpers/clock.js";
import { seedVenue, type Seed } from "./helpers/seed.js";

describe("attack suite as dastar_app (boundary A)", () => {
  let conn: Conn; let owner: Client; let app: Client; let seed: Seed; let otherVenue: string; let otherUnit: string;
  let slot = 0;

  beforeAll(async () => {
    conn = await cloneDatabase("attack_test");
    owner = await connect(conn.owner);
    app = await connect(conn.app);
    await app.query("select set_config('dastar.actor', 'attacker', false), set_config('dastar.trace_id', 'a', false)");
    seed = await seedVenue(owner);
    otherVenue = (await owner.query("insert into dastar.venue(name, timezone) values ('Other','UTC') returning id")).rows[0].id;
    otherUnit = (await owner.query("insert into dastar.unit(venue_id,label,capacity_min,capacity_max) values ($1,'O',1,4) returning id", [otherVenue])).rows[0].id;
  });
  afterAll(async () => { await app.end(); await owner.end(); await dropDatabase("attack_test"); });

  function nextDuring(): string {
    slot += 1;
    const start = new Date(Date.UTC(2033, 0, 1 + Math.floor(slot / 10), 10 + (slot % 10)));
    return `[${start.toISOString()},${new Date(start.getTime() + 3_600_000).toISOString()})`;
  }
  async function held(unit = seed.units[0]!, party = 2): Promise<{ id: string; during: string }> {
    const during = nextDuring();
    await app.query("begin");
    const id = (await app.query(
      `insert into dastar.reservation(venue_id, party_size, during, status, assignment_kind, assignment_id, hold_expires_at, created_by)
       values ($1, $2, $3::tstzrange, 'held', 'unit', $4, dastar.dastar_now() + interval '10 minutes', 'attacker') returning id`,
      [seed.venue, party, during, unit])).rows[0].id as string;
    await app.query("insert into dastar.reservation_unit(venue_id, reservation_id, unit_id, during) values ($1,$2,$3,$4::tstzrange)", [seed.venue, id, unit, during]);
    await app.query("commit");
    return { id, during };
  }
  async function rejects(sql: string, params: unknown[], code: string) {
    await app.query("begin");
    await expect(app.query(sql, params)).rejects.toMatchObject({ code });
    await app.query("rollback");
  }

  it("cannot overlap two active rows on one unit (23P01)", async () => {
    const a = await held(seed.units[1]!);
    await app.query("begin");
    const b = (await app.query(
      `insert into dastar.reservation(venue_id, party_size, during, status, assignment_kind, assignment_id, hold_expires_at, created_by)
       values ($1, 2, $2::tstzrange, 'held', 'unit', $3, dastar.dastar_now() + interval '10 minutes', 'attacker') returning id`,
      [seed.venue, a.during, seed.units[1]])).rows[0].id;
    await expect(app.query("insert into dastar.reservation_unit(venue_id, reservation_id, unit_id, during) values ($1,$2,$3,$4::tstzrange)",
      [seed.venue, b, seed.units[1], a.during])).rejects.toMatchObject({ code: "23P01" });
    await app.query("rollback");
  });

  it("cannot confirm an expired hold (DA001)", async () => {
    const r = await held();
    await setClock(app, "2040-01-01T00:00:00Z");
    await rejects("update dastar.reservation set status = 'confirmed' where id = $1", [r.id], "DA001");
    await setClock(app, null);
  });

  it("cannot extend a hold (42501 on hold_expires_at)", async () => {
    const r = await held();
    await rejects("update dastar.reservation set hold_expires_at = now() + interval '1 year' where id = $1", [r.id], "42501");
  });

  it("cannot change range, party, assignment, venue, or version (42501)", async () => {
    const r = await held();
    await rejects("update dastar.reservation set party_size = 1 where id = $1", [r.id], "42501");
    await rejects("update dastar.reservation set during = $2::tstzrange where id = $1", [r.id, nextDuring()], "42501");
    await rejects("update dastar.reservation set assignment_id = $2 where id = $1", [r.id, seed.units[2]], "42501");
    await rejects("update dastar.reservation set venue_id = $2 where id = $1", [r.id, otherVenue], "42501");
    await rejects("update dastar.reservation set version = 99 where id = $1", [r.id], "42501");
  });

  it("cannot take an illegal transition (DA005)", async () => {
    const r = await held();
    await app.query("update dastar.reservation set status = 'confirmed' where id = $1", [r.id]);
    await app.query("update dastar.reservation set status = 'seated' where id = $1", [r.id]);
    await app.query("update dastar.reservation set status = 'completed' where id = $1", [r.id]);
    await rejects("update dastar.reservation set status = 'held' where id = $1", [r.id], "DA005");
  });

  it("cannot seat a party larger than the unit (DA003)", async () => {
    await rejects(
      `insert into dastar.reservation(venue_id, party_size, during, status, assignment_kind, assignment_id, hold_expires_at, created_by)
       values ($1, 9, $2::tstzrange, 'held', 'unit', $3, dastar.dastar_now() + interval '10 minutes', 'attacker')`,
      [seed.venue, nextDuring(), seed.units[0]], "DA003");
  });

  it("cannot flip, delete, or forge a unit row (42501, DA010)", async () => {
    const r = await held(seed.units[2]!);
    await rejects("update dastar.reservation_unit set active = false where reservation_id = $1", [r.id], "42501");
    await app.query("select set_config('dastar.internal', 'on', false)");
    await rejects("update dastar.reservation_unit set active = false where reservation_id = $1", [r.id], "42501");
    await rejects("delete from dastar.reservation_unit where reservation_id = $1", [r.id], "42501");
    await app.query("begin");
    await app.query("insert into dastar.reservation_unit(venue_id, reservation_id, unit_id, during) values ($1,$2,$3,$4::tstzrange)", [seed.venue, r.id, seed.units[3], r.during]);
    await expect(app.query("commit")).rejects.toMatchObject({ code: "DA010" });
  });

  it("cannot attach a unit from another venue (23503)", async () => {
    await app.query("begin");
    const during = nextDuring();
    const id = (await app.query(
      `insert into dastar.reservation(venue_id, party_size, during, status, assignment_kind, assignment_id, hold_expires_at, created_by)
       values ($1, 2, $2::tstzrange, 'held', 'unit', $3, dastar.dastar_now() + interval '10 minutes', 'attacker') returning id`,
      [seed.venue, during, seed.units[0]])).rows[0].id;
    await expect(app.query("insert into dastar.reservation_unit(venue_id, reservation_id, unit_id, during) values ($1,$2,$3,$4::tstzrange)",
      [seed.venue, id, otherUnit, during])).rejects.toMatchObject({ code: "23503" });
    await app.query("rollback");
  });

  it("cannot touch the audit log at all (42501 for insert, update, delete, truncate)", async () => {
    await rejects("insert into dastar.audit_log(venue_id, entity, entity_id, action, actor) values ($1,'reservation',$2,'forged','attacker')", [seed.venue, seed.units[0]], "42501");
    await rejects("update dastar.audit_log set actor = 'x' where id = (select min(id) from dastar.audit_log)", [], "42501");
    await rejects("delete from dastar.audit_log", [], "42501");
    await rejects("truncate dastar.audit_log", [], "42501");
  });

  it("cannot edit combo members (42501) and cannot delete anything", async () => {
    const combo = seed.combos[0]!;
    await rejects("update dastar.unit_combo set unit_ids = array[$2::uuid,$3::uuid] where id = $1", [combo.id, seed.units[4], seed.units[5]], "42501");
    await rejects("delete from dastar.reservation where true", [], "42501");
    await rejects("delete from dastar.unit where true", [], "42501");
    await rejects("delete from dastar.idempotency where true", [], "42501");
  });

  it("cannot shrink capacity under a live party (DA012)", async () => {
    const u = seed.units[3]!;
    await held(u, 4);
    await rejects("update dastar.unit set capacity_max = 2 where id = $1", [u], "DA012");
  });

  it("cannot disable triggers, drop constraints, or replace functions (42501)", async () => {
    await rejects("alter table dastar.reservation disable trigger user", [], "42501");
    await rejects("alter table dastar.reservation_unit drop constraint reservation_unit_no_overlap", [], "42501");
    await rejects("create or replace function dastar.dastar_now() returns timestamptz language sql as $$ select now() $$", [], "42501");
  });

  it("cannot write without an actor (DA007)", async () => {
    const bare = await connect(conn.app);
    await expect(bare.query(
      `insert into dastar.reservation(venue_id, party_size, during, status, assignment_kind, assignment_id, hold_expires_at, created_by)
       values ($1, 2, $2::tstzrange, 'held', 'unit', $3, dastar.dastar_now() + interval '10 minutes', 'attacker')`,
      [seed.venue, nextDuring(), seed.units[0]])).rejects.toMatchObject({ code: "DA007" });
    await bare.end();
  });

  it("can do what it is meant to do: hold, confirm, cancel, set a token, write outbox and idempotency", async () => {
    const r = await held(seed.units[4]!);
    await app.query("update dastar.reservation set confirm_token_hash = decode('ab','hex') where id = $1", [r.id]);
    await app.query("update dastar.reservation set status = 'confirmed', confirm_token_hash = null where id = $1", [r.id]);
    await app.query("update dastar.reservation set status = 'cancelled', cancel_reason = 'test' where id = $1", [r.id]);
    await app.query("insert into dastar.outbox(venue_id, topic, payload) values ($1, 'reservation.cancelled', '{}'::jsonb)", [seed.venue]);
    await app.query("insert into dastar.idempotency(venue_id, actor, key, request_hash, purge_at) values ($1, 'attacker', 'k', decode('00','hex'), now() + interval '1 day')", [seed.venue]);
    await app.query("update dastar.idempotency set response = '{}'::jsonb where venue_id = $1 and actor = 'attacker' and key = 'k'", [seed.venue]);
  });

  it("cannot change a reservation's assignment, party, range, or venue (42501)", async () => {
    const r = await held();
    await rejects("update dastar.reservation set assignment_id = $2 where id = $1", [r.id, seed.units[1]], "42501");
    await rejects("update dastar.reservation set assignment_kind = 'combo' where id = $1", [r.id], "42501");
    await rejects("update dastar.reservation set party_size = 1 where id = $1", [r.id], "42501");
    await rejects("update dastar.reservation set during = $2::tstzrange where id = $1", [r.id, r.during], "42501");
    await rejects("update dastar.reservation set venue_id = $2 where id = $1", [r.id, otherVenue], "42501");
  });
});

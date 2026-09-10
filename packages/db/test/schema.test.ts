import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect } from "./helpers/db.js";

describe("schema", () => {
  let owner: Client;
  let venue: string; let u1: string; let u2: string; let other: string; let uOther: string;

  beforeAll(async () => {
    const c = await cloneDatabase("schema_test");
    owner = await connect(c.owner);
    await owner.query("select set_config('dastar.actor', 'schema', false), set_config('dastar.trace_id', 's', false)");
    venue = (await owner.query("insert into dastar.venue(name, timezone) values ('A','Europe/Berlin') returning id")).rows[0].id;
    other = (await owner.query("insert into dastar.venue(name, timezone) values ('B','Europe/Berlin') returning id")).rows[0].id;
    u1 = (await owner.query("insert into dastar.unit(venue_id,label,capacity_min,capacity_max) values ($1,'T1',1,4) returning id", [venue])).rows[0].id;
    u2 = (await owner.query("insert into dastar.unit(venue_id,label,capacity_min,capacity_max) values ($1,'T2',1,4) returning id", [venue])).rows[0].id;
    uOther = (await owner.query("insert into dastar.unit(venue_id,label,capacity_min,capacity_max) values ($1,'X',1,4) returning id", [other])).rows[0].id;
  });
  afterAll(async () => { await owner.end(); await dropDatabase("schema_test"); });

  /** Reservation plus its unit rows in one transaction, so the test survives the deferred membership trigger added in Task 4. */
  async function booked(unit: string, during: string, rowUnit = unit, v = venue): Promise<string> {
    await owner.query("begin");
    try {
      const r = await owner.query(
        `insert into dastar.reservation(venue_id, party_size, during, status, assignment_kind, assignment_id, hold_expires_at, created_by)
         values ($1, 2, $2::tstzrange, 'held', 'unit', $3, now() + interval '10 minutes', 'test') returning id`,
        [v, during, unit]);
      const id = r.rows[0].id as string;
      await owner.query("insert into dastar.reservation_unit(venue_id, reservation_id, unit_id, during) values ($1,$2,$3,$4::tstzrange)", [v, id, rowUnit, during]);
      await owner.query("commit");
      return id;
    } catch (e) {
      await owner.query("rollback");
      throw e;
    }
  }

  it("exclusion constraint rejects overlapping active rows on one unit and allows adjacent half-open ranges", async () => {
    await booked(u1, "[2026-10-01 18:00+00, 2026-10-01 20:00+00)");
    await expect(booked(u1, "[2026-10-01 19:00+00, 2026-10-01 21:00+00)")).rejects.toMatchObject({ code: "23P01" });
    await booked(u1, "[2026-10-01 20:00+00, 2026-10-01 22:00+00)");
  });

  it("inactive rows do not conflict", async () => {
    const a = await booked(u2, "[2026-10-02 18:00+00, 2026-10-02 20:00+00)");
    await owner.query("update dastar.reservation_unit set active = false where reservation_id = $1", [a]);
    await booked(u2, "[2026-10-02 18:00+00, 2026-10-02 20:00+00)");
  });

  it("rejects a unit row from another venue", async () => {
    await expect(booked(u1, "[2026-10-03 18:00+00, 2026-10-03 20:00+00)", uOther)).rejects.toMatchObject({ code: "23503" });
  });

  it("enforces duration and combo bounds", async () => {
    await expect(booked(u1, "[2026-10-04 18:00+00, 2026-10-05 08:00+00)")).rejects.toMatchObject({ code: "23514" });
    await expect(booked(u1, "[2026-10-04 18:00+00, 2026-10-04 18:04+00)")).rejects.toMatchObject({ code: "23514" });
    await expect(owner.query("insert into dastar.unit_combo(venue_id,label,unit_ids,capacity_min,capacity_max) values ($1,'C',array[$2::uuid],1,8)", [venue, u1]))
      .rejects.toMatchObject({ code: "23514" });
  });
});

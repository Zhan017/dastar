import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { seedVenue, type Seed } from "./helpers/seed.js";

describe("schedules and blackouts", () => {
  let conn: Conn; let owner: Client; let app: Client;
  let A: Seed; let B: Seed;

  beforeAll(async () => {
    conn = await cloneDatabase("schedules_blackouts_test");
    owner = await connect(conn.owner);
    app = await connect(conn.app);
    A = await seedVenue(owner);
    B = await seedVenue(owner);
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100 where id = any($1::uuid[])", [[A.venue, B.venue]]);
    // direct statements as the application role run bound to venue A, as an engine command would bind it
    await app.query("select set_config('dastar.venue_id', $1, false)", [A.venue]);
  });
  afterAll(async () => {
    await app.end(); await owner.end();
    await dropDatabase("schedules_blackouts_test");
  });

  type ScheduleRow = { day: number; opens: string; closes: string; nextDay: boolean; durations: string; gap: number };
  const VALID: ScheduleRow = { day: 5, opens: "17:00", closes: "23:00", nextDay: false, durations: '{"2":90,"4":120}', gap: 15 };

  /** One schedule row, written as `c`; `over` changes what it differs from a well-formed Friday evening service. */
  function insertSchedule(c: Client, venueId: string, over: Partial<ScheduleRow> = {}) {
    const r = { ...VALID, ...over };
    return c.query(
      `insert into dastar.schedule(venue_id, day_of_week, opens, closes, closes_next_day, duration_by_size, gap_minutes)
       values ($1, $2, $3::time, $4::time, $5, $6::jsonb, $7) returning id`,
      [venueId, r.day, r.opens, r.closes, r.nextDay, r.durations, r.gap],
    );
  }
  function insertBlackout(c: Client, venueId: string, during: string, reason = "closed", active = true) {
    return c.query(
      "insert into dastar.blackout(venue_id, during, reason, active) values ($1, $2::tstzrange, $3, $4) returning id",
      [venueId, during, reason, active],
    );
  }
  const configVersion = async (venueId: string): Promise<number> =>
    Number((await owner.query("select config_version from dastar.venue where id = $1", [venueId])).rows[0].config_version);

  /** The two ways a row is written; the connections exist only once `beforeAll` has run, so each is read when a test starts. */
  const WRITERS: { who: string; client: () => Client }[] = [
    { who: "the owner", client: () => owner },
    { who: "dastar_app bound to the venue", client: () => app },
  ];

  describe("schedule", () => {
    const VALID_CASES: [string, Partial<ScheduleRow>][] = [
      ["a Friday evening service", {}],
      ["Monday", { day: 1 }],
      ["Sunday", { day: 7 }],
      ["a period that ends after midnight", { opens: "18:00", closes: "02:00", nextDay: true }],
      ["a period around the clock, which closes where it opens", { opens: "00:00", closes: "00:00", nextDay: true }],
      ["no gap", { gap: 0 }],
      ["the largest gap", { gap: 720 }],
      ["one key at the smallest duration", { durations: '{"1":5}' }],
      ["one key at the largest party size and duration", { durations: '{"999":720}' }],
      ["several keys", { durations: '{"1":5,"2":60,"4":90,"999":720}' }],
    ];
    for (const { who, client: clientOf } of WRITERS) {
      it(`${who} writes a well-formed schedule, with the defaults the table states`, async () => {
        const client = clientOf();
        for (const [label, over] of VALID_CASES) {
          const id = (await insertSchedule(client, A.venue, over)).rows[0].id as string;
          expect(id, label).toMatch(/^[0-9a-f-]{36}$/);
        }
        const row = (await owner.query("select closes_next_day, active, created_at from dastar.schedule where id = $1",
          [(await insertSchedule(client, A.venue)).rows[0].id])).rows[0];
        expect(row).toMatchObject({ closes_next_day: false, active: true });
        expect(row.created_at).toBeInstanceOf(Date);
      });
    }

    /** Every case below is refused by a CHECK, never by an evaluation error: SQLSTATE 23514. */
    const INVALID_CASES: [string, Partial<ScheduleRow>][] = [
      ["day 0", { day: 0 }],
      ["day 8", { day: 8 }],
      ["a period that ends after midnight, not saying so", { opens: "18:00", closes: "02:00", nextDay: false }],
      ["a same-day period saying it ends after midnight", { opens: "10:00", closes: "22:00", nextDay: true }],
      ["a period that closes where it opens, not saying so", { opens: "10:00", closes: "10:00", nextDay: false }],
      ["a gap of -1", { gap: -1 }],
      ["a gap of 721", { gap: 721 }],
      ["durations that are an array", { durations: "[90]" }],
      ["durations that are an empty array", { durations: "[]" }],
      ["durations that are a string", { durations: '"90"' }],
      ["durations that are a number", { durations: "90" }],
      ["durations that are a boolean", { durations: "true" }],
      ["durations that are a JSON null", { durations: "null" }],
      ["durations with no key", { durations: "{}" }],
      ["a key of 0", { durations: '{"0":60}' }],
      ["a key of 1000", { durations: '{"1000":60}' }],
      ["a key with a leading zero", { durations: '{"01":60}' }],
      ["a key that is not an integer", { durations: '{"1.5":60}' }],
      ["a negative key", { durations: '{"-1":60}' }],
      ["a key that is a word", { durations: '{"two":60}' }],
      ["a key with a space", { durations: '{" 2":60}' }],
      ["an empty key", { durations: '{"":60}' }],
      ["a value of 4", { durations: '{"2":4}' }],
      ["a value of 721", { durations: '{"2":721}' }],
      ["a value of 0", { durations: '{"2":0}' }],
      ["a negative value", { durations: '{"2":-60}' }],
      ["a value of 90.5", { durations: '{"2":90.5}' }],
      ["a value that is a string", { durations: '{"2":"90"}' }],
      ["a value that is a JSON null", { durations: '{"2":null}' }],
      ["a value that is a boolean", { durations: '{"2":true}' }],
      ["a value that is an array", { durations: '{"2":[90]}' }],
      ["a value that is an object", { durations: '{"2":{"minutes":90}}' }],
      ["a valid key followed by a value of 4", { durations: '{"2":60,"4":4}' }],
      ["a valid key followed by a key that is a word", { durations: '{"2":60,"x":60}' }],
    ];
    for (const { who, client: clientOf } of WRITERS) {
      it(`${who} is refused every malformed schedule with a check violation (23514)`, async () => {
        const client = clientOf();
        for (const [label, over] of INVALID_CASES) {
          await expect(insertSchedule(client, A.venue, over), label).rejects.toMatchObject({ code: "23514" });
        }
      });
    }

    it("names the constraint that refused the row", async () => {
      await expect(insertSchedule(owner, A.venue, { durations: "{}" })).rejects.toMatchObject({ code: "23514", constraint: "duration_by_size_shape" });
      await expect(insertSchedule(owner, A.venue, { nextDay: true, opens: "10:00", closes: "22:00" })).rejects.toMatchObject({ code: "23514", constraint: "schedule_closes_next_day" });
    });

    it("a schedule of a venue that does not exist is refused (23503)", async () => {
      await expect(insertSchedule(owner, "00000000-0000-7000-8000-000000000000")).rejects.toMatchObject({ code: "23503" });
    });

    it("an update is held to the same checks", async () => {
      const id = (await insertSchedule(app, A.venue)).rows[0].id as string;
      await expect(app.query("update dastar.schedule set duration_by_size = '{\"2\":4}' where id = $1", [id])).rejects.toMatchObject({ code: "23514" });
      await expect(app.query("update dastar.schedule set closes_next_day = true where id = $1", [id])).rejects.toMatchObject({ code: "23514" });
      expect((await app.query("update dastar.schedule set duration_by_size = '{\"2\":45}', gap_minutes = 10, active = false where id = $1", [id])).rowCount).toBe(1);
    });
  });

  describe("blackout", () => {
    const DAY = (d: number) => `2091-02-${String(d).padStart(2, "0")}T00:00:00Z`;
    const range = (from: number, to: number) => `[${DAY(from)},${DAY(to)})`;

    for (const { who, client: clientOf } of WRITERS) {
      it(`${who} writes a bounded range with a reason of 1 to 500 characters, active by default`, async () => {
        const client = clientOf();
        const id = (await insertBlackout(client, A.venue, range(1, 2), "x")).rows[0].id as string;
        await insertBlackout(client, A.venue, range(3, 4), "r".repeat(500));
        const row = (await owner.query("select active, reason from dastar.blackout where id = $1", [id])).rows[0];
        expect(row).toEqual({ active: true, reason: "x" });
      });

      it(`${who} is refused an empty, unbounded, or too-long-reasoned blackout with a check violation (23514)`, async () => {
        const client = clientOf();
        const refused = (during: string, reason = "closed") => expect(insertBlackout(client, A.venue, during, reason), `${during} / ${reason.length} chars`).rejects.toMatchObject({ code: "23514" });
        await refused("empty");
        await refused(`[${DAY(5)},${DAY(5)})`);
        await refused(`(${DAY(5)},${DAY(5)}]`);
        await refused(`[${DAY(5)},)`);
        await refused(`(,${DAY(5)})`);
        await refused("(,)");
        await refused(range(5, 6), "");
        await refused(range(5, 6), "r".repeat(501));
      });

      it(`${who} cannot write a reversed range: the range type itself refuses it (22000)`, async () => {
        const client = clientOf();
        await expect(insertBlackout(client, A.venue, range(9, 8))).rejects.toMatchObject({ code: "22000" });
      });
    }

    it("a blackout of a venue that does not exist is refused (23503)", async () => {
      await expect(insertBlackout(owner, "00000000-0000-7000-8000-000000000000", range(10, 11))).rejects.toMatchObject({ code: "23503" });
    });
  });

  it("the config version of a venue steps by one on every insert and update of its schedules and blackouts, as the owner and as dastar_app", async () => {
    const C = await seedVenue(owner);
    const during = (d: number) => `[2092-03-${String(d).padStart(2, "0")}T00:00:00Z,2092-03-${String(d + 1).padStart(2, "0")}T00:00:00Z)`;
    const steps = async (venueId: string, run: () => Promise<unknown>): Promise<number> => {
      const before = await configVersion(venueId);
      await run();
      return (await configVersion(venueId)) - before;
    };

    let sid = ""; let bid = "";
    expect(await steps(C.venue, async () => { sid = (await insertSchedule(owner, C.venue)).rows[0].id; })).toBe(1);
    expect(await steps(C.venue, () => owner.query("update dastar.schedule set gap_minutes = 30 where id = $1", [sid]))).toBe(1);
    expect(await steps(C.venue, async () => { bid = (await insertBlackout(owner, C.venue, during(1))).rows[0].id; })).toBe(1);
    expect(await steps(C.venue, () => owner.query("update dastar.blackout set reason = 'renovation' where id = $1", [bid]))).toBe(1);
    expect(await steps(C.venue, () => owner.query("update dastar.blackout set active = false where id = $1", [bid]))).toBe(1);

    expect(await steps(A.venue, async () => { sid = (await insertSchedule(app, A.venue)).rows[0].id; })).toBe(1);
    expect(await steps(A.venue, () => app.query("update dastar.schedule set gap_minutes = 30 where id = $1", [sid]))).toBe(1);
    expect(await steps(A.venue, async () => { bid = (await insertBlackout(app, A.venue, during(5))).rows[0].id; })).toBe(1);
    expect(await steps(A.venue, () => app.query("update dastar.blackout set reason = 'renovation' where id = $1", [bid]))).toBe(1);
    expect(await steps(A.venue, () => app.query("update dastar.blackout set active = false where id = $1", [bid]))).toBe(1);

    // another venue's version does not move
    const b0 = await configVersion(B.venue);
    await insertSchedule(app, A.venue);
    expect(await configVersion(B.venue)).toBe(b0);
  });

  it("dastar_app and dastar_worker cannot delete a schedule or a blackout, and the application role updates only the granted columns", async () => {
    const sid = (await insertSchedule(app, A.venue)).rows[0].id as string;
    const bid = (await insertBlackout(app, A.venue, "[2093-01-01T00:00:00Z,2093-01-02T00:00:00Z)")).rows[0].id as string;
    const worker = await connect(conn.worker);
    try {
      for (const [who, client] of [["dastar_app", app], ["dastar_worker", worker]] as const) {
        await expect(client.query("delete from dastar.schedule where id = $1", [sid]), `${who}: schedule`).rejects.toMatchObject({ code: "42501" });
        await expect(client.query("delete from dastar.blackout where id = $1", [bid]), `${who}: blackout`).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await worker.end();
    }
    expect((await owner.query("select count(*)::int as n from dastar.schedule where id = $1", [sid])).rows[0].n).toBe(1);
    expect((await owner.query("select count(*)::int as n from dastar.blackout where id = $1", [bid])).rows[0].n).toBe(1);

    // a blackout's range and a row's venue are fixed; the columns the grants name are not
    await expect(app.query("update dastar.blackout set during = '[2093-02-01T00:00:00Z,2093-02-02T00:00:00Z)' where id = $1", [bid])).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("update dastar.blackout set venue_id = $2 where id = $1", [bid, B.venue])).rejects.toMatchObject({ code: "42501" });
    await expect(app.query("update dastar.schedule set venue_id = $2 where id = $1", [sid, B.venue])).rejects.toMatchObject({ code: "42501" });
    expect((await app.query("update dastar.blackout set reason = 'closed for a wedding', active = false where id = $1", [bid])).rowCount).toBe(1);
    expect((await app.query("update dastar.schedule set day_of_week = 6, opens = '12:00', closes = '15:00', closes_next_day = false, duration_by_size = '{\"2\":60}', gap_minutes = 0, active = false where id = $1", [sid])).rowCount).toBe(1);
  });

  it("venue_lock_key is stable and 64-bit, differs from the unit key of the same id, and differs between venues", async () => {
    const r = (await app.query(
      `select dastar.venue_lock_key($1::uuid) as v1, dastar.venue_lock_key($1::uuid) as v2,
              dastar.unit_lock_key($1::uuid) as u, dastar.venue_lock_key($2::uuid) as other`,
      [A.venue, B.venue],
    )).rows[0] as { v1: string; v2: string; u: string; other: string };
    expect(r.v1).toMatch(/^-?\d+$/);
    expect(BigInt(r.v1)).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(BigInt(r.v1)).toBeLessThan(2n ** 63n);
    expect(r.v2).toBe(r.v1);
    expect(r.u).not.toBe(r.v1);
    expect(r.other).not.toBe(r.v1);
  });
});

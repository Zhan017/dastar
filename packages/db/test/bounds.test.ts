import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { BOUNDS } from "@dastar/core";
import { cloneDatabase, dropDatabase, connect } from "./helpers/db.js";

/** The bounds `@dastar/core` states are the ones the schema's CHECK constraints enforce: each is tried at its edge and one step past it. */
describe("workload bounds", () => {
  let owner: Client; let venue: string; const units: string[] = [];

  beforeAll(async () => {
    const c = await cloneDatabase("bounds_test");
    owner = await connect(c.owner);
    await owner.query("select set_config('dastar.actor', 'bounds', false), set_config('dastar.trace_id', 'b', false)");
    venue = (await owner.query("insert into dastar.venue(name, timezone) values ('B', 'Europe/Berlin') returning id")).rows[0].id as string;
    for (let i = 0; i < BOUNDS.comboUnits.max + 1; i++) {
      units.push((await owner.query("insert into dastar.unit(venue_id, label, capacity_min, capacity_max) values ($1, $2, 1, 4) returning id", [venue, `T${i}`])).rows[0].id as string);
    }
  });
  afterAll(async () => { await owner.end(); await dropDatabase("bounds_test"); });

  /** Runs one statement inside a savepoint and reports the constraint that refused it, or null. */
  async function refusedBy(sql: string, params: unknown[]): Promise<string | null> {
    await owner.query("begin");
    try {
      await owner.query(sql, params);
      await owner.query("set constraints all immediate");
      return null;
    } catch (e) {
      return (e as { constraint?: string; code?: string }).constraint ?? (e as { code?: string }).code ?? "unknown";
    } finally {
      await owner.query("rollback");
    }
  }

  it("a venue's hold TTL and live-holds cap", async () => {
    const ttl = (s: number) => refusedBy("insert into dastar.venue(name, timezone, hold_ttl_seconds) values ('x', 'UTC', $1)", [s]);
    expect(await ttl(BOUNDS.holdTtlSeconds.min)).toBeNull();
    expect(await ttl(BOUNDS.holdTtlSeconds.max)).toBeNull();
    expect(await ttl(BOUNDS.holdTtlSeconds.min - 1)).not.toBeNull();
    expect(await ttl(BOUNDS.holdTtlSeconds.max + 1)).not.toBeNull();
    const cap = (n: number) => refusedBy("insert into dastar.venue(name, timezone, max_live_holds_per_actor) values ('x', 'UTC', $1)", [n]);
    expect(await cap(BOUNDS.liveHoldsPerActor.max)).toBeNull();
    expect(await cap(BOUNDS.liveHoldsPerActor.max + 1)).not.toBeNull();
    const fresh = await owner.query("select max_live_holds_per_actor as n from dastar.venue where id = $1", [venue]);
    expect(fresh.rows[0].n).toBe(BOUNDS.liveHoldsPerActor.default);
  });

  it("the units in a combination", async () => {
    const combo = (n: number) => refusedBy("insert into dastar.unit_combo(venue_id, label, unit_ids, capacity_min, capacity_max) values ($1, 'c', $2::uuid[], 2, 8)", [venue, [...units].sort().slice(0, n)]);
    expect(await combo(BOUNDS.comboUnits.min)).toBeNull();
    expect(await combo(BOUNDS.comboUnits.max)).toBeNull();
    expect(await combo(BOUNDS.comboUnits.min - 1)).toBe("combo_too_large");
    expect(await combo(BOUNDS.comboUnits.max + 1)).toBe("combo_too_large");
  });

  it("a booking's duration", async () => {
    const start = Date.UTC(2040, 0, 1, 18);
    let day = 0;
    const booking = (minutes: number) => {
      const s = start + day++ * 86_400_000;
      const during = `[${new Date(s).toISOString()},${new Date(s + minutes * 60_000).toISOString()})`;
      return refusedBy(
        `with r as (
           insert into dastar.reservation(venue_id, party_size, during, status, assignment_kind, assignment_id, hold_expires_at, created_by)
           values ($1, 2, $2::tstzrange, 'held', 'unit', $3, now() + interval '10 minutes', 'bounds') returning id)
         insert into dastar.reservation_unit(venue_id, reservation_id, unit_id, during) select $1, id, $3, $2::tstzrange from r`,
        [venue, during, units[0]]);
    };
    expect(await booking(BOUNDS.durationMinutes.min)).toBeNull();
    expect(await booking(BOUNDS.durationMinutes.max)).toBeNull();
    expect(await booking(BOUNDS.durationMinutes.min - 1)).toBe("duration_out_of_range");
    expect(await booking(BOUNDS.durationMinutes.max + 1)).toBe("duration_out_of_range");
  });
});

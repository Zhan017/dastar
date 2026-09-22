import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool, Client } from "pg";
import { createDastar } from "@dastar/db";
import { cloneDatabase, dropDatabase, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedBench } from "../src/seed.js";
import { runMixed, judgeMixed, EXPECTED, type MixedOp } from "../src/mixed.js";

describe("mixed verdict", () => {
  const okByOp = { hold_unit: 900, hold_combo: 300, confirm: 200, cancel: 500, mint_confirm: 150, capacity_edit: 250 };
  const good = { okByOp, unexpected: 0, deadlockDelta: 0, overlaps: 0, fitViolations: 0, sweep: { errors: 0, ticks: 20 }, aged: 400, ageErrors: 0, sweptHere: 120 };

  it("passes when nothing went wrong and every path was taken", () => {
    expect(judgeMixed(good)).toEqual({ verdict: "pass", reasons: [] });
  });

  it("a run that exercised nothing, or hardly took one of its paths, is inconclusive: silence from a path nobody walked proves nothing", () => {
    const nothing = judgeMixed({ ...good, okByOp: { hold_unit: 0, hold_combo: 0, confirm: 0, cancel: 0, mint_confirm: 0, capacity_edit: 0 }, aged: 0, sweep: { errors: 0, ticks: 1 }, sweptHere: 0 });
    expect(nothing.verdict).toBe("inconclusive");
    expect(nothing.reasons).toHaveLength(8);
    // a floor that filled up at once: holds were refused from then on, so nothing was left to confirm or cancel
    expect(judgeMixed({ ...good, okByOp: { ...okByOp, confirm: 3 } })).toEqual({ verdict: "inconclusive", reasons: ["confirm succeeded 3 time(s)"] });
    expect(judgeMixed({ ...good, sweptHere: 2 })).toEqual({ verdict: "inconclusive", reasons: ["the sweeper expired 2 hold(s) of this venue"] });
    expect(judgeMixed({ ...good, aged: 0 })).toEqual({ verdict: "inconclusive", reasons: ["0 hold(s) aged"] });
  });

  it("a deadlock, an overlap, a misfit, or an unexpected answer fails it, however thin the run", () => {
    expect(judgeMixed({ ...good, deadlockDelta: 1, aged: 0 })).toEqual({ verdict: "fail", reasons: ["1 deadlock(s)"] });
    expect(judgeMixed({ ...good, overlaps: 2, fitViolations: 1, unexpected: 60 }).reasons).toHaveLength(3);
  });

  it("broken machinery makes the run invalid before anything else is read", () => {
    expect(judgeMixed({ ...good, deadlockDelta: 1, sweep: { errors: 2, ticks: 20 } })).toEqual({ verdict: "invalid", reasons: ["2 sweeper error(s)"] });
    expect(judgeMixed({ ...good, sweep: { errors: 0, ticks: 0 } }).reasons).toEqual(["the sweeper never ran"]);
    expect(judgeMixed({ ...good, ageErrors: 4 }).reasons).toEqual(["4 aging statement(s) failed"]);
  });
});

describe("mixed run", () => {
  let conn: Conn; let owner: Client; let ager: Client; let appPool: Pool; let workerPool: Pool;
  beforeAll(async () => {
    conn = await cloneDatabase("harness_mixed");
    owner = new Client({ connectionString: conn.owner });
    ager = new Client({ connectionString: conn.owner });
    await owner.connect();
    await ager.connect();
    appPool = new Pool({ connectionString: conn.app, max: 16 });
    appPool.on("error", () => undefined);
    workerPool = new Pool({ connectionString: conn.worker, max: 2 });
    workerPool.on("error", () => undefined);
  });
  afterAll(async () => { await appPool.end(); await workerPool.end(); await ager.end(); await owner.end(); await dropDatabase("harness_mixed"); });

  it("every writer at once: no deadlock, no overlap, no party outside its capacity, only expected answers", async () => {
    const seed = await seedBench(owner, { units: 8, mesh: true, holdTtlSeconds: 60 });
    // a second venue, already dead before the run starts: the sweeper picks these up database-wide, but they are not this run's own venue
    const other = await seedBench(owner, { units: 4, combos: 1 });
    const otherHandle = createDastar({ pool: appPool });
    const otherIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const out = await otherHandle.hold({
        venueId: other.venue, actor: "other-venue", traceId: `other-${i}`, idempotencyKey: `other-${i}`, partySize: 2, durationMinutes: 60,
        startsAt: new Date(Date.UTC(2053, 0, i + 1, 19)).toISOString(), assignment: { kind: "unit", id: other.units[i % other.units.length]! },
      });
      if (out.ok) otherIds.push(out.receipt.reservationId);
    }
    await otherHandle.close();
    expect(otherIds.length).toBe(12);
    // the audit trigger on dastar.reservation needs dastar.actor set for any writer, this owner connection included
    await owner.query("select set_config('dastar.actor', 'test:age-other-venue', false), set_config('dastar.trace_id', 'test-age', false)");
    await owner.query("update dastar.reservation set hold_expires_at = now() - interval '1 second' where id = any($1::uuid[])", [otherIds]);

    const r = await runMixed({ appPool, workerPool, owner, ager, seed }, { seconds: 6, workers: 24, seed: 21, sweep: { everyMs: 300, limit: 20, drain: true } });
    expect(r.unexpected).toEqual([]);
    expect(r.verdict, JSON.stringify(r.verdict)).toEqual({ verdict: "pass", reasons: [] });
    expect(r).toMatchObject({ deadlockDelta: 0, overlaps: 0, fitViolations: 0, pass: true });
    expect(r.expiry.ageErrors).toBe(0);
    expect(r.rules.length).toBeGreaterThan(0);
    for (const op of Object.keys(EXPECTED) as MixedOp[]) expect(r.ops[op].count, op).toBeGreaterThan(0);
    // the hard paths ran, not only the easy ones
    expect(r.ops.hold_unit.byCode.hold_conflict ?? 0).toBeGreaterThan(0);
    expect(r.expiry.mode).toBe("owner-aged");
    expect(r.expiry.aged).toBeGreaterThan(0);
    expect(r.expiry.expired).toBeGreaterThan(0);
    expect(r.expiry.bySweeper + r.expiry.byCompetingHold).toBe(r.expiry.expired);
    expect(r.sweep).toMatchObject({ config: { everyMs: 300, limit: 20, drain: true }, errors: 0 });
    // the sweeper's database-wide count includes the second venue's twelve dead holds; this run's own venue does not
    expect(r.sweep.expired).toBeGreaterThanOrEqual(r.expiry.bySweeper + 12);
    expect(r.expiry.byCompetingHold).toBeGreaterThanOrEqual(0);
    const ownVenueExpired = (await owner.query("select count(*)::int as n from dastar.reservation where venue_id = $1 and status = 'expired'", [seed.venue])).rows[0].n as number;
    expect(r.expiry.expired).toBe(ownVenueExpired);
    const otherVenueExpired = (await owner.query("select count(*)::int as n from dastar.reservation where venue_id = $1 and status = 'expired'", [other.venue])).rows[0].n as number;
    expect(otherVenueExpired).toBe(12);
  });

  it("refuses a seed without shared-member combos", async () => {
    const seed = await seedBench(owner, { units: 4, combos: 1 });
    await expect(runMixed({ appPool, workerPool, owner, ager, seed }, { seconds: 1, workers: 1, seed: 1 })).rejects.toThrow(/mesh/);
  });
});

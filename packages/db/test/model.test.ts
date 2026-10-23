import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fc, { type Arbitrary } from "fast-check";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { COMMANDS, setClocks, tally, type Real } from "./model/commands.js";
import { MINUTE, type Model, type ModelCombo, type ModelUnit, type Period } from "./model/model.js";

// A failure prints the seed, the path, and the command list; DASTAR_MODEL_SEED and DASTAR_MODEL_PATH replay it.
const SEED = Number(process.env.DASTAR_MODEL_SEED ?? 20261022);
const PATH = process.env.DASTAR_MODEL_PATH;
const RUNS = Number(process.env.DASTAR_MODEL_RUNS ?? 80);
const MAX_COMMANDS = 50;
/** With the default seed and size, each of these outcomes must come up, so the test cannot pass on a run that exercised too little. */
const FLOORS = [
  "hold held", "hold replay", "hold mismatch", "hold overlap expired", "hold stored party_does_not_fit", "hold stored hold_conflict", "hold stored blackout",
  "hold throws outside_schedule", "hold throws assignment_inactive", "hold throws assignment_inactive via a member", "hold throws too_many_live_holds",
  "confirm by key ok", "confirm by token ok", "confirm by wrong forbidden", "confirm by stale forbidden",
  "confirm by key hold_expired", "confirm by key invalid_transition", "confirm by key version_conflict",
  "mint ok", "mint token_requires_held", "cancel ok", "cancel invalid_transition", "seat ok", "complete ok", "sweep expired",
  "unit capacity_conflict", "unit assignment_in_use", "unit forced", "unit reservation_in_progress", "combo assignment_in_use",
  "blackout blackout_conflict", "blackout forced", "reactivated blackout applied", "reactivated blackout blackout_conflict", "reactivated blackout forced",
];
const DEFAULTS = process.env.DASTAR_MODEL_SEED === undefined && PATH === undefined && process.env.DASTAR_MODEL_RUNS === undefined;

const DAY = 24 * 60 * MINUTE;
/** The booking window crosses midnight, so a service period that closes the next day matters: 21:00 to 01:00 UTC. */
const DATE = Date.UTC(2070, 2, 5);
const WINDOW_START = DATE + 21 * 60 * MINUTE;
const isoDow = (t: number): number => new Date(t).getUTCDay() || 7;
const hhmm = (h: number): string => `${String(h).padStart(2, "0")}:00`;

type Plan = {
  units: { min: number; extra: number }[];
  combos: { members: number[] }[];
  schedules: { day: number; opens: number; length: number }[];
  ttlSeconds: number;
  cap: number;
};

const planArb: Arbitrary<Plan> = fc.record({
  units: fc.array(fc.record({ min: fc.integer({ min: 1, max: 2 }), extra: fc.integer({ min: 1, max: 4 }) }), { minLength: 3, maxLength: 5 }),
  combos: fc.array(fc.record({ members: fc.uniqueArray(fc.nat({ max: 5 }), { minLength: 2, maxLength: 3 }) }), { maxLength: 3 }),
  schedules: fc.array(fc.record({ day: fc.nat({ max: 1 }), opens: fc.nat({ max: 23 }), length: fc.integer({ min: 2, max: 10 }) }), { maxLength: 2 }),
  ttlSeconds: fc.constantFrom(120, 600, 900),
  cap: fc.integer({ min: 1, max: 3 }),
});

describe("the engine against a reference model", () => {
  let conn: Conn; let owner: Client; let app: Client; let worker: Client;
  let runs = 0;

  beforeAll(async () => {
    conn = await cloneDatabase("model_test");
    owner = await connect(conn.owner);
    app = await connect(conn.app);
    worker = await connect(conn.worker);
  });
  afterAll(async () => {
    await worker.end(); await app.end(); await owner.end();
    await dropDatabase("model_test");
  });

  /** One run's venue, written by the owner, and the model that starts from it, half an hour before the window. */
  async function setup(plan: Plan): Promise<{ model: Model; real: Real }> {
    runs += 1;
    const venueId = (await owner.query(
      "insert into dastar.venue(name, timezone, hold_ttl_seconds, max_live_holds_per_actor) values ($1, 'UTC', $2, $3) returning id",
      [`model-${runs}`, plan.ttlSeconds, plan.cap],
    )).rows[0].id as string;
    const units: ModelUnit[] = [];
    for (const [i, u] of plan.units.entries()) {
      const id = (await owner.query(
        "insert into dastar.unit(venue_id, label, capacity_min, capacity_max) values ($1, $2, $3, $4) returning id",
        [venueId, `U${i}`, u.min, u.min + u.extra],
      )).rows[0].id as string;
      units.push({ id, min: u.min, max: u.min + u.extra, active: true });
    }
    const combos: ModelCombo[] = [];
    for (const [j, c] of plan.combos.entries()) {
      const members = [...new Set(c.members.map((k) => units[k % units.length]!.id))].sort();
      if (members.length < 2) continue;
      const max = Math.min(12, members.reduce((sum, id) => sum + units.find((u) => u.id === id)!.max, 0));
      const id = (await owner.query(
        "insert into dastar.unit_combo(venue_id, label, unit_ids, capacity_min, capacity_max) values ($1, $2, $3::uuid[], 2, $4) returning id",
        [venueId, `K${j}`, members, max],
      )).rows[0].id as string;
      combos.push({ id, members, min: 2, max, active: true });
    }
    // service periods on the window's two dates, as Postgres computes them for a UTC venue, one day either side
    const periods: Period[] = [];
    for (const s of plan.schedules) {
      const dow = isoDow(DATE + s.day * DAY);
      const closes = (s.opens + s.length) % 24;
      const nextDay = closes <= s.opens;
      await owner.query(
        `insert into dastar.schedule(venue_id, day_of_week, opens, closes, closes_next_day, duration_by_size, gap_minutes)
         values ($1, $2, $3::time, $4::time, $5, '{"2":60,"4":90,"8":120}'::jsonb, 0)`,
        [venueId, dow, hhmm(s.opens), hhmm(closes), nextDay],
      );
      for (let d = DATE - DAY; d <= DATE + DAY; d += DAY) {
        if (isoDow(d) !== dow) continue;
        periods.push({ start: d + s.opens * 60 * MINUTE, end: d + (nextDay ? DAY : 0) + closes * 60 * MINUTE });
      }
    }
    const model: Model = {
      venueId, windowStart: WINDOW_START, clock: WINDOW_START - 30 * MINUTE, ttlMs: plan.ttlSeconds * 1000, cap: plan.cap,
      units, combos, blackouts: [], hasSchedule: plan.schedules.length > 0, periods,
      reservations: [], idempotency: new Map(), holdLog: [],
    };
    const real: Real = { app, worker, owner };
    await setClocks(model, real);
    return { model, real };
  }

  it(`${RUNS} random venues and command sequences: every outcome, the state, and the audit and outbox trails match the model, and invariants 1, 4, 8, 9, 11, and 12 hold after every step (seed ${SEED})`, async () => {
    await fc.assert(
      fc.asyncProperty(planArb, fc.commands(COMMANDS, { maxCommands: MAX_COMMANDS, size: "max" }), async (plan, cmds) => {
        await fc.asyncModelRun(() => setup(plan), cmds);
      }),
      // a failure's shrinking stops before the test's own timeout, so the seed and path are still reported
      { seed: SEED, numRuns: RUNS, interruptAfterTimeLimit: 840_000, markInterruptAsFailure: true, ...(PATH === undefined ? {} : { path: PATH }) },
    );
    console.log(`model outcomes over ${runs} runs:\n${[...tally].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `  ${k}: ${n}`).join("\n")}`);
    if (DEFAULTS) expect(FLOORS.filter((label) => !tally.has(label)), "outcomes the default run never produced").toEqual([]);
  }, 900_000);
});

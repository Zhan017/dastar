import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedVenue, type Seed } from "../../../packages/db/test/helpers/seed.js";
import { createKey } from "../src/auth.js";
import { makeApi, bearer, jsonInit } from "./helpers.js";

type Key = { id: string; key: string };
type Json = Record<string, unknown>;
type UnitJson = { id: string; label: string; capacity_min: number; capacity_max: number; active: boolean; layout: Json };
type ComboJson = { id: string; label: string; unit_ids: string[]; capacity_min: number; capacity_max: number; active: boolean };
type ScheduleJson = { id: string; day_of_week: number; opens: string; closes: string; closes_next_day: boolean; duration_by_size: Record<string, number>; gap_minutes: number; active: boolean };
type BlackoutJson = { id: string; starts_at: string; ends_at: string; reason: string; active: boolean };
type Calendar = Seed & { schedule: string; blackout: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ABSENT = "00000000-0000-7000-8000-000000000001";
const ELSEWHERE = "01a0b07c-189a-70cb-a39e-1f679b38fe4d";

describe("admin routes", () => {
  let conn: Conn; let owner: Client; let api: ReturnType<typeof makeApi>; let clocked: ReturnType<typeof makeApi>;
  let admin: Key; let desk: Key;
  let n = 0; let dayN = 0;

  beforeAll(async () => {
    conn = await cloneDatabase("api_admin_test");
    owner = await connect(conn.owner);
    api = makeApi(conn);
    // one pooled connection, so a session clock set through the pool is the clock of the next request
    clocked = makeApi(conn, { poolMax: 1, appName: "api-admin-clock" });
    admin = await createKey(api.pool, { label: "admin", capabilities: ["admin"] });
    desk = await createKey(api.pool, { label: "desk", capabilities: ["hold", "confirm", "cancel", "seat", "read"] });
  });
  afterAll(async () => { await clocked.close(); await api.close(); await owner.end(); await dropDatabase("api_admin_test"); });

  /** A fresh day in January 2064 for each scenario; a scenario also gets a venue of its own. */
  const nextDay = (): number => ++dayN;
  const at = (day: number, hour: number, minute = 0): string => new Date(Date.UTC(2064, 0, day, hour, minute)).toISOString();

  async function fresh(): Promise<Seed> {
    const seed = await seedVenue(owner);
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100 where id = $1", [seed.venue]);
    return seed;
  }
  /** A venue with one service period and one active blackout in 2070, written by the owner. */
  async function withCalendar(): Promise<Calendar> {
    const seed = await fresh();
    const schedule = (await owner.query(
      `insert into dastar.schedule(venue_id, day_of_week, opens, closes, closes_next_day, duration_by_size, gap_minutes)
       values ($1, 1, '17:00'::time, '23:00'::time, false, '{"2":90}'::jsonb, 0) returning id`, [seed.venue])).rows[0].id as string;
    const blackout = (await owner.query(
      "insert into dastar.blackout(venue_id, during, reason, active) values ($1, tstzrange($2::timestamptz, $3::timestamptz), 'seed', true) returning id",
      [seed.venue, "2070-01-01T00:00:00Z", "2070-01-02T00:00:00Z"])).rows[0].id as string;
    return { ...seed, schedule, blackout };
  }

  function request(app: ReturnType<typeof makeApi>["app"], method: string, path: string, key: Key | null, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
    const headers = { ...(key === null ? {} : bearer(key.key)), ...extra };
    return Promise.resolve(app.request(path, body === undefined ? { method, headers } : jsonInit(method, body, headers)));
  }
  const call = (method: string, path: string, key: Key | null, body?: unknown, extra: Record<string, string> = {}) => request(api.app, method, path, key, body, extra);
  const json = async <T = Json>(r: Response): Promise<T> => await r.json() as T;
  const base = (venue: string): string => `/admin/venues/${venue}`;

  /** A hold through the API: a unit by default, party of 2, 90 minutes. */
  async function placeHold(venue: string, startsAt: string, over: { assignment?: { kind: "unit" | "combo"; id: string }; party?: number; unit?: string } = {}): Promise<string> {
    n += 1;
    const r = await call("POST", `/v1/venues/${venue}/holds`, desk, {
      party_size: over.party ?? 2, starts_at: startsAt, duration_minutes: 90, assignment: over.assignment ?? { kind: "unit", id: over.unit! },
    }, { "idempotency-key": `admin-h${n}` });
    expect(r.status).toBe(201);
    return (await json<{ receipt: { reservation_id: string } }>(r)).receipt.reservation_id;
  }
  async function placeConfirmed(venue: string, startsAt: string, unit: string): Promise<string> {
    const id = await placeHold(venue, startsAt, { unit });
    expect((await call("POST", `/v1/reservations/${id}/confirm`, desk, {})).status).toBe(200);
    return id;
  }
  async function stored(id: string): Promise<{ status: string; cancel_reason: string | null }> {
    return (await owner.query("select status, cancel_reason from dastar.reservation where id = $1", [id])).rows[0] as { status: string; cancel_reason: string | null };
  }
  async function cancelEvents(id: string): Promise<number> {
    return (await owner.query("select count(*)::int as n from dastar.outbox where topic = 'reservation.cancelled' and payload->>'reservation_id' = $1", [id])).rows[0].n as number;
  }
  async function unitRow(id: string): Promise<{ active: boolean; capacity_min: number; capacity_max: number }> {
    return (await owner.query("select active, capacity_min, capacity_max from dastar.unit where id = $1", [id])).rows[0] as { active: boolean; capacity_min: number; capacity_max: number };
  }
  async function count(sql: string, params: unknown[]): Promise<number> {
    return (await owner.query(sql, params)).rows[0].n as number;
  }
  /** Every configuration row of the venue, so a refused request can be shown to have changed none. */
  async function snapshot(venue: string): Promise<unknown> {
    return (await owner.query(
      `select (select jsonb_agg(to_jsonb(t) order by id) from dastar.unit t where venue_id = $1) as units,
              (select jsonb_agg(to_jsonb(t) order by id) from dastar.unit_combo t where venue_id = $1) as combos,
              (select jsonb_agg(to_jsonb(t) order by id) from dastar.schedule t where venue_id = $1) as schedules,
              (select jsonb_agg(to_jsonb(t) order by id) from dastar.blackout t where venue_id = $1) as blackouts`, [venue])).rows[0];
  }

  /** One request for each of the twelve admin routes, each with a body that passes validation. */
  function routes(C: Calendar): [string, string, unknown][] {
    const b = base(C.venue);
    return [
      ["GET", `${b}/units`, undefined],
      ["POST", `${b}/units`, { label: "Booth", capacity_min: 1, capacity_max: 2 }],
      ["PATCH", `${b}/units/${C.units[0]}`, { active: false, force: true }],
      ["GET", `${b}/combos`, undefined],
      ["POST", `${b}/combos`, { label: "Pair", unit_ids: [C.units[4], C.units[5]], capacity_min: 3, capacity_max: 4 }],
      ["PATCH", `${b}/combos/${C.combos[0]!.id}`, { active: false, force: true }],
      ["GET", `${b}/schedules`, undefined],
      ["POST", `${b}/schedules`, { day_of_week: 2, opens: "17:00", closes: "23:00", duration_by_size: { "2": 90 } }],
      ["PATCH", `${b}/schedules/${C.schedule}`, { active: false }],
      ["GET", `${b}/blackouts?from=2070-01-01T00:00:00Z&to=2070-01-03T00:00:00Z`, undefined],
      ["POST", `${b}/blackouts`, { starts_at: "2070-02-01T10:00:00Z", ends_at: "2070-02-01T12:00:00Z", reason: "Event", force: true }],
      ["PATCH", `${b}/blackouts/${C.blackout}`, { active: false }],
    ];
  }

  describe("authorization", () => {
    it("401 without a key", async () => {
      const C = await withCalendar();
      const r = await call("GET", `${base(C.venue)}/units`, null);
      expect(r.status).toBe(401);
      expect(await json(r)).toMatchObject({ code: "unauthorized" });
    });

    it("403 without the admin capability on every admin route, whatever else the key may do, and nothing is written", async () => {
      const C = await withCalendar();
      const cases = routes(C);
      expect(cases).toHaveLength(12);
      const before = await snapshot(C.venue);
      for (const [method, path, body] of cases) {
        const r = await call(method, path, desk, body);
        expect(r.status, `${method} ${path}`).toBe(403);
        expect(await json(r), `${method} ${path}`).toMatchObject({ code: "forbidden" });
      }
      expect(await snapshot(C.venue)).toEqual(before);
    });

    it("an admin key grants nothing else", async () => {
      const C = await withCalendar();
      const r = await call("GET", `/v1/venues/${C.venue}/holds`, admin);
      expect(r.status).toBe(403);
    });

    it("404 on every admin route for a key scoped to another venue, and nothing is written; a key scoped to the venue is served", async () => {
      const C = await withCalendar();
      const away = await createKey(api.pool, { label: "away", capabilities: ["admin"], venueIds: [ELSEWHERE] });
      const cases = routes(C);
      expect(cases).toHaveLength(12);
      const before = await snapshot(C.venue);
      for (const [method, path, body] of cases) {
        const r = await call(method, path, away, body);
        expect(r.status, `${method} ${path}`).toBe(404);
        expect(await json(r), `${method} ${path}`).toMatchObject({ code: "not_found" });
      }
      expect(await snapshot(C.venue)).toEqual(before);
      expect((await unitRow(C.units[0]!)).active).toBe(true);

      const home = await createKey(api.pool, { label: "home", capabilities: ["admin"], venueIds: [C.venue] });
      const ok = await call("GET", `${base(C.venue)}/units`, home);
      expect(ok.status).toBe(200);
      expect((await json<{ units: UnitJson[] }>(ok)).units).toHaveLength(6);
    });
  });

  describe("units and combinations", () => {
    it("creates, lists, and changes a unit, with the unit in snake_case", async () => {
      const S = await fresh();
      const b = base(S.venue);
      const created = await call("POST", `${b}/units`, admin, { label: "Aa", capacity_min: 2, capacity_max: 6, layout: { x: 1, y: 2 } });
      expect(created.status).toBe(201);
      expect(created.headers.get("content-type")).toContain("application/json");
      const { unit } = await json<{ unit: UnitJson }>(created);
      expect(unit).toEqual({ id: expect.stringMatching(UUID), label: "Aa", capacity_min: 2, capacity_max: 6, active: true, layout: { x: 1, y: 2 } });
      expect((await owner.query("select venue_id, label, layout from dastar.unit where id = $1", [unit.id])).rows).toEqual([{ venue_id: S.venue, label: "Aa", layout: { x: 1, y: 2 } }]);

      const plain = await json<{ unit: UnitJson }>(await call("POST", `${b}/units`, admin, { label: "Zz", capacity_min: 1, capacity_max: 1 }));
      expect(plain.unit.layout).toEqual({});

      const listed = await call("GET", `${b}/units`, admin);
      expect(listed.status).toBe(200);
      const units = (await json<{ units: UnitJson[] }>(listed)).units;
      expect(units).toHaveLength(8);
      expect(units[0]).toEqual(unit);
      expect(units.at(-1)).toEqual(plain.unit);

      const changed = await call("PATCH", `${b}/units/${unit.id}`, admin, { label: "Bb", capacity_max: 8, layout: { a: true } });
      expect(changed.status).toBe(200);
      expect(await json(changed)).toEqual({ unit: { id: unit.id, label: "Bb", capacity_min: 2, capacity_max: 8, active: true, layout: { a: true } }, cancelled: [] });
      expect(await unitRow(unit.id)).toMatchObject({ capacity_min: 2, capacity_max: 8 });

      const off = await call("PATCH", `${b}/units/${plain.unit.id}`, admin, { active: false });
      expect(off.status).toBe(200);
      expect(await json(off)).toMatchObject({ unit: { id: plain.unit.id, active: false }, cancelled: [] });
      const after = (await json<{ units: UnitJson[] }>(await call("GET", `${b}/units`, admin))).units;
      expect(after).toHaveLength(8);
      expect(after.find((u) => u.id === plain.unit.id)).toMatchObject({ active: false });
    });

    it("creates a combination with its members sorted, lists and changes it, and refuses members that are not 2 to 6 distinct units of the venue", async () => {
      const S = await fresh();
      const other = await fresh();
      const b = base(S.venue);
      const [lo, hi] = [S.units[4]!, S.units[5]!].sort() as [string, string];
      const created = await call("POST", `${b}/combos`, admin, { label: "Pair", unit_ids: [hi.toUpperCase(), lo], capacity_min: 3, capacity_max: 4 });
      expect(created.status).toBe(201);
      const { combo } = await json<{ combo: ComboJson }>(created);
      expect(combo).toEqual({ id: expect.stringMatching(UUID), label: "Pair", unit_ids: [lo, hi], capacity_min: 3, capacity_max: 4, active: true });

      const listed = (await json<{ combos: ComboJson[] }>(await call("GET", `${b}/combos`, admin))).combos;
      expect(listed).toHaveLength(7);
      expect(listed.find((c) => c.id === combo.id)).toEqual(combo);
      expect(listed.map((c) => c.id)).toEqual(expect.arrayContaining(S.combos.map((c) => c.id)));

      const renamed = await call("PATCH", `${b}/combos/${combo.id}`, admin, { label: "Duo" });
      expect(renamed.status).toBe(200);
      expect(await json(renamed)).toEqual({ combo: { ...combo, label: "Duo" }, cancelled: [] });
      const off = await call("PATCH", `${b}/combos/${combo.id}`, admin, { active: false });
      expect(off.status).toBe(200);
      expect(await json(off)).toMatchObject({ combo: { active: false, label: "Duo" }, cancelled: [] });

      const before = await snapshot(S.venue);
      const otherBefore = await snapshot(other.venue);
      const bad: [string, string[]][] = [
        ["a repeated unit", [S.units[0]!, S.units[0]!]],
        ["a unit of another venue", [S.units[0]!, other.units[0]!]],
        ["an unknown unit", [S.units[0]!, ABSENT]],
      ];
      for (const [name, unit_ids] of bad) {
        const r = await call("POST", `${b}/combos`, admin, { label: "Bad", unit_ids, capacity_min: 3, capacity_max: 4 });
        expect(r.status, name).toBe(422);
        expect(r.headers.get("content-type"), name).toBe("application/problem+json");
        expect(await json(r), name).toMatchObject({ code: "assignment_mismatch", status: 422 });
      }
      expect(await snapshot(S.venue)).toEqual(before);
      expect(await snapshot(other.venue)).toEqual(otherBefore);
    });
  });

  describe("schedules", () => {
    it("creates with closes_next_day computed and the defaults applied, lists by day and opening time, and recomputes closes_next_day on a change", async () => {
      const S = await fresh();
      const b = base(S.venue);
      const night = await call("POST", `${b}/schedules`, admin, { day_of_week: 5, opens: "22:00", closes: "04:00", duration_by_size: { "2": 90, "4": 120 } });
      expect(night.status).toBe(201);
      const nightRow = (await json<{ schedule: ScheduleJson }>(night)).schedule;
      expect(nightRow).toEqual({
        id: expect.stringMatching(UUID), day_of_week: 5, opens: "22:00", closes: "04:00", closes_next_day: true,
        duration_by_size: { "2": 90, "4": 120 }, gap_minutes: 0, active: true,
      });
      const evening = (await json<{ schedule: ScheduleJson }>(await call("POST", `${b}/schedules`, admin,
        { day_of_week: 3, opens: "17:00", closes: "23:00", duration_by_size: { "2": 90 }, gap_minutes: 15, active: false }))).schedule;
      expect(evening).toMatchObject({ day_of_week: 3, closes_next_day: false, gap_minutes: 15, active: false });
      const noon = (await json<{ schedule: ScheduleJson }>(await call("POST", `${b}/schedules`, admin,
        { day_of_week: 5, opens: "12:00", closes: "16:00", duration_by_size: { "2": 60 } }))).schedule;

      const listed = await call("GET", `${b}/schedules`, admin);
      expect(listed.status).toBe(200);
      expect((await json<{ schedules: ScheduleJson[] }>(listed)).schedules).toEqual([evening, noon, nightRow]);

      const closesEarlier = await call("PATCH", `${b}/schedules/${nightRow.id}`, admin, { closes: "23:30" });
      expect(closesEarlier.status).toBe(200);
      expect(await json(closesEarlier)).toEqual({ schedule: { ...nightRow, closes: "23:30", closes_next_day: false } });
      const closesLater = await call("PATCH", `${b}/schedules/${nightRow.id}`, admin, { closes: "21:00", gap_minutes: 30, active: false });
      expect(await json(closesLater)).toEqual({ schedule: { ...nightRow, closes: "21:00", closes_next_day: true, gap_minutes: 30, active: false } });
      const stored = (await owner.query("select closes_next_day, gap_minutes, active from dastar.schedule where id = $1", [nightRow.id])).rows[0];
      expect(stored).toEqual({ closes_next_day: true, gap_minutes: 30, active: false });
    });
  });

  describe("blackouts", () => {
    it("creates active and inactive blackouts, lists those overlapping a half-open window, and changes the reason and activity", async () => {
      const S = await fresh(); const d = nextDay();
      const b = base(S.venue);
      const first = await call("POST", `${b}/blackouts`, admin, { starts_at: at(d, 10), ends_at: at(d, 14), reason: "Private event" });
      expect(first.status).toBe(201);
      const one = await json<{ blackout: BlackoutJson; cancelled: string[] }>(first);
      expect(one).toEqual({ blackout: { id: expect.stringMatching(UUID), starts_at: at(d, 10), ends_at: at(d, 14), reason: "Private event", active: true }, cancelled: [] });
      // an offset is read as the instant it names
      const second = await json<{ blackout: BlackoutJson; cancelled: string[] }>(await call("POST", `${b}/blackouts`, admin,
        { starts_at: `2064-02-${String(d).padStart(2, "0")}T12:00:00+02:00`, ends_at: `2064-02-${String(d).padStart(2, "0")}T16:00:00+02:00`, reason: "Maintenance", active: false }));
      expect(second.blackout).toMatchObject({ starts_at: new Date(Date.UTC(2064, 1, d, 10)).toISOString(), ends_at: new Date(Date.UTC(2064, 1, d, 14)).toISOString(), active: false });
      expect(second.cancelled).toEqual([]);

      const win = (from: string, to: string) => call("GET", `${b}/blackouts?from=${from}&to=${to}`, admin);
      const both = await win(at(d, 0), `2064-03-01T00:00:00Z`);
      expect(both.status).toBe(200);
      expect((await json<{ blackouts: BlackoutJson[] }>(both)).blackouts).toEqual([one.blackout, second.blackout]);
      // half-open: a window that starts where the first blackout ends does not see it, and one that ends where it starts does not either
      expect((await json<{ blackouts: BlackoutJson[] }>(await win(at(d, 14), at(d, 20)))).blackouts).toEqual([]);
      expect((await json<{ blackouts: BlackoutJson[] }>(await win(at(d, 6), at(d, 10)))).blackouts).toEqual([]);
      expect((await json<{ blackouts: BlackoutJson[] }>(await win(at(d, 13), at(d, 20)))).blackouts).toEqual([one.blackout]);

      const reason = await call("PATCH", `${b}/blackouts/${one.blackout.id}`, admin, { reason: "Closed for the day" });
      expect(reason.status).toBe(200);
      expect(await json(reason)).toEqual({ blackout: { ...one.blackout, reason: "Closed for the day" }, cancelled: [] });
      const off = await call("PATCH", `${b}/blackouts/${one.blackout.id}`, admin, { active: false });
      expect(await json(off)).toMatchObject({ blackout: { active: false, reason: "Closed for the day" }, cancelled: [] });
      const on = await call("PATCH", `${b}/blackouts/${second.blackout.id}`, admin, { active: true });
      expect(on.status).toBe(200);
      expect(await json(on)).toMatchObject({ blackout: { id: second.blackout.id, active: true }, cancelled: [] });
    });
  });

  describe("validation", () => {
    it("400 validation for a malformed body, query, or path, and nothing is written", async () => {
      const C = await withCalendar();
      const b = base(C.venue);
      const ok = { day_of_week: 2, opens: "17:00", closes: "23:00", duration_by_size: { "2": 90 } };
      const blackout = { starts_at: "2070-02-01T10:00:00Z", ends_at: "2070-02-01T12:00:00Z", reason: "Event" };
      const unitIds = [C.units[0], C.units[1]];
      const cases: [string, string, string, unknown, string][] = [
        ["capacity order on a unit", "POST", `${b}/units`, { label: "X", capacity_min: 4, capacity_max: 3 }, "capacity_max"],
        ["capacity below 1", "POST", `${b}/units`, { label: "X", capacity_min: 0, capacity_max: 3 }, "capacity_min"],
        ["capacity above 10000", "POST", `${b}/units`, { label: "X", capacity_min: 1, capacity_max: 10_001 }, "capacity_max"],
        ["an empty label", "POST", `${b}/units`, { label: "", capacity_min: 1, capacity_max: 3 }, "label"],
        ["a label of 101 characters", "POST", `${b}/units`, { label: "x".repeat(101), capacity_min: 1, capacity_max: 3 }, "label"],
        ["a layout that is not an object", "POST", `${b}/units`, { label: "X", capacity_min: 1, capacity_max: 3, layout: "flat" }, "layout"],
        ["capacity order on a unit patch", "PATCH", `${b}/units/${C.units[0]}`, { capacity_min: 5, capacity_max: 3 }, "capacity_max"],
        ["an empty cancel_reason", "PATCH", `${b}/units/${C.units[0]}`, { active: false, force: true, cancel_reason: "" }, "cancel_reason"],
        ["a cancel_reason of 201 characters", "PATCH", `${b}/units/${C.units[0]}`, { active: false, force: true, cancel_reason: "x".repeat(201) }, "cancel_reason"],
        ["force that is not a boolean", "PATCH", `${b}/units/${C.units[0]}`, { active: false, force: "yes" }, "force"],
        ["a unit id that is not a guid", "PATCH", `${b}/units/not-a-guid`, { active: false }, "unitId"],
        ["a venue id that is not a guid", "GET", `/admin/venues/not-a-guid/units`, undefined, "id"],
        ["a combination of one unit", "POST", `${b}/combos`, { label: "X", unit_ids: [C.units[0]], capacity_min: 3, capacity_max: 4 }, "unit_ids"],
        ["a combination of seven units", "POST", `${b}/combos`, { label: "X", unit_ids: [...C.units, ABSENT], capacity_min: 3, capacity_max: 4 }, "unit_ids"],
        ["a combination member that is not a guid", "POST", `${b}/combos`, { label: "X", unit_ids: [C.units[0], "nope"], capacity_min: 3, capacity_max: 4 }, "unit_ids"],
        ["capacity order on a combination", "POST", `${b}/combos`, { label: "X", unit_ids: unitIds, capacity_min: 4, capacity_max: 3 }, "capacity_max"],
        ["a combination patch with a bad reason", "PATCH", `${b}/combos/${C.combos[0]!.id}`, { active: false, force: true, cancel_reason: "" }, "cancel_reason"],
        ["opens at 24:00", "POST", `${b}/schedules`, { ...ok, opens: "24:00" }, "opens"],
        ["opens without a leading zero", "POST", `${b}/schedules`, { ...ok, opens: "9:00" }, "opens"],
        ["closes at minute 60", "POST", `${b}/schedules`, { ...ok, closes: "17:60" }, "closes"],
        ["day 0", "POST", `${b}/schedules`, { ...ok, day_of_week: 0 }, "day_of_week"],
        ["day 8", "POST", `${b}/schedules`, { ...ok, day_of_week: 8 }, "day_of_week"],
        ["no durations", "POST", `${b}/schedules`, { ...ok, duration_by_size: {} }, "duration_by_size"],
        ["a party size of 0", "POST", `${b}/schedules`, { ...ok, duration_by_size: { "0": 90 } }, "duration_by_size"],
        ["a party size of 1000", "POST", `${b}/schedules`, { ...ok, duration_by_size: { "1000": 90 } }, "duration_by_size"],
        ["a duration of 4 minutes", "POST", `${b}/schedules`, { ...ok, duration_by_size: { "2": 4 } }, "duration_by_size"],
        ["a duration of 721 minutes", "POST", `${b}/schedules`, { ...ok, duration_by_size: { "2": 721 } }, "duration_by_size"],
        ["a fractional duration", "POST", `${b}/schedules`, { ...ok, duration_by_size: { "2": 90.5 } }, "duration_by_size"],
        ["a gap of 721 minutes", "POST", `${b}/schedules`, { ...ok, gap_minutes: 721 }, "gap_minutes"],
        ["a negative gap", "POST", `${b}/schedules`, { ...ok, gap_minutes: -1 }, "gap_minutes"],
        ["no durations key", "POST", `${b}/schedules`, { day_of_week: 2, opens: "17:00", closes: "23:00" }, "duration_by_size"],
        ["a schedule patch with a bad time", "PATCH", `${b}/schedules/${C.schedule}`, { opens: "bad" }, "opens"],
        ["a blackout that ends where it starts", "POST", `${b}/blackouts`, { ...blackout, ends_at: blackout.starts_at }, "ends_at"],
        ["a blackout that ends before it starts", "POST", `${b}/blackouts`, { ...blackout, starts_at: blackout.ends_at, ends_at: blackout.starts_at }, "ends_at"],
        ["a blackout time without an offset", "POST", `${b}/blackouts`, { ...blackout, starts_at: "2070-02-01T10:00:00" }, "starts_at"],
        ["an empty reason", "POST", `${b}/blackouts`, { ...blackout, reason: "" }, "reason"],
        ["a reason of 501 characters", "POST", `${b}/blackouts`, { ...blackout, reason: "x".repeat(501) }, "reason"],
        ["a blackout patch with an empty reason", "PATCH", `${b}/blackouts/${C.blackout}`, { reason: "" }, "reason"],
        ["a listing window that ends where it starts", "GET", `${b}/blackouts?from=2070-01-01T00:00:00Z&to=2070-01-01T00:00:00Z`, undefined, "to"],
        ["a listing window that is reversed", "GET", `${b}/blackouts?from=2070-01-03T00:00:00Z&to=2070-01-01T00:00:00Z`, undefined, "to"],
        ["a listing without from", "GET", `${b}/blackouts?to=2070-01-03T00:00:00Z`, undefined, "from"],
        ["a listing time that is not a time", "GET", `${b}/blackouts?from=yesterday&to=2070-01-03T00:00:00Z`, undefined, "from"],
      ];
      const before = await snapshot(C.venue);
      for (const [name, method, path, body, field] of cases) {
        const r = await call(method, path, admin, body);
        expect(r.status, name).toBe(400);
        expect(r.headers.get("content-type"), name).toBe("application/problem+json");
        expect(await json(r), name).toMatchObject({ code: "validation", status: 400, detail: expect.stringContaining(field) });
      }
      expect(await snapshot(C.venue)).toEqual(before);
      // a body that is not JSON
      const broken = await api.app.request(`${b}/units`, { method: "POST", headers: { ...bearer(admin.key), "content-type": "application/json" }, body: "{not json" });
      expect(broken.status).toBe(400);
      expect(await json(broken)).toMatchObject({ code: "validation" });
    });

    it("422 invalid_input for what the database refuses: a NUL in a label, a capacity that contradicts the stored one, a listing window over 400 days", async () => {
      const C = await withCalendar();
      const b = base(C.venue);
      const before = await snapshot(C.venue);
      const nul = await call("POST", `${b}/units`, admin, { label: "a\u0000b", capacity_min: 1, capacity_max: 2 });
      expect(nul.status).toBe(422);
      expect(await json(nul)).toMatchObject({ code: "invalid_input", status: 422 });
      // the seed's first unit holds 1 to 4; a minimum of 5 alone is above the stored maximum
      const crossed = await call("PATCH", `${b}/units/${C.units[0]}`, admin, { capacity_min: 5 });
      expect(crossed.status).toBe(422);
      expect(await json(crossed)).toMatchObject({ code: "invalid_input" });
      const wide = await call("GET", `${b}/blackouts?from=2070-01-01T00:00:00Z&to=2071-03-01T00:00:00Z`, admin);
      expect(wide.status).toBe(422);
      expect(await json(wide)).toMatchObject({ code: "invalid_input" });
      expect(await snapshot(C.venue)).toEqual(before);
      const exact = await call("GET", `${b}/blackouts?from=2070-01-01T00:00:00Z&to=2071-02-05T00:00:00Z`, admin);
      expect(exact.status).toBe(200);
    });

    it("404 not_found for an id that does not exist, and for an entity of another venue, which is left untouched", async () => {
      const C = await withCalendar();
      const other = await withCalendar();
      const b = base(C.venue);
      const ids: [string, string, Json][] = [
        ["unit", `units`, { active: false, force: true }],
        ["combo", `combos`, { active: false, force: true }],
        ["schedule", `schedules`, { active: false }],
        ["blackout", `blackouts`, { active: false, force: true }],
      ];
      const foreign: Record<string, string> = { unit: other.units[0]!, combo: other.combos[0]!.id, schedule: other.schedule, blackout: other.blackout };
      const before = await snapshot(other.venue);
      for (const [name, segment, body] of ids) {
        for (const id of [ABSENT, foreign[name]!]) {
          const r = await call("PATCH", `${b}/${segment}/${id}`, admin, body);
          expect(r.status, `${name} ${id}`).toBe(404);
          expect(await json(r), `${name} ${id}`).toMatchObject({ code: "not_found", status: 404 });
        }
      }
      expect(await snapshot(other.venue)).toEqual(before);
    });
  });

  describe("reject or force", () => {
    it("a unit deactivation over live reservations is 409 assignment_in_use with their ids in start order and writes nothing; with force it is 200, cancels both kinds with the default reason, and returns the ids", async () => {
      const S = await fresh(); const d = nextDay();
      const onUnit = await placeHold(S.venue, at(d, 19), { unit: S.units[0]! });
      // combination C12 contains units[0] and units[1]; a party of 6 needs a combination
      const onCombo = await placeHold(S.venue, at(d + 1, 19), { assignment: { kind: "combo", id: S.combos[0]!.id }, party: 6 });
      const path = `${base(S.venue)}/units/${S.units[0]}`;

      const refused = await call("PATCH", path, admin, { active: false });
      expect(refused.status).toBe(409);
      expect(refused.headers.get("content-type")).toBe("application/problem+json");
      expect(await json(refused)).toMatchObject({
        type: "https://dastar.dev/errors/assignment_in_use", code: "assignment_in_use", status: 409,
        detail: "this change to unit T1 would strand 2 live reservations; cancel them or retry with force",
        stranded: [onUnit, onCombo],
      });
      expect((await unitRow(S.units[0]!)).active).toBe(true);
      expect((await stored(onUnit)).status).toBe("held");
      expect((await stored(onCombo)).status).toBe("held");

      const forced = await call("PATCH", path, admin, { active: false, force: true });
      expect(forced.status).toBe(200);
      expect(await json(forced)).toMatchObject({ unit: { id: S.units[0], active: false }, cancelled: [onUnit, onCombo].sort() });
      expect((await unitRow(S.units[0]!)).active).toBe(false);
      expect(await stored(onUnit)).toEqual({ status: "cancelled", cancel_reason: "venue change" });
      expect(await stored(onCombo)).toEqual({ status: "cancelled", cancel_reason: "venue change" });
    });

    it("a forced change records the key as the actor and the request's trace id, gives the reason, and queues one reservation.cancelled event each", async () => {
      const S = await fresh(); const d = nextDay();
      const id = await placeHold(S.venue, at(d, 19), { unit: S.units[0]! });
      const r = await call("PATCH", `${base(S.venue)}/units/${S.units[0]}`, admin, { active: false, force: true, cancel_reason: "renovation" }, { "x-trace-id": "trace-admin-force" });
      expect(r.status).toBe(200);
      expect((await json<{ cancelled: string[] }>(r)).cancelled).toEqual([id]);
      expect(await stored(id)).toEqual({ status: "cancelled", cancel_reason: "renovation" });
      expect(await cancelEvents(id)).toBe(1);
      const audit = (await owner.query("select actor, trace_id from dastar.audit_log where entity_id = $1 and action like 'update:%>cancelled'", [id])).rows;
      expect(audit).toEqual([{ actor: `key:${admin.id}`, trace_id: "trace-admin-force" }]);
    });

    it("a capacity range that strands a live party is 409 capacity_conflict and writes nothing; widening is 200; with force it cancels the party and narrows", async () => {
      const S = await fresh(); const d = nextDay();
      const party4 = await placeHold(S.venue, at(d, 19), { unit: S.units[0]!, party: 4 });
      const path = `${base(S.venue)}/units/${S.units[0]}`;

      const refused = await call("PATCH", path, admin, { capacity_max: 3 });
      expect(refused.status).toBe(409);
      expect(await json(refused)).toMatchObject({
        code: "capacity_conflict", status: 409, stranded: [party4],
        detail: "this change to unit T1 would strand 1 live reservation; cancel them or retry with force",
      });
      expect(await unitRow(S.units[0]!)).toMatchObject({ capacity_max: 4 });
      expect((await stored(party4)).status).toBe("held");

      const widened = await call("PATCH", path, admin, { capacity_max: 6 });
      expect(widened.status).toBe(200);
      expect(await json(widened)).toMatchObject({ unit: { capacity_max: 6 }, cancelled: [] });

      const forced = await call("PATCH", path, admin, { capacity_max: 3, force: true });
      expect(forced.status).toBe(200);
      expect(await json(forced)).toMatchObject({ unit: { capacity_min: 1, capacity_max: 3 }, cancelled: [party4] });
      expect(await stored(party4)).toEqual({ status: "cancelled", cancel_reason: "venue change" });
      expect(await unitRow(S.units[0]!)).toMatchObject({ capacity_max: 3 });
    });

    it("a combination deactivation is judged by the reservations assigned to the combination, not those of its member units", async () => {
      const S = await fresh(); const d = nextDay();
      const onCombo = await placeHold(S.venue, at(d, 19), { assignment: { kind: "combo", id: S.combos[0]!.id }, party: 6 });
      const onMember = await placeHold(S.venue, at(d + 1, 19), { unit: S.units[1]! });
      const path = `${base(S.venue)}/combos/${S.combos[0]!.id}`;

      const refused = await call("PATCH", path, admin, { active: false });
      expect(refused.status).toBe(409);
      expect(await json(refused)).toMatchObject({ code: "assignment_in_use", stranded: [onCombo] });
      expect(await count("select count(*)::int as n from dastar.unit_combo where id = $1 and active", [S.combos[0]!.id])).toBe(1);

      const forced = await call("PATCH", path, admin, { active: false, force: true, cancel_reason: "retired" });
      expect(forced.status).toBe(200);
      expect(await json(forced)).toMatchObject({ combo: { id: S.combos[0]!.id, active: false }, cancelled: [onCombo] });
      expect(await stored(onCombo)).toEqual({ status: "cancelled", cancel_reason: "retired" });
      expect((await stored(onMember)).status).toBe("held");
    });

    it("a blackout over a live reservation is 409 blackout_conflict and stores nothing; with force it is 201, cancels the reservation, and returns its id", async () => {
      const S = await fresh(); const d = nextDay();
      const id = await placeHold(S.venue, at(d, 19), { unit: S.units[0]! });
      const b = `${base(S.venue)}/blackouts`;
      const body = { starts_at: at(d, 18), ends_at: at(d, 22), reason: "Closed" };

      const refused = await call("POST", b, admin, body);
      expect(refused.status).toBe(409);
      expect(refused.headers.get("content-type")).toBe("application/problem+json");
      expect(await json(refused)).toMatchObject({ type: "https://dastar.dev/errors/blackout_conflict", code: "blackout_conflict", status: 409, stranded: [id] });
      expect(await count("select count(*)::int as n from dastar.blackout where venue_id = $1", [S.venue])).toBe(0);
      expect((await stored(id)).status).toBe("held");

      const forced = await call("POST", b, admin, { ...body, force: true });
      expect(forced.status).toBe(201);
      expect(await json(forced)).toEqual({ blackout: { id: expect.stringMatching(UUID), starts_at: at(d, 18), ends_at: at(d, 22), reason: "Closed", active: true }, cancelled: [id] });
      expect(await count("select count(*)::int as n from dastar.blackout where venue_id = $1 and active", [S.venue])).toBe(1);
      expect(await stored(id)).toEqual({ status: "cancelled", cancel_reason: "venue change" });
      expect(await cancelEvents(id)).toBe(1);
    });

    it("an inactive blackout over a live reservation is created without judgment, a reason change is never judged, and activating it is judged: 409, then 200 with force", async () => {
      const S = await fresh(); const d = nextDay();
      const id = await placeHold(S.venue, at(d, 19), { unit: S.units[0]! });
      const b = `${base(S.venue)}/blackouts`;
      const created = await call("POST", b, admin, { starts_at: at(d, 18), ends_at: at(d, 22), reason: "Maybe", active: false });
      expect(created.status).toBe(201);
      const blackout = (await json<{ blackout: BlackoutJson; cancelled: string[] }>(created));
      expect(blackout.cancelled).toEqual([]);
      expect((await stored(id)).status).toBe("held");

      const path = `${b}/${blackout.blackout.id}`;
      const renamed = await call("PATCH", path, admin, { reason: "Perhaps" });
      expect(renamed.status).toBe(200);
      expect(await json(renamed)).toMatchObject({ blackout: { reason: "Perhaps", active: false }, cancelled: [] });

      const refused = await call("PATCH", path, admin, { active: true });
      expect(refused.status).toBe(409);
      expect(await json(refused)).toMatchObject({ code: "blackout_conflict", stranded: [id] });
      expect(await count("select count(*)::int as n from dastar.blackout where id = $1 and active", [blackout.blackout.id])).toBe(0);
      expect((await stored(id)).status).toBe("held");

      const forced = await call("PATCH", path, admin, { active: true, force: true, cancel_reason: "closed" });
      expect(forced.status).toBe(200);
      expect(await json(forced)).toMatchObject({ blackout: { id: blackout.blackout.id, active: true }, cancelled: [id] });
      expect(await stored(id)).toEqual({ status: "cancelled", cancel_reason: "closed" });
    });

    it("force over more than 200 live reservations is 422 force_too_large naming the 201 earliest, and cancels nothing", async () => {
      const S = await fresh();
      // one reservation a day on one unit, each by an actor of its own, so no per-actor cap and no overlap
      const ids: string[] = [];
      for (let i = 0; i < 202; i++) {
        n += 1;
        const out = await api.dastar.hold({
          venueId: S.venue, actor: `key:big${i}`, traceId: `admin-big${i}`, idempotencyKey: `admin-big-${n}`, partySize: 2,
          startsAt: new Date(Date.UTC(2065, 0, 1 + i, 19)).toISOString(), durationMinutes: 90, assignment: { kind: "unit", id: S.units[0]! },
        });
        if (!out.ok) throw new Error(out.error.code);
        ids.push(out.receipt.reservationId);
      }
      const path = `${base(S.venue)}/units/${S.units[0]}`;
      const refused = await call("PATCH", path, admin, { active: false, force: true });
      expect(refused.status).toBe(422);
      expect(refused.headers.get("content-type")).toBe("application/problem+json");
      const body = await json<{ stranded: string[] }>(refused);
      expect(body).toMatchObject({
        code: "force_too_large", status: 422,
        detail: "force cancels at most 200 reservations; this change to unit T1 would strand more than 200",
      });
      expect(body.stranded).toHaveLength(201);
      expect(body.stranded).toEqual(ids.slice(0, 201));
      expect(await count("select count(*)::int as n from dastar.reservation where venue_id = $1 and status = 'held'", [S.venue])).toBe(202);
      expect((await unitRow(S.units[0]!)).active).toBe(true);
    });

    it("force over a reservation that has started is 409 reservation_in_progress naming only the started ones, and cancels nothing", async () => {
      const S = await fresh(); const d = nextDay();
      // confirmed reservations: a hold whose start has passed by the moved clock is also past its expiry, so it is not live
      const first = await placeConfirmed(S.venue, at(d, 19), S.units[0]!);
      const second = await placeConfirmed(S.venue, at(d + 1, 19), S.units[0]!);
      const path = `${base(S.venue)}/units/${S.units[0]}`;
      const atClock = async <T>(iso: string, fn: () => Promise<T>): Promise<T> => {
        await clocked.pool.query("select set_config('dastar.now', $1, false)", [iso]);
        try { return await fn(); } finally { await clocked.pool.query("select set_config('dastar.now', '', false)"); }
      };
      await atClock(at(d, 19, 1), async () => {
        // control: without force both are stranded, started or not
        const plain = await request(clocked.app, "PATCH", path, admin, { active: false });
        expect(plain.status).toBe(409);
        expect(await json(plain)).toMatchObject({ code: "assignment_in_use", stranded: [first, second] });
        const forced = await request(clocked.app, "PATCH", path, admin, { active: false, force: true });
        expect(forced.status).toBe(409);
        expect(await json(forced)).toMatchObject({
          code: "reservation_in_progress", status: 409, stranded: [first], detail: "1 stranded reservation has already started; close it first",
        });
      });
      expect((await stored(first)).status).toBe("confirmed");
      expect((await stored(second)).status).toBe("confirmed");
      expect((await unitRow(S.units[0]!)).active).toBe(true);
      expect(await cancelEvents(first)).toBe(0);

      // by the real clock neither has started, so the same forced change cancels both
      const control = await call("PATCH", path, admin, { active: false, force: true });
      expect(control.status).toBe(200);
      expect((await json<{ cancelled: string[] }>(control)).cancelled).toEqual([first, second].sort());
    });
  });
});

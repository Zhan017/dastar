import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedVenue, type Seed } from "../../../packages/db/test/helpers/seed.js";
import { createKey } from "../src/auth.js";
import { makeApi, bearer, jsonInit } from "./helpers.js";

type ApiSlot = { starts_at: string; duration_minutes: number; assignment: { kind: string; id: string } };
type Offer = { slots: ApiSlot[]; truncated: boolean };
type Key = { id: string; key: string };

describe("POST /v1/venues/{id}/availability", () => {
  let conn: Conn; let owner: Client; let api: ReturnType<typeof makeApi>;
  let reader: Key; let n = 0; let dayN = 0;
  const NIL = "00000000-0000-0000-0000-000000000000";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  beforeAll(async () => {
    conn = await cloneDatabase("api_availability_test");
    owner = await connect(conn.owner);
    api = makeApi(conn);
    reader = await createKey(api.pool, { label: "reader", capabilities: ["read", "hold"] });
  });
  afterAll(async () => { await api.close(); await owner.end(); await dropDatabase("api_availability_test"); });

  /** A fresh day of January 2063 for each scenario; a scenario also gets a venue of its own, so no schedule or hold of another is in its way. */
  const nextDay = (): number => ++dayN;
  const at = (day: number, hour: number, minute = 0): string => new Date(Date.UTC(2063, 0, day, hour, minute)).toISOString();
  /** ISO weekday of a day of January 2063: Monday is 1, Sunday is 7. */
  const isoDow = (day: number): number => new Date(Date.UTC(2063, 0, day)).getUTCDay() || 7;
  const DURATIONS = '{"2":90,"4":120,"8":150}';

  /** The seed venue as a UTC venue, so a local time is its UTC time; the seed's venue is in Berlin. */
  async function utcVenue(windowDays?: number): Promise<Seed> {
    const seed = await seedVenue(owner);
    await owner.query("update dastar.venue set timezone = 'UTC', availability_window_days = coalesce($2, availability_window_days) where id = $1", [seed.venue, windowDays ?? null]);
    return seed;
  }
  /** A UTC venue with one service period, 17:00 to 23:00 on the weekday of `day`, written by the owner. */
  async function venueWithPeriod(day: number, windowDays?: number): Promise<Seed> {
    const seed = await utcVenue(windowDays);
    await owner.query(
      `insert into dastar.schedule(venue_id, day_of_week, opens, closes, closes_next_day, duration_by_size, gap_minutes)
       values ($1, $2, '17:00'::time, '23:00'::time, false, $3::jsonb, 0)`,
      [seed.venue, isoDow(day), DURATIONS],
    );
    return seed;
  }

  const ask = (venue: string, body: unknown, key: Key | null = reader) =>
    api.app.request(`/v1/venues/${venue}/availability`, jsonInit("POST", body, key === null ? {} : bearer(key.key)));
  const win = (day: number, over: Record<string, unknown> = {}) => ({ party_size: 2, from: at(day, 0), to: at(day + 1, 0), ...over });
  async function offered(venue: string, body: unknown, key: Key | null = reader): Promise<Offer> {
    const r = await ask(venue, body, key);
    expect(r.status).toBe(200);
    return await r.json() as Offer;
  }
  const holdSlot = (venue: string, slot: ApiSlot, partySize: number, key: Key = reader) => {
    n += 1;
    return api.app.request(`/v1/venues/${venue}/holds`, jsonInit("POST",
      { party_size: partySize, starts_at: slot.starts_at, duration_minutes: slot.duration_minutes, assignment: slot.assignment },
      { ...bearer(key.key), "idempotency-key": `avail-${n}` }));
  };

  it("lists the bookable slots in start order, each shaped as a hold body, and a hold accepts one unchanged", async () => {
    const day = nextDay();
    const V = await venueWithPeriod(day);
    const r = await ask(V.venue, win(day));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(api.lines.at(-1)).toMatchObject({ method: "POST", path: `/v1/venues/${V.venue}/availability`, status: 200, key_id: reader.id });
    const out = await r.json() as Offer;

    // 17:00 to 21:30 every 15 minutes: a 90-minute booking must end by 23:00
    expect(out.truncated).toBe(false);
    expect(out.slots).toHaveLength(19);
    expect(out.slots[0]!.starts_at).toBe(at(day, 17));
    expect(out.slots.at(-1)!.starts_at).toBe(at(day, 21, 30));
    const starts = out.slots.map((s) => Date.parse(s.starts_at));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(new Set(starts).size).toBe(starts.length);
    for (const s of out.slots) {
      expect(s).toEqual({ starts_at: expect.stringMatching(/^2063-01-\d\dT\d\d:\d\d:00\.000Z$/), duration_minutes: 90, assignment: { kind: "unit", id: expect.stringMatching(UUID) } });
      expect(V.units).toContain(s.assignment.id);
    }

    const chosen = out.slots[6]!;
    const held = await holdSlot(V.venue, chosen, 2);
    expect(held.status).toBe(201);
    expect(await held.json()).toMatchObject({ receipt: { status: "held" }, replayed: false });

    // the read follows live occupancy: the same start is now offered on another unit
    const after = await offered(V.venue, win(day));
    const sameStart = after.slots.find((s) => s.starts_at === chosen.starts_at);
    expect(sameStart).toBeDefined();
    expect(sameStart!.assignment).not.toEqual(chosen.assignment);
  });

  it("offers a combination to a party of 6 with the duration of the smallest key at or above it, and a hold accepts it", async () => {
    const day = nextDay();
    const V = await venueWithPeriod(day);
    const out = await offered(V.venue, win(day, { party_size: 6 }));
    // 17:00 to 20:30 every 15 minutes: a 150-minute booking must end by 23:00
    expect(out.slots).toHaveLength(15);
    expect(out.slots.at(-1)!.starts_at).toBe(at(day, 20, 30));
    for (const s of out.slots) {
      expect(s.duration_minutes).toBe(150);
      expect(s.assignment.kind).toBe("combo");
      expect(V.combos.map((c) => c.id)).toContain(s.assignment.id);
    }
    expect((await holdSlot(V.venue, out.slots[0]!, 6)).status).toBe(201);
  });

  it("truncated is true when the limit cuts the list, and the cut keeps the first start", async () => {
    const day = nextDay();
    const V = await venueWithPeriod(day);
    const out = await offered(V.venue, win(day, { limit: 1 }));
    expect(out.truncated).toBe(true);
    expect(out.slots).toHaveLength(1);
    expect(out.slots[0]!.starts_at).toBe(at(day, 17));
    const two = await offered(V.venue, win(day, { limit: 19 }));
    expect(two.truncated).toBe(false);
    expect(two.slots).toHaveLength(19);
  });

  it("a venue without service periods offers nothing, and the answer is not an error", async () => {
    const day = nextDay();
    const V = await utcVenue();
    expect(await offered(V.venue, win(day))).toEqual({ slots: [], truncated: false });
  });

  it("403 without the read capability, 401 without a key", async () => {
    const day = nextDay();
    const V = await venueWithPeriod(day);
    const writer = await createKey(api.pool, { label: "hold only", capabilities: ["hold"] });
    const denied = await ask(V.venue, win(day), writer);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "forbidden" });
    const anonymous = await ask(V.venue, win(day), null);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ code: "unauthorized" });
  });

  it("404 for a venue outside the key's venues, and a key scoped to the venue reads it", async () => {
    const day = nextDay();
    const V = await venueWithPeriod(day);
    const away = await createKey(api.pool, { label: "away", capabilities: ["read"], venueIds: ["01a0b07c-189a-70cb-a39e-1f679b38fe4d"] });
    const hidden = await ask(V.venue, win(day), away);
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toMatchObject({ code: "not_found" });
    const scoped = await createKey(api.pool, { label: "scoped", capabilities: ["read"], venueIds: [V.venue] });
    expect((await offered(V.venue, win(day), scoped)).slots).toHaveLength(19);
  });

  it("404 not_found for a venue that does not exist, with a key for all venues", async () => {
    const day = nextDay();
    const r = await ask(NIL, win(day));
    expect(r.status).toBe(404);
    expect(await r.json()).toMatchObject({ code: "not_found" });
  });

  it("400 validation when from is not before to", async () => {
    const day = nextDay();
    const V = await venueWithPeriod(day);
    const same = await ask(V.venue, win(day, { to: at(day, 0) }));
    expect(same.status).toBe(400);
    expect(await same.json()).toMatchObject({ code: "validation", detail: expect.stringContaining("from must be before to") });
    const reversed = await ask(V.venue, win(day, { from: at(day + 1, 0), to: at(day, 0) }));
    expect(reversed.status).toBe(400);
    expect(await reversed.json()).toMatchObject({ code: "validation", detail: expect.stringContaining("from must be before to") });
    // the same instant written with two offsets is not before itself
    const offsets = await ask(V.venue, win(day, { from: "2063-01-10T12:00:00+02:00", to: "2063-01-10T10:00:00Z" }));
    expect(offsets.status).toBe(400);
    expect(await offsets.json()).toMatchObject({ code: "validation" });
    const ok = await ask(V.venue, win(day, { from: "2063-01-10T12:00:00+02:00", to: "2063-01-10T10:00:01Z" }));
    expect(ok.status).toBe(200);
  });

  it("400 validation for a party size outside 1 to 10000, a limit outside 1 to 500, and a malformed body", async () => {
    const day = nextDay();
    const V = await venueWithPeriod(day);
    const zero = await ask(V.venue, win(day, { party_size: 0 }));
    expect(zero.status).toBe(400);
    expect(await zero.json()).toMatchObject({ code: "validation", detail: expect.stringContaining("party_size") });
    for (const bad of [{ party_size: 10_001 }, { party_size: 1.5 }, { limit: 501 }, { limit: 0 }, { limit: 2.5 }, { from: "2063-01-10 12:00" }, { to: 5 }]) {
      const r = await ask(V.venue, win(day, bad));
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(await r.json()).toMatchObject({ code: "validation" });
    }
    const tooMany = await ask(V.venue, win(day, { limit: 501 }));
    expect(await tooMany.json()).toMatchObject({ detail: expect.stringContaining("limit") });
    expect((await ask(V.venue, win(day, { limit: 500 }))).status).toBe(200);
    expect((await ask(V.venue, win(day, { party_size: 10_000 }))).status).toBe(200);
    expect((await ask(V.venue, { party_size: 2, from: at(day, 0) })).status).toBe(400);
    const notJson = await api.app.request(`/v1/venues/${V.venue}/availability`, { method: "POST", headers: { ...bearer(reader.key), "content-type": "application/json" }, body: "{not json" });
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ code: "validation" });
    expect((await api.app.request("/v1/venues/not-a-uuid/availability", jsonInit("POST", win(day), bearer(reader.key)))).status).toBe(400);
  });

  it("422 window_too_large for a window longer than the venue's availability window, and a window of exactly that length is read", async () => {
    const day = nextDay();
    const V = await venueWithPeriod(day, 3);
    const tooLong = await ask(V.venue, win(day, { to: at(day + 3, 0, 1) }));
    expect(tooLong.status).toBe(422);
    expect(tooLong.headers.get("content-type")).toBe("application/problem+json");
    expect(await tooLong.json()).toMatchObject({ code: "window_too_large", status: 422, type: "https://dastar.dev/errors/window_too_large" });
    const exact = await offered(V.venue, win(day, { to: at(day + 3, 0) }));
    expect(exact.slots.length).toBeGreaterThan(0);
  });
});

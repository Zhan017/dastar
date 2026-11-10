import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { createDastarClient, type DastarClient } from "@dastar/client";
import { createToolSession, type HoldArgs, type ToolResult, type ToolSession } from "@dastar/agent-tools";
import { cloneDatabase, dropDatabase, connect, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedVenue, type Seed } from "../../../packages/db/test/helpers/seed.js";
import { createKey } from "../src/auth.js";
import { makeApi } from "./helpers.js";

type Slot = { starts_at: string; duration_minutes: number; assignment: { kind: "unit" | "combo"; id: string } };
type Held = { receipt: { reservation_id: string; status: string }; hold_expires_at: string; replayed: boolean; current_status?: string };

describe("@dastar/agent-tools against the reference API", () => {
  let conn: Conn; let owner: Client; let seed: Seed; let other: Seed; let api: ReturnType<typeof makeApi>;
  let keyA: string; let a: ToolSession; let b: ToolSession; let frontDesk: DastarClient;
  let client: (key: string) => DastarClient;
  const results: ToolResult[] = [];
  const keep = (r: ToolResult): ToolResult => { results.push(r); return r; };
  const heldId = (r: ToolResult): string => (r.structured as Held).receipt.reservation_id;
  // 2064-01-07 is a Monday; the schedule below opens 17:00 to 23:00 in Berlin, 16:00 to 22:00 UTC in January
  const at = (hhmm: string, unit: string): HoldArgs => ({ party_size: 2, starts_at: `2064-01-07T${hhmm}:00Z`, duration_minutes: 90, assignment: { kind: "unit", id: unit } });

  beforeAll(async () => {
    conn = await cloneDatabase("api_agent_tools_test");
    owner = await connect(conn.owner);
    seed = await seedVenue(owner);
    other = await seedVenue(owner);
    api = makeApi(conn);
    const fetch = async (request: Request): Promise<Response> => api.app.request(request);
    client = (key: string) => createDastarClient({ baseUrl: "http://dastar.test", fetch, key });
    const make = async (label: string, capabilities: string[], venueIds = [seed.venue]) => (await createKey(api.pool, { label, capabilities, venueIds })).key;
    const admin = client(await make("admin", ["admin"]));
    const schedule = await admin.POST("/admin/venues/{id}/schedules", {
      params: { path: { id: seed.venue } },
      body: { day_of_week: 1, opens: "17:00", closes: "23:00", duration_by_size: { "2": 90 } },
    });
    expect(schedule.error).toBeUndefined();
    keyA = await make("agent a", ["read", "hold", "cancel"], [seed.venue, other.venue]);
    a = createToolSession({ client: client(keyA), venueId: seed.venue });
    b = createToolSession({ client: client(await make("agent b", ["read", "hold", "cancel"])), venueId: seed.venue });
    frontDesk = client(await make("front desk", ["read", "confirm"]));
  });
  afterAll(async () => { await api.close(); await owner.end(); await dropDatabase("api_agent_tools_test"); });

  it("searches, holds, replays the same hold however it is spelled, cancels its own, and holds anew after", async () => {
    const found = keep(await a.searchAvailability({ party_size: 2, from: "2064-01-07T00:00:00Z", to: "2064-01-08T00:00:00Z", limit: 5 }));
    expect(found.isError).toBe(false);
    const slot = (found.structured as { slots: Slot[] }).slots[0]!;
    const request: HoldArgs = { party_size: 2, starts_at: slot.starts_at, duration_minutes: slot.duration_minutes, assignment: slot.assignment };
    const held = keep(await a.hold(request));
    expect(held.structured).toMatchObject({ replayed: false, receipt: { status: "held" } });
    const id = heldId(held);

    const respelled: HoldArgs = { ...request, starts_at: new Date(slot.starts_at).toISOString().replace("Z", "+00:00"), assignment: { ...slot.assignment, id: slot.assignment.id.toUpperCase() } };
    const again = keep(await a.hold(respelled));
    expect(again.structured).toMatchObject({ replayed: true, current_status: "held", receipt: { reservation_id: id } });

    const cancelled = keep(await a.cancel({ reservation_id: id, reason: "plans changed" }));
    expect(cancelled.structured).toMatchObject({ receipt: { reservation_id: id, status: "cancelled" } });
    const anew = keep(await a.hold(request));
    expect(anew.structured).toMatchObject({ replayed: false, receipt: { status: "held" } });
    expect(heldId(anew)).not.toBe(id);
  });

  it("reports a hold the venue confirmed meanwhile as confirmed, and cancels it as its own", async () => {
    const request = at("18:00", seed.units[0]!);
    const id = heldId(keep(await a.hold(request)));
    const confirmed = await frontDesk.POST("/v1/reservations/{id}/confirm", { params: { path: { id } }, body: {} });
    expect(confirmed.data?.receipt).toMatchObject({ reservation_id: id, status: "confirmed" });
    const again = keep(await a.hold(request));
    expect(again).toMatchObject({ isError: false, structured: { replayed: true, current_status: "confirmed" } });
    expect(again.text.split("\n")[0]).toBe(`This hold was already made: reservation ${id} is confirmed now.`);
    const cancelled = keep(await a.cancel({ reservation_id: id, reason: "plans changed" }));
    expect(cancelled.structured).toMatchObject({ receipt: { reservation_id: id, status: "cancelled" } });
  });

  it("refuses to cancel another key's hold, which stays held, and a hold on its slot conflicts", async () => {
    const request = at("18:00", seed.units[1]!);
    const theirs = heldId(keep(await b.hold(request)));
    const refused = keep(await a.cancel({ reservation_id: theirs, reason: "not mine" }));
    expect(refused).toMatchObject({ isError: true, structured: { code: "not_created_in_session", reservation_id: theirs } });
    const still = keep(await b.getReservation({ reservation_id: theirs }));
    expect(still.structured).toMatchObject({ id: theirs, status: "held" });
    const taken = keep(await a.hold(request));
    expect(taken).toMatchObject({ isError: true, structured: { code: "hold_conflict", status: 409 } });
  });

  it("two identical holds at once make one reservation", async () => {
    const request = at("20:00", seed.units[2]!);
    const both = (await Promise.all([a.hold(request), a.hold(request)])).map(keep);
    const ok = both.filter((r) => !r.isError);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map(heldId)).size).toBe(1);
    for (const r of both.filter((r) => r.isError)) expect(r.structured.code).toBe("serialization_conflict");
  });

  it("reads a reservation of another venue as not_found", async () => {
    const elsewhere = createToolSession({ client: client(keyA), venueId: other.venue });
    const id = heldId(keep(await elsewhere.hold(at("16:00", other.units[0]!))));
    const read = keep(await a.getReservation({ reservation_id: id }));
    expect(read).toMatchObject({ isError: true, structured: { code: "not_found", status: 404 } });
  });

  it("no result carries a token", () => {
    expect(results.length).toBeGreaterThanOrEqual(15);
    const keysIn = (v: unknown): string[] =>
      v === null || typeof v !== "object" ? [] : Array.isArray(v) ? v.flatMap(keysIn) : Object.entries(v).flatMap(([k, x]) => [k, ...keysIn(x)]);
    for (const r of results) {
      expect(r.text).not.toMatch(/token/i);
      expect(keysIn(r.structured).filter((k) => /token/i.test(k))).toEqual([]);
    }
  });
});

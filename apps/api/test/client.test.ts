import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { createDastarClient, type DastarClient, type Problem } from "@dastar/client";
import { cloneDatabase, dropDatabase, connect, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedVenue, type Seed } from "../../../packages/db/test/helpers/seed.js";
import { createKey } from "../src/auth.js";
import { makeApi } from "./helpers.js";

describe("@dastar/client against the reference API", () => {
  let conn: Conn; let owner: Client; let seed: Seed; let api: ReturnType<typeof makeApi>;
  let admin: DastarClient; let agent: DastarClient; let anonymous: DastarClient;

  beforeAll(async () => {
    conn = await cloneDatabase("api_client_test");
    owner = await connect(conn.owner);
    seed = await seedVenue(owner);
    api = makeApi(conn);
    // the client's requests go to the app in process, as they would over HTTP
    const fetch = async (request: Request): Promise<Response> => api.app.request(request);
    const client = (key?: string): DastarClient => createDastarClient({ baseUrl: "http://dastar.test", fetch, key });
    admin = client((await createKey(api.pool, { label: "admin", capabilities: ["admin"], venueIds: [seed.venue] })).key);
    agent = client((await createKey(api.pool, { label: "agent", capabilities: ["read", "hold", "confirm", "cancel"], venueIds: [seed.venue] })).key);
    anonymous = client();
  });
  afterAll(async () => { await api.close(); await owner.end(); await dropDatabase("api_client_test"); });

  it("books through the typed paths: a schedule, availability, a hold, a conflict, a token, a confirmation, a cancellation", async () => {
    // 2064-01-07 is a Monday; the seed venue is in Berlin, where 17:00 to 23:00 is 16:00 to 22:00 UTC in January
    const schedule = await admin.POST("/admin/venues/{id}/schedules", {
      params: { path: { id: seed.venue } },
      body: { day_of_week: 1, opens: "17:00", closes: "23:00", duration_by_size: { "2": 90 } },
    });
    expect(schedule.error).toBeUndefined();
    expect(schedule.data?.schedule).toMatchObject({ day_of_week: 1, opens: "17:00", closes: "23:00", closes_next_day: false });

    const offer = await agent.POST("/v1/venues/{id}/availability", {
      params: { path: { id: seed.venue } },
      body: { party_size: 2, from: "2064-01-07T00:00:00Z", to: "2064-01-08T00:00:00Z", limit: 5 },
    });
    if (offer.error) throw new Error(offer.error.code);
    expect(offer.data.slots).toHaveLength(5);
    const slot = offer.data.slots[0]!;
    expect(Date.parse(slot.starts_at)).toBeGreaterThanOrEqual(Date.parse("2064-01-07T16:00:00Z"));
    expect(slot.duration_minutes).toBe(90);

    const request = { party_size: 2, starts_at: slot.starts_at, duration_minutes: slot.duration_minutes, assignment: slot.assignment };
    const held = await agent.POST("/v1/venues/{id}/holds", { params: { path: { id: seed.venue }, header: { "idempotency-key": "client-1" } }, body: request });
    if (held.error) throw new Error(held.error.code);
    expect(held.response.status).toBe(201);
    expect(held.data.receipt.status).toBe("held");
    const id = held.data.receipt.reservation_id;

    const taken = await agent.POST("/v1/venues/{id}/holds", { params: { path: { id: seed.venue }, header: { "idempotency-key": "client-2" } }, body: request });
    const problem: Problem | undefined = taken.error;
    expect(taken.response.status).toBe(409);
    expect(problem).toMatchObject({ code: "hold_conflict", status: 409 });

    const read = await agent.GET("/v1/reservations/{id}", { params: { path: { id } } });
    expect(read.data).toMatchObject({ id, status: "held", party_size: 2 });

    const minted = await agent.POST("/v1/reservations/{id}/confirm-token", { params: { path: { id } }, body: {} });
    if (minted.error) throw new Error(minted.error.code);
    const confirmed = await anonymous.POST("/v1/reservations/{id}/confirm", { params: { path: { id } }, body: { confirm_token: minted.data.confirm_token } });
    expect(confirmed.error).toBeUndefined();
    expect(confirmed.data?.receipt).toMatchObject({ reservation_id: id, status: "confirmed" });

    const cancelled = await agent.POST("/v1/reservations/{id}/cancel", { params: { path: { id } }, body: { reason: "plans changed" } });
    expect(cancelled.data?.receipt).toMatchObject({ reservation_id: id, status: "cancelled" });
  });

  it("a client without a key is refused where a key is required", async () => {
    const r = await anonymous.GET("/v1/venues/{id}/holds", { params: { path: { id: seed.venue } } });
    expect(r.response.status).toBe(401);
    expect(r.error?.code).toBe("unauthorized");
  });

  it("the generated types require the idempotency header on a hold", () => {
    // never called: the line only has to fail to compile without the header, which tsc checks
    const call = () =>
      // @ts-expect-error the hold route declares idempotency-key as a required header
      agent.POST("/v1/venues/{id}/holds", { params: { path: { id: seed.venue } }, body: { party_size: 2, starts_at: "2064-01-07T16:00:00Z", duration_minutes: 90, assignment: { kind: "unit", id: seed.units[0]! } } });
    expect(typeof call).toBe("function");
  });
});

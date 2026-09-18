import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedVenue, type Seed } from "../../../packages/db/test/helpers/seed.js";
import { createKey } from "../src/auth.js";
import { makeApi, bearer, jsonInit } from "./helpers.js";

const NIL = "00000000-0000-0000-0000-000000000000";
type Key = { id: string; key: string };

describe("reservation routes", () => {
  let conn: Conn; let owner: Client; let seed: Seed; let api: ReturnType<typeof makeApi>;
  let staff: Key; let agent: Key; let elsewhere: Key; let holder: Key; let n = 0;

  beforeAll(async () => {
    conn = await cloneDatabase("api_reservations_test");
    owner = await connect(conn.owner);
    seed = await seedVenue(owner);
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100 where id = $1", [seed.venue]);
    api = makeApi(conn);
    staff = await createKey(api.pool, { label: "staff", capabilities: ["hold", "confirm", "cancel", "read"] });
    agent = await createKey(api.pool, { label: "agent", capabilities: ["hold", "read"] });
    holder = await createKey(api.pool, { label: "holder", capabilities: ["hold"] });
    elsewhere = await createKey(api.pool, { label: "elsewhere", capabilities: ["hold", "confirm", "cancel", "read"], venueIds: ["01a0b07c-189a-70cb-a39e-1f679b38fe4d"] });
  });
  afterAll(async () => { await api.close(); await owner.end(); await dropDatabase("api_reservations_test"); });

  async function held(): Promise<string> {
    n += 1;
    const start = new Date(Date.UTC(2046, 0, 1 + Math.floor(n / 8), 8 + (n % 8)));
    const r = await api.app.request(`/v1/venues/${seed.venue}/holds`, jsonInit("POST", { party_size: 2, starts_at: start.toISOString(), duration_minutes: 60, assignment: { kind: "unit", id: seed.units[0] } }, { ...bearer(agent.key), "idempotency-key": `r${n}` }));
    expect(r.status).toBe(201);
    return (await r.json() as { receipt: { reservation_id: string } }).receipt.reservation_id;
  }
  const get = (id: string, key: Key) => api.app.request(`/v1/reservations/${id}`, { headers: bearer(key.key) });
  const post = (id: string, action: string, body: unknown, headers: Record<string, string>) => api.app.request(`/v1/reservations/${id}/${action}`, jsonInit("POST", body, headers));

  it("reads a reservation with effective status and history; hides it outside the key's venues", async () => {
    const id = await held();
    const r = await get(id, agent);
    expect(r.status).toBe(200);
    const view = await r.json() as { id: string; venue_id: string; status: string; stored_status: string; version: number; party_size: number; assignment: { kind: string; id: string }; history: { action: string; actor: string; at: string }[] };
    expect(view).toMatchObject({ id, venue_id: seed.venue, status: "held", stored_status: "held", version: 1, party_size: 2, assignment: { kind: "unit", id: seed.units[0] } });
    expect(view.history.length).toBeGreaterThanOrEqual(1);
    expect(view.history[0]!.actor).toBe(`key:${agent.id}`);
    expect((await get(id, elsewhere)).status).toBe(404);
    expect((await get(NIL, staff)).status).toBe(404);
    expect((await get(id, holder)).status).toBe(403);
  });

  it("cancels with a reason; a second cancel and a stale version are conflicts", async () => {
    const id = await held();
    expect((await post(id, "cancel", { reason: "guest called" }, bearer(agent.key))).status).toBe(403);
    expect((await post(id, "cancel", {}, bearer(staff.key))).status).toBe(400);
    const stale = await post(id, "cancel", { reason: "x", expected_version: 7 }, bearer(staff.key));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "version_conflict" });
    expect((await post(id, "cancel", { reason: "x", expected_version: 3_000_000_000 }, bearer(staff.key))).status).toBe(400);
    const ok = await post(id, "cancel", { reason: "guest called", expected_version: 1 }, bearer(staff.key));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ receipt: { reservation_id: id, status: "cancelled", version: 2 } });
    const again = await post(id, "cancel", { reason: "again" }, bearer(staff.key));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "invalid_transition" });
  });

  it("confirms with a key that has the capability; 403 without it; 401 with neither key nor token", async () => {
    const id = await held();
    expect((await post(id, "confirm", {}, {})).status).toBe(401);
    expect((await post(id, "confirm", {}, bearer(agent.key))).status).toBe(403);
    expect((await post(id, "confirm", {}, bearer(elsewhere.key))).status).toBe(404);
    const ok = await post(id, "confirm", {}, bearer(staff.key));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ receipt: { reservation_id: id, status: "confirmed" } });
  });

  it("mints a single-use token with the confirm capability; whoever holds it confirms without a key", async () => {
    const id = await held();
    expect((await post(id, "confirm-token", {}, bearer(agent.key))).status).toBe(403);
    const minted = await post(id, "confirm-token", {}, bearer(staff.key));
    expect(minted.status).toBe(201);
    const { confirm_token, version } = await minted.json() as { confirm_token: string; version: number };
    expect(confirm_token.length).toBeGreaterThanOrEqual(40);
    expect(version).toBe(2);

    const wrong = await post(id, "confirm", { confirm_token: "not-the-token" }, {});
    expect(wrong.status).toBe(403);
    expect((await post(id, "confirm", { confirm_token: "not-the-token", expected_version: 99 }, {})).status).toBe(403);
    const missing = await post(NIL, "confirm", { confirm_token }, {});
    expect(missing.status).toBe(403);
    expect((await missing.json() as { detail: string }).detail).toBe((await (await post(id, "confirm", { confirm_token: "still-wrong" }, {})).json() as { detail: string }).detail);
    expect((await post(id, "confirm", { confirm_token }, { authorization: "Bearer dsk_" + "Z".repeat(43) })).status).toBe(401);

    const ok = await post(id, "confirm", { confirm_token }, {});
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ receipt: { reservation_id: id, status: "confirmed" } });
    const view = await (await get(id, staff)).json() as { history: { actor: string }[] };
    expect(view.history.at(-1)!.actor).toBe(`token:${id}`);
    const reuse = await post(id, "confirm", { confirm_token }, {});
    // a used token, a wrong token, and an absent reservation are one and the same refusal
    const refusal = async (r: Response) => { const b = await r.json() as Record<string, unknown>; delete b.trace_id; return { status: r.status, body: b }; };
    const usedToken = await refusal(reuse);
    expect(usedToken).toMatchObject({ status: 403, body: { code: "forbidden" } });
    expect(await refusal(await post(NIL, "confirm", { confirm_token }, {}))).toEqual(usedToken);
    expect(await refusal(await post(await held(), "confirm", { confirm_token: "guess" }, {}))).toEqual(usedToken);
    expect(await refusal(await post(id, "confirm", { confirm_token: "guess" }, {}))).toEqual(usedToken);
    // a caller with a key still gets the state-specific answer
    const byKey = await post(id, "confirm", {}, bearer(staff.key));
    expect(byKey.status).toBe(409);
    expect(await byKey.json()).toMatchObject({ code: "invalid_transition" });
  });

  it("a caller without a valid token never reaches a lock: the refusal is prompt even while the unit is locked", async () => {
    const id = await held();
    await post(id, "confirm-token", {}, bearer(staff.key));
    const blocker = await connect(conn.app);
    await blocker.query("begin");
    await blocker.query("select pg_advisory_xact_lock(dastar.unit_lock_key($1::uuid))", [seed.units[0]]);
    try {
      const t0 = Date.now();
      const r = await post(id, "confirm", { confirm_token: "guess" }, {});
      expect(r.status).toBe(403);
      expect(Date.now() - t0).toBeLessThan(1_000);
    } finally {
      await blocker.query("rollback");
      await blocker.end();
    }
  });

  it("a key without confirm may carry a token; a token dies with a cancellation", async () => {
    const id = await held();
    const { confirm_token } = await (await post(id, "confirm-token", {}, bearer(staff.key))).json() as { confirm_token: string };
    expect((await post(id, "confirm", { confirm_token }, bearer(agent.key))).status).toBe(200);

    const id2 = await held();
    const t2 = (await (await post(id2, "confirm-token", {}, bearer(staff.key))).json() as { confirm_token: string }).confirm_token;
    expect((await post(id2, "cancel", { reason: "changed plans" }, bearer(staff.key))).status).toBe(200);
    const dead = await post(id2, "confirm", { confirm_token: t2 }, {});
    expect(dead.status).toBe(403);
    expect(await dead.json()).toMatchObject({ code: "forbidden", detail: "confirm token does not match" });
    expect((await post(id2, "confirm", { confirm_token: "guess" }, {})).status).toBe(403);
  });
});

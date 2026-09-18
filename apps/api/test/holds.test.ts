import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedVenue, type Seed } from "../../../packages/db/test/helpers/seed.js";
import { createKey } from "../src/auth.js";
import { makeApi, bearer, jsonInit } from "./helpers.js";

describe("POST /v1/venues/{id}/holds", () => {
  let conn: Conn; let owner: Client; let seed: Seed; let api: ReturnType<typeof makeApi>;
  let main: { id: string; key: string }; let n = 0;

  beforeAll(async () => {
    conn = await cloneDatabase("api_holds_test");
    owner = await connect(conn.owner);
    seed = await seedVenue(owner);
    api = makeApi(conn);
    main = await createKey(api.pool, { label: "main", capabilities: ["hold", "read"] });
  });
  afterAll(async () => { await api.close(); await owner.end(); await dropDatabase("api_holds_test"); });

  const path = (venue = seed.venue) => `/v1/venues/${venue}/holds`;
  function body(over: Record<string, unknown> = {}): Record<string, unknown> {
    n += 1;
    const start = new Date(Date.UTC(2044, 0, 1 + Math.floor(n / 8), 8 + (n % 8)));
    return { party_size: 2, starts_at: start.toISOString(), duration_minutes: 60, assignment: { kind: "unit", id: seed.units[0] }, ...over };
  }
  const send = (b: unknown, idem: string | null, key = main.key, venue = seed.venue) =>
    api.app.request(path(venue), jsonInit("POST", b, { ...bearer(key), ...(idem === null ? {} : { "idempotency-key": idem }) }));

  it("holds a table and returns a receipt, never a token", async () => {
    const r = await api.app.request(path(), jsonInit("POST", body(), { ...bearer(main.key), "idempotency-key": "h1", "x-trace-id": "trace-h1" }));
    expect(r.status).toBe(201);
    const text = await r.text();
    expect(text).not.toContain("token");
    const out = JSON.parse(text) as { receipt: { reservation_id: string; status: string; version: number; audit_id: number; trace_id: string }; hold_expires_at: string; replayed: boolean };
    expect(out.receipt).toMatchObject({ status: "held", version: 1, trace_id: "trace-h1" });
    expect(new Date(out.hold_expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(out.replayed).toBe(false);
    expect(api.lines.at(-1)).toMatchObject({ method: "POST", status: 201, key_id: main.id, trace_id: "trace-h1" });
  });

  it("replays the same key and payload; rejects the same key with another payload", async () => {
    const b = body();
    const first = await (await send(b, "h2")).json() as { receipt: { reservation_id: string }; replayed: boolean };
    const again = await send(b, "h2");
    expect(again.status).toBe(201);
    expect(await again.json()).toMatchObject({ receipt: { reservation_id: first.receipt.reservation_id }, replayed: true });
    const other = await send({ ...b, party_size: 3 }, "h2");
    expect(other.status).toBe(422);
    expect(await other.json()).toMatchObject({ code: "idempotency_mismatch", type: "https://dastar.dev/errors/idempotency_mismatch" });
  });

  it("a conflict and a misfit are problems that carry the replay flag", async () => {
    const b = body();
    expect((await send(b, "h3")).status).toBe(201);
    const conflict = await send(b, "h3-b");
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get("content-type")).toBe("application/problem+json");
    const conflictBody = await conflict.json();
    expect(conflictBody).toMatchObject({ code: "hold_conflict", status: 409, replayed: false, detail: "the assignment is already taken for an overlapping time range" });
    expect(conflict.headers.get("x-trace-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(api.lines.at(-1)).toMatchObject({ status: 409, key_id: main.id });
    expect(await (await send(b, "h3-b")).json()).toMatchObject({ code: "hold_conflict", replayed: true });
    const misfit = await send(body({ party_size: 9 }), "h3-c");
    expect(misfit.status).toBe(422);
    expect(await misfit.json()).toMatchObject({ code: "party_does_not_fit" });
  });

  it("validates the header, the body, and the path", async () => {
    const noKey = await send(body(), null);
    expect(noKey.status).toBe(400);
    expect(await noKey.json()).toMatchObject({ code: "validation" });
    const badBody = await send(body({ party_size: 0, starts_at: "2044-01-01 19:00" }), "h4");
    expect(badBody.status).toBe(400);
    const detail = (await badBody.json() as { detail: string }).detail;
    expect(detail).toContain("party_size");
    expect(detail).toContain("starts_at");
    expect((await api.app.request("/v1/venues/not-a-uuid/holds", jsonInit("POST", body(), { ...bearer(main.key), "idempotency-key": "h4-b" }))).status).toBe(400);
    expect((await send(body({ duration_minutes: 200_000_000_000 }), "h4-c")).status).toBe(400);
    expect((await send(body({ party_size: 1_000_000_000_000 }), "h4-d")).status).toBe(400);
  });

  it("403 without the hold capability, 404 outside the key's venues, 404 for an unknown venue", async () => {
    const reader = await createKey(api.pool, { label: "reader", capabilities: ["read"] });
    expect((await send(body(), "h5", reader.key)).status).toBe(403);
    const elsewhere = await createKey(api.pool, { label: "elsewhere", capabilities: ["hold"], venueIds: ["01a0b07c-189a-70cb-a39e-1f679b38fe4d"] });
    expect((await send(body(), "h5-b", elsewhere.key)).status).toBe(404);
    const unknown = await send(body(), "h5-c", main.key, "00000000-0000-0000-0000-000000000000");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ code: "not_found" });
  });

  it("429 with Retry-After once the actor has too many live holds", async () => {
    const greedy = await createKey(api.pool, { label: "greedy", capabilities: ["hold"] });
    for (let k = 0; k < 5; k++) expect((await send(body({ assignment: { kind: "unit", id: seed.units[1] } }), `g${k}`, greedy.key)).status).toBe(201);
    const sixth = await send(body({ assignment: { kind: "unit", id: seed.units[1] } }), "g5", greedy.key);
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("retry-after")).toBe("1");
    expect(await sixth.json()).toMatchObject({ code: "too_many_live_holds" });
  });

  it("answers 400, never 500, for a wrong media type, malformed JSON, a missing body, and an oversized body", async () => {
    const headers = { ...bearer(main.key), "idempotency-key": "h6" };
    const plain = await api.app.request(path(), { method: "POST", headers: { ...headers, "content-type": "text/plain" }, body: "x" });
    const broken = await api.app.request(path(), { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{not json" });
    const empty = await api.app.request(path(), { method: "POST", headers: { ...headers, "content-type": "application/json" } });
    const huge = await api.app.request(path(), jsonInit("POST", { ...body(), external_ref: "x".repeat(70_000) }, headers));
    for (const r of [plain, broken, empty, huge]) {
      expect(r.status).toBe(400);
      expect(r.headers.get("content-type")).toBe("application/problem+json");
      expect(await r.json()).toMatchObject({ code: "validation" });
    }
  });
});

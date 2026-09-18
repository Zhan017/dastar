import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { cloneDatabase, dropDatabase, type Conn } from "../../../packages/db/test/helpers/db.js";
import type { Deps, Env } from "../src/env.js";
import { fromUnknown, problemBody } from "../src/problem.js";
import { createKey, findKey, requireCapability, requireKey, assertVenueInScope } from "../src/auth.js";
import { withClient } from "../src/db.js";
import { bearer } from "./helpers.js";

const VENUE_A = "01a0b07c-189a-70cb-a39e-1f679b38fe4d";
const VENUE_B = "01a0b07c-189a-70cb-a39e-1f679b38fe4e";

describe("keys and authorization", () => {
  let conn: Conn; let pool: Pool; let deps: Deps; let app: OpenAPIHono<Env>;

  beforeAll(async () => {
    conn = await cloneDatabase("api_auth_test");
    pool = new Pool({ connectionString: conn.app, max: 4, application_name: "api-auth" });
    pool.on("error", () => undefined);
    deps = { pool, migrationsDir: "unused", dastar: undefined as unknown as Deps["dastar"] };
    app = new OpenAPIHono<Env>();
    app.use("*", async (c, next) => { c.set("traceId", "t"); c.set("key", null); await next(); });
    app.onError((err, c) => { const p = fromUnknown(err); return c.newResponse(JSON.stringify(problemBody(p, "t")), p.status, { "content-type": "application/problem+json" }); });
    const ok = { 200: { description: "ok", content: { "application/json": { schema: z.object({ key_id: z.string().nullable() }) } } } };
    const needsHold = createRoute({ method: "get", path: "/venues/{id}/probe", middleware: [requireCapability(deps, "hold")] as const, request: { params: z.object({ id: z.guid() }) }, responses: ok });
    app.openapi(needsHold, (c) => { const key = requireKey(c); assertVenueInScope(key, c.req.valid("param").id); return c.json({ key_id: key.id }, 200); });
    const tokenOk = createRoute({ method: "get", path: "/token-probe", middleware: [requireCapability(deps, "confirm", { orToken: true })] as const, responses: ok });
    app.openapi(tokenOk, (c) => c.json({ key_id: c.get("key")?.id ?? null }, 200));
  });
  afterAll(async () => { await pool.end(); await dropDatabase("api_auth_test"); });

  it("creates a key that is stored only as a hash and found by its presented form", async () => {
    const { id, key } = await createKey(pool, { label: "t", capabilities: ["hold", "read"] });
    expect(key).toMatch(/^dsk_[A-Za-z0-9_-]{43}$/);
    const row = (await pool.query("select key_hash, capabilities, venue_ids from dastar.api_key where id = $1", [id])).rows[0];
    expect((row.key_hash as Buffer).length).toBe(32);
    expect((row.key_hash as Buffer).toString("utf8")).not.toContain(key);
    expect(await findKey(deps, key)).toEqual({ id, capabilities: ["hold", "read"], venueIds: null });
    expect(await findKey(deps, "dsk_" + "A".repeat(43))).toBeNull();
  });

  it("401 without a key, with a malformed key, with an unknown key, and with a revoked key", async () => {
    const path = `/venues/${VENUE_A}/probe`;
    expect((await app.request(path)).status).toBe(401);
    expect((await app.request(path, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await app.request(path, { headers: bearer("dsk_" + "B".repeat(43)) })).status).toBe(401);
    const { id, key } = await createKey(pool, { label: "revoked", capabilities: ["hold"] });
    await pool.query("update dastar.api_key set revoked_at = now() where id = $1", [id]);
    const r = await app.request(path, { headers: bearer(key) });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ code: "unauthorized" });
  });

  it("403 without the capability; 404 outside the key's venues; 200 inside them", async () => {
    const reader = await createKey(pool, { label: "reader", capabilities: ["read"] });
    expect((await app.request(`/venues/${VENUE_A}/probe`, { headers: bearer(reader.key) })).status).toBe(403);
    const scoped = await createKey(pool, { label: "scoped", capabilities: ["hold"], venueIds: [VENUE_A] });
    expect((await app.request(`/venues/${VENUE_B}/probe`, { headers: bearer(scoped.key) })).status).toBe(404);
    const ok = await app.request(`/venues/${VENUE_A}/probe`, { headers: bearer(scoped.key) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ key_id: scoped.id });
    expect((await app.request(`/venues/${VENUE_A}/probe`, { headers: { authorization: `bearer ${scoped.key}` } })).status).toBe(200);
  });

  it("a token-capable route admits no key, validates a presented key, and does not consult its capabilities", async () => {
    expect(await (await app.request("/token-probe")).json()).toEqual({ key_id: null });
    expect((await app.request("/token-probe", { headers: bearer("dsk_" + "C".repeat(43)) })).status).toBe(401);
    const reader = await createKey(pool, { label: "reader2", capabilities: ["read"] });
    expect(await (await app.request("/token-probe", { headers: bearer(reader.key) })).json()).toEqual({ key_id: reader.id });
  });

  it("withClient bounds the wait for a connection and discards a client whose read failed", async () => {
    const small = new Pool({ connectionString: conn.app, max: 1, application_name: "api-auth-small" });
    small.on("error", () => undefined);
    const held = await small.connect();
    const waited = withClient(small, 150, async (c) => (await c.query("select 1 as one")).rows[0].one as number).then(() => "resolved", (e: unknown) => e);
    expect(await waited).toMatchObject({ code: "pool_timeout", retryable: true });
    held.release();
    expect(await withClient(small, 1_000, async (c) => (await c.query("select 1 as one")).rows[0].one as number)).toBe(1);
    const failed = withClient(small, 1_000, async (c) => { await c.query("select * from dastar.no_such_table"); return 0; }).then(() => "resolved", (e: unknown) => e);
    expect(await failed).toMatchObject({ code: "42P01" });
    expect(small.totalCount).toBe(0);
    await small.end();
  });
});

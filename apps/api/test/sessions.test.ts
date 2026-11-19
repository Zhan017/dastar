import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedVenue, type Seed } from "../../../packages/db/test/helpers/seed.js";
import { createKey } from "../src/auth.js";
import { makeApi, bearer, jsonInit } from "./helpers.js";

type Key = { id: string; key: string };
type Json = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RULE = "a key that can confirm or administer cannot open an audit session";

describe("audit session routes", () => {
  let conn: Conn; let owner: Client; let api: ReturnType<typeof makeApi>;
  let A: Seed; let B: Seed;
  let agent: Key; let seater: Key; let staff: Key; let admin: Key; let writer: Key; let other: Key;

  beforeAll(async () => {
    conn = await cloneDatabase("api_sessions_test");
    owner = await connect(conn.owner);
    A = await seedVenue(owner);
    B = await seedVenue(owner);
    api = makeApi(conn);
    const inA = [A.venue];
    agent = await createKey(api.pool, { label: "agent", capabilities: ["read", "hold", "cancel"], venueIds: inA });
    seater = await createKey(api.pool, { label: "seater", capabilities: ["read", "hold", "cancel", "seat"], venueIds: inA });
    staff = await createKey(api.pool, { label: "staff", capabilities: ["hold", "confirm", "cancel", "read"], venueIds: inA });
    admin = await createKey(api.pool, { label: "admin", capabilities: ["admin", "read"], venueIds: inA });
    writer = await createKey(api.pool, { label: "writer", capabilities: ["hold"], venueIds: inA });
    other = await createKey(api.pool, { label: "other", capabilities: ["read", "hold", "cancel"], venueIds: [B.venue] });
  });
  afterAll(async () => { await api.close(); await owner.end(); await dropDatabase("api_sessions_test"); });

  const open = (key: Key | null, venue: string): Promise<Response> =>
    Promise.resolve(api.app.request("/v1/sessions", jsonInit("POST", { venue_id: venue }, key === null ? {} : bearer(key.key))));
  const read = (key: Key, id: string): Promise<Response> => Promise.resolve(api.app.request(`/v1/sessions/${id}`, { headers: bearer(key.key) }));
  const json = async <T = Json>(r: Response): Promise<T> => await r.json() as T;
  const sessionCount = async (key: Key): Promise<number> =>
    (await owner.query("select count(*)::int as n from dastar_agent.session where api_key_id = $1", [key.id])).rows[0].n as number;

  it("opens a session for a key that can read and cannot confirm or administer", async () => {
    for (const key of [agent, seater]) {
      const r = await open(key, A.venue);
      expect(r.status).toBe(201);
      const s = await json<{ id: string; venue_id: string; kind: string; started_at: string }>(r);
      expect(s).toEqual({ id: expect.stringMatching(UUID), venue_id: A.venue, kind: "external", started_at: expect.stringMatching(ISO) });
      const row = (await owner.query("select venue_id, api_key_id, kind from dastar_agent.session where id = $1", [s.id])).rows[0];
      expect(row).toEqual({ venue_id: A.venue, api_key_id: key.id, kind: "external" });
    }
  });

  it("refuses a key that can confirm or administer, and opens nothing", async () => {
    for (const key of [staff, admin]) {
      const r = await open(key, A.venue);
      expect(r.status).toBe(403);
      expect(await json(r)).toMatchObject({ code: "forbidden", detail: RULE });
    }
    expect(await sessionCount(staff)).toBe(0);
    expect(await sessionCount(admin)).toBe(0);
  });

  it("refuses a key without read, a venue outside the key's, and a venue that does not exist", async () => {
    const noRead = await open(writer, A.venue);
    expect(noRead.status).toBe(403);
    expect(await json(noRead)).toMatchObject({ code: "forbidden" });
    const outside = await open(agent, B.venue);
    expect(outside.status).toBe(404);
    expect(await json(outside)).toMatchObject({ code: "not_found", detail: "no such venue" });
    const everywhere = await createKey(api.pool, { label: "everywhere", capabilities: ["read", "hold", "cancel"] });
    const absent = await open(everywhere, randomUUID());
    expect(absent.status).toBe(404);
    expect(await json(absent)).toMatchObject({ code: "not_found" });
    expect(await sessionCount(everywhere)).toBe(0);
    expect(await sessionCount(writer)).toBe(0);
  });

  it("refuses a request without a key and a body that is not a venue id", async () => {
    expect((await open(null, A.venue)).status).toBe(401);
    const bad = await api.app.request("/v1/sessions", jsonInit("POST", { venue_id: "abc" }, bearer(agent.key)));
    expect(bad.status).toBe(400);
    expect(await json(bad)).toMatchObject({ code: "validation" });
  });

  it("reads a session for the key that owns it only", async () => {
    const made = await json<{ id: string; started_at: string }>(await open(agent, A.venue));
    const mine = await read(agent, made.id);
    expect(mine.status).toBe(200);
    expect(await json(mine)).toEqual({
      id: made.id, venue_id: A.venue, kind: "external", started_at: made.started_at,
      last_seen_at: expect.stringMatching(ISO), calls: 0, audited_at: null,
    });
    const theirs = await read(seater, made.id);
    expect(theirs.status).toBe(404);
    expect(await json(theirs)).toMatchObject({ code: "not_found", detail: "no such session" });
    expect((await read(other, made.id)).status).toBe(404);
    const absent = await read(agent, randomUUID());
    expect(absent.status).toBe(404);
    expect(await json(absent)).toMatchObject({ code: "not_found", detail: "no such session" });
    const malformed = await read(agent, "abc");
    expect(malformed.status).toBe(400);
    expect(await json(malformed)).toMatchObject({ code: "validation" });
  });

  it("refuses a read without the read capability and without a key", async () => {
    const made = await json<{ id: string }>(await open(agent, A.venue));
    expect((await read(writer, made.id)).status).toBe(403);
    expect((await api.app.request(`/v1/sessions/${made.id}`)).status).toBe(401);
  });

  it("a session last seen more than 30 days ago reads 404", async () => {
    const made = await json<{ id: string }>(await open(agent, A.venue));
    expect((await read(agent, made.id)).status).toBe(200);
    await owner.query("update dastar_agent.session set last_seen_at = now() - interval '721 hours' where id = $1", [made.id]);
    const gone = await read(agent, made.id);
    expect(gone.status).toBe(404);
    expect(await json(gone)).toMatchObject({ code: "not_found", detail: "no such session" });
  });
});

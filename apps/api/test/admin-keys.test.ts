import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "../../../packages/db/test/helpers/db.js";
import { seedVenue, type Seed } from "../../../packages/db/test/helpers/seed.js";
import { createKey, hashKey } from "../src/auth.js";
import { makeApi, bearer, jsonInit } from "./helpers.js";

type Key = { id: string; key: string };
type Json = Record<string, unknown>;
type KeyJson = { id: string; label: string; capabilities: string[]; venue_ids: string[]; created_at: string; revoked_at: string | null };
type Created = { key: KeyJson; secret: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SECRET = /^dsk_[A-Za-z0-9_-]{43}$/;
const ABSENT = "00000000-0000-7000-8000-000000000001";
const KEY_FIELDS = ["capabilities", "created_at", "id", "label", "revoked_at", "venue_ids"];

describe("admin key routes", () => {
  let conn: Conn; let owner: Client; let api: ReturnType<typeof makeApi>;
  let host: Key; let desk: Key;
  let n = 0;

  beforeAll(async () => {
    conn = await cloneDatabase("api_admin_keys_test");
    owner = await connect(conn.owner);
    api = makeApi(conn);
    host = await createKey(api.pool, { label: "host", capabilities: ["admin"] });
    desk = await createKey(api.pool, { label: "desk", capabilities: ["hold", "confirm", "cancel", "seat", "read"] });
  });
  afterAll(async () => { await api.close(); await owner.end(); await dropDatabase("api_admin_keys_test"); });

  async function fresh(): Promise<Seed> {
    const seed = await seedVenue(owner);
    await owner.query("update dastar.venue set max_live_holds_per_actor = 100 where id = $1", [seed.venue]);
    return seed;
  }
  /** A key of the venue alone, written by the host's helper rather than through the route. */
  const venueKey = (venue: string, capabilities: string[], label = "k"): Promise<Key> => createKey(api.pool, { label, capabilities, venueIds: [venue] });

  const call = (method: string, path: string, key: Key | null, body?: unknown): Promise<Response> => {
    const headers = key === null ? {} : bearer(key.key);
    return Promise.resolve(api.app.request(path, body === undefined ? { method, headers } : jsonInit(method, body, headers)));
  };
  const json = async <T = Json>(r: Response): Promise<T> => await r.json() as T;
  const keysPath = (venue: string): string => `/admin/venues/${venue}/keys`;
  const revokePath = (venue: string, keyId: string): string => `/admin/venues/${venue}/keys/${keyId}/revoke`;

  /** Every key row, hash included, so a refused request can be shown to have changed none. */
  async function snapshot(): Promise<unknown[]> {
    return (await owner.query("select id, label, capabilities, venue_ids, revoked_at, encode(key_hash, 'hex') as hash from dastar.api_key order by id")).rows;
  }
  async function stored(id: string): Promise<{ label: string; capabilities: string[]; venue_ids: string[] | null; revoked_at: Date | null; revoked_text: string | null }> {
    return (await owner.query("select label, capabilities, venue_ids, revoked_at, revoked_at::text as revoked_text from dastar.api_key where id = $1", [id])).rows[0];
  }
  async function placeHold(venue: string, key: Key, unit: string, day: number): Promise<Response> {
    n += 1;
    return api.app.request(`/v1/venues/${venue}/holds`, jsonInit("POST", {
      party_size: 2, starts_at: new Date(Date.UTC(2065, 0, day, 18)).toISOString(), duration_minutes: 90, assignment: { kind: "unit", id: unit },
    }, { ...bearer(key.key), "idempotency-key": `keys-h${n}` }));
  }
  async function create(venue: string, by: Key, capabilities: string[], label = "made"): Promise<Created> {
    const r = await call("POST", keysPath(venue), by, { label, capabilities });
    expect(r.status).toBe(201);
    return json<Created>(r);
  }

  describe("creating a key", () => {
    it("201 with a key that works with its capabilities on its venue, answers 403 for another capability and 404 on another venue, and is scoped to the venue alone", async () => {
      const S = await fresh();
      const O = await fresh();
      const admin = await venueKey(S.venue, ["admin"]);

      const res = await call("POST", keysPath(S.venue), admin, { label: "holder", capabilities: ["hold", "read"] });
      expect(res.status).toBe(201);
      expect(res.headers.get("content-type")).toContain("application/json");
      // the body carries the secret, so no cache may keep it
      expect(res.headers.get("cache-control")).toBe("no-store");
      const holder = await json<Created>(res);
      expect(holder.secret).toMatch(SECRET);
      expect(holder.key).toEqual({
        id: expect.stringMatching(UUID), label: "holder", capabilities: ["hold", "read"], venue_ids: [S.venue],
        created_at: expect.stringMatching(ISO), revoked_at: null,
      });
      expect(await stored(holder.key.id)).toMatchObject({ label: "holder", capabilities: ["hold", "read"], venue_ids: [S.venue], revoked_at: null });

      const holderKey: Key = { id: holder.key.id, key: holder.secret };
      const held = await placeHold(S.venue, holderKey, S.units[0]!, 5);
      expect(held.status).toBe(201);
      const reservation = (await json<{ receipt: { reservation_id: string } }>(held)).receipt.reservation_id;
      expect((await owner.query("select venue_id from dastar.reservation where id = $1", [reservation])).rows).toEqual([{ venue_id: S.venue }]);
      const listed = await call("GET", `/v1/venues/${S.venue}/holds`, holderKey);
      expect(listed.status).toBe(200);
      const holds = (await json<{ holds: { id: string }[] }>(listed)).holds;
      expect(holds).toHaveLength(1);
      expect(holds[0]!.id).toBe(reservation);

      // a capability it lacks
      const cancel = await call("POST", `/v1/reservations/${reservation}/cancel`, holderKey, { reason: "no" });
      expect(cancel.status).toBe(403);
      expect(await json(cancel)).toMatchObject({ code: "forbidden" });
      expect((await call("GET", keysPath(S.venue), holderKey)).status).toBe(403);

      // another venue reads as absent, for a read and for a hold
      expect((await call("GET", `/v1/venues/${O.venue}/holds`, holderKey)).status).toBe(404);
      expect((await placeHold(O.venue, holderKey, O.units[0]!, 6)).status).toBe(404);
      expect((await owner.query("select count(*)::int as n from dastar.reservation where venue_id = $1", [O.venue])).rows[0].n).toBe(0);

      // a read-only key lists, and is refused a hold
      const reader = await create(S.venue, admin, ["read"], "reader");
      const readerKey: Key = { id: reader.key.id, key: reader.secret };
      const empty = await call("GET", `/v1/venues/${S.venue}/holds`, readerKey);
      expect(empty.status).toBe(200);
      expect(await json(empty)).toEqual({ holds: [] });
      expect((await placeHold(S.venue, readerKey, S.units[1]!, 7)).status).toBe(403);
    });

    it("scopes the key to the path's venue whatever the body says and however the path is spelled", async () => {
      const S = await fresh();
      const O = await fresh();
      const admin = await venueKey(S.venue, ["admin"]);
      for (const extra of [{ venue_ids: [O.venue] }, { venue_ids: [S.venue, O.venue] }, { venue_ids: null }, { venue_ids: [] }, { venueIds: [O.venue] }]) {
        const r = await call("POST", keysPath(S.venue), admin, { label: "scoped", capabilities: ["read"], ...extra });
        expect(r.status, JSON.stringify(extra)).toBe(201);
        const made = await json<Created>(r);
        expect(made.key.venue_ids).toEqual([S.venue]);
        expect((await stored(made.key.id)).venue_ids).toEqual([S.venue]);
      }
      // the same through an all-venues key and an upper-case path
      const viaHost = await call("POST", keysPath(S.venue.toUpperCase()), host, { label: "upper", capabilities: ["read"] });
      expect(viaHost.status).toBe(201);
      const upper = await json<Created>(viaHost);
      expect(upper.key.venue_ids).toEqual([S.venue]);
      expect((await stored(upper.key.id)).venue_ids).toEqual([S.venue]);
      expect((await owner.query("select count(*)::int as n from dastar.api_key where label = 'scoped' and venue_ids is distinct from array[$1::uuid]", [S.venue])).rows[0].n).toBe(0);
    });

    it("accepts a label of 100 characters and all six capabilities, admin included", async () => {
      const S = await fresh();
      const admin = await venueKey(S.venue, ["admin"]);
      const all = ["hold", "confirm", "cancel", "seat", "read", "admin"];
      const label = "x".repeat(100);
      const made = await create(S.venue, admin, all, label);
      expect(made.key).toMatchObject({ label, capabilities: all, venue_ids: [S.venue] });
      // a key made with admin can use its own venue's admin routes
      const second = await call("GET", keysPath(S.venue), { id: made.key.id, key: made.secret });
      expect(second.status).toBe(200);
      const ids = (await json<{ keys: KeyJson[] }>(second)).keys.map((k) => k.id);
      expect(ids).toContain(made.key.id);
    });

    it("400 for an empty label, a label of 101, no capabilities, an unknown capability, a repeated capability, and a non-array, and nothing is written", async () => {
      const S = await fresh();
      const admin = await venueKey(S.venue, ["admin"]);
      const cases: [string, unknown, string][] = [
        ["empty label", { label: "", capabilities: ["read"] }, "label"],
        ["label of 101", { label: "x".repeat(101), capabilities: ["read"] }, "label"],
        ["missing label", { capabilities: ["read"] }, "label"],
        ["no capabilities", { label: "k", capabilities: [] }, "capabilities"],
        ["missing capabilities", { label: "k" }, "capabilities"],
        ["unknown capability", { label: "k", capabilities: ["read", "root"] }, "capabilities"],
        ["repeated capability", { label: "k", capabilities: ["read", "read"] }, "capabilities"],
        ["non-array", { label: "k", capabilities: "read" }, "capabilities"],
        ["object", { label: "k", capabilities: { read: true } }, "capabilities"],
        ["not an object", ["read"], ""],
      ];
      expect(cases.length).toBeGreaterThan(0);
      const before = await snapshot();
      for (const [name, body, field] of cases) {
        const r = await call("POST", keysPath(S.venue), admin, body);
        expect(r.status, name).toBe(400);
        const problem = await json<{ code: string; detail: string }>(r);
        expect(problem.code, name).toBe("validation");
        expect(problem.detail, name).toContain(field);
      }
      expect(await snapshot()).toEqual(before);
    });

    it("404 under a venue that does not exist for an all-venues admin key, and nothing is written", async () => {
      const before = await snapshot();
      const r = await call("POST", keysPath(ABSENT), host, { label: "ghost", capabilities: ["read"] });
      expect(r.status).toBe(404);
      expect(await json(r)).toMatchObject({ code: "not_found", detail: "no such venue" });
      expect(await snapshot()).toEqual(before);
      expect((await owner.query("select count(*)::int as n from dastar.api_key where label = 'ghost'")).rows[0].n).toBe(0);
      // the connection that did the check was returned clean: a later create on a real venue is served
      const S = await fresh();
      expect((await create(S.venue, host, ["read"], "after")).key.venue_ids).toEqual([S.venue]);
    });

    it("400 for a path id that is not a uuid", async () => {
      const before = await snapshot();
      const r = await call("POST", keysPath("not-a-uuid"), host, { label: "k", capabilities: ["read"] });
      expect(r.status).toBe(400);
      expect(await snapshot()).toEqual(before);
    });
  });

  describe("listing keys", () => {
    it("shows exactly the venue's single-venue keys, oldest first, and no key that reaches beyond the venue", async () => {
      const S = await fresh();
      const O = await fresh();
      const admin = await venueKey(S.venue, ["admin"], "admin");
      const viaRoute = await create(S.venue, admin, ["read", "hold"], "route");
      const viaHelper = await venueKey(S.venue, ["cancel"], "helper");
      const second = await create(S.venue, admin, ["seat"], "route2");
      // keys that must not be listed
      const all = await createKey(api.pool, { label: "all", capabilities: ["read"] });
      const both = await createKey(api.pool, { label: "both", capabilities: ["read"], venueIds: [S.venue, O.venue] });
      const bothFlipped = await createKey(api.pool, { label: "flipped", capabilities: ["read"], venueIds: [O.venue, S.venue] });
      const twice = await createKey(api.pool, { label: "twice", capabilities: ["read"], venueIds: [S.venue, S.venue] });
      const none = await createKey(api.pool, { label: "none", capabilities: ["read"], venueIds: [] });
      const elsewhere = await venueKey(O.venue, ["read"], "other");

      const r = await call("GET", keysPath(S.venue), admin);
      expect(r.status).toBe(200);
      const text = await r.text();
      const listed = (JSON.parse(text) as { keys: KeyJson[] }).keys;
      expect(listed.length).toBeGreaterThan(0);
      expect(listed.map((k) => k.id)).toEqual([admin.id, viaRoute.key.id, viaHelper.id, second.key.id]);
      expect(listed.map((k) => k.label)).toEqual(["admin", "route", "helper", "route2"]);
      for (const k of listed) {
        expect(Object.keys(k).sort()).toEqual(KEY_FIELDS);
        expect(k.venue_ids).toEqual([S.venue]);
        expect(k.created_at).toMatch(ISO);
        expect(k.revoked_at).toBeNull();
      }
      expect(listed[1]).toEqual(viaRoute.key);
      expect(listed[2]!.capabilities).toEqual(["cancel"]);
      for (const hidden of [all, both, bothFlipped, twice, none, elsewhere]) expect(text).not.toContain(hidden.id);

      // the other venue's single key sees its own venue's list
      const other = await json<{ keys: KeyJson[] }>(await call("GET", keysPath(O.venue), host));
      expect(other.keys.map((k) => k.id)).toEqual([elsewhere.id]);
    });

    it("never carries a hash or a secret, for a live key or a revoked one", async () => {
      const S = await fresh();
      const admin = await venueKey(S.venue, ["admin"], "admin");
      const made = await create(S.venue, admin, ["read"], "made");
      const gone = await create(S.venue, admin, ["read"], "gone");
      expect((await call("POST", revokePath(S.venue, gone.key.id), admin)).status).toBe(200);
      const r = await call("GET", keysPath(S.venue), admin);
      expect(r.status).toBe(200);
      const text = await r.text();
      const listed = (JSON.parse(text) as { keys: KeyJson[] }).keys;
      expect(listed.map((k) => k.id)).toEqual([admin.id, made.key.id, gone.key.id]);
      expect(listed[2]!.revoked_at).toMatch(ISO);
      expect(text).not.toMatch(/key_hash|hash|Buffer|dsk_/i);
      for (const secret of [admin.key, made.secret, gone.secret]) {
        expect(text).not.toContain(secret);
        expect(text).not.toContain(hashKey(secret).toString("hex"));
        expect(text).not.toContain(hashKey(secret).toString("base64"));
        expect(text).not.toContain(hashKey(secret).toString("base64url"));
      }
    });

    it("lists nothing for a venue with no keys and for a venue that does not exist, for an all-venues admin key", async () => {
      const S = await fresh();
      for (const venue of [S.venue, ABSENT]) {
        const r = await call("GET", keysPath(venue), host);
        expect(r.status, venue).toBe(200);
        expect(await json(r)).toEqual({ keys: [] });
      }
    });
  });

  describe("revoking a key", () => {
    it("revokes a key of the venue, which then answers 401, and revoking again keeps the first time", async () => {
      const S = await fresh();
      const admin = await venueKey(S.venue, ["admin"]);
      const target = await create(S.venue, admin, ["read"], "target");
      const targetKey: Key = { id: target.key.id, key: target.secret };
      expect((await call("GET", `/v1/venues/${S.venue}/holds`, targetKey)).status).toBe(200);
      expect((await stored(target.key.id)).revoked_at).toBeNull();

      const first = await call("POST", revokePath(S.venue, target.key.id), admin);
      expect(first.status).toBe(200);
      const revoked = (await json<{ key: KeyJson }>(first)).key;
      expect(revoked).toEqual({ ...target.key, revoked_at: expect.stringMatching(ISO) });
      const row = await stored(target.key.id);
      expect(row.revoked_at).not.toBeNull();
      expect(row.revoked_at!.toISOString()).toBe(revoked.revoked_at);
      const afterRevoke = await call("GET", `/v1/venues/${S.venue}/holds`, targetKey);
      expect(afterRevoke.status).toBe(401);
      expect(await json(afterRevoke)).toMatchObject({ code: "unauthorized" });

      const again = await call("POST", revokePath(S.venue, target.key.id), admin);
      expect(again.status).toBe(200);
      expect((await json<{ key: KeyJson }>(again)).key.revoked_at).toBe(revoked.revoked_at);
      expect((await stored(target.key.id)).revoked_text).toBe(row.revoked_text);
      expect((await call("GET", `/v1/venues/${S.venue}/holds`, targetKey)).status).toBe(401);
    });

    it("404 for a key of another venue, of two venues, of all venues, of none, and an unknown id, and none is changed", async () => {
      const S = await fresh();
      const O = await fresh();
      const admin = await venueKey(S.venue, ["admin"]);
      const mine = await venueKey(S.venue, ["read"], "mine");
      const theirs = await venueKey(O.venue, ["read"], "theirs");
      const both = await createKey(api.pool, { label: "both", capabilities: ["read"], venueIds: [S.venue, O.venue] });
      const all = await createKey(api.pool, { label: "all", capabilities: ["read"] });
      const none = await createKey(api.pool, { label: "none", capabilities: ["read"], venueIds: [] });
      const targets = { theirs, both, all, none };
      expect(Object.keys(targets)).toHaveLength(4);

      const before = await snapshot();
      for (const [name, t] of Object.entries(targets)) {
        const r = await call("POST", revokePath(S.venue, t.id), admin);
        expect(r.status, name).toBe(404);
        expect(await json(r), name).toMatchObject({ code: "not_found", detail: "no such key" });
      }
      const unknown = await call("POST", revokePath(S.venue, ABSENT), admin);
      expect(unknown.status).toBe(404);
      expect(await json(unknown)).toMatchObject({ code: "not_found", detail: "no such key" });
      // an all-venues admin key is held to the same rule on a venue's route
      for (const [name, t] of Object.entries({ ...targets })) {
        const r = await call("POST", revokePath(S.venue, t.id), host);
        expect(r.status, `host: ${name}`).toBe(404);
      }
      expect(await snapshot()).toEqual(before);
      for (const t of [mine, theirs, both, all, none]) expect((await stored(t.id)).revoked_at, t.id).toBeNull();
      // and the keys still work
      expect((await call("GET", `/v1/venues/${S.venue}/holds`, both)).status).toBe(200);
      expect((await call("GET", `/v1/venues/${S.venue}/holds`, all)).status).toBe(200);
      expect((await call("GET", `/v1/venues/${O.venue}/holds`, theirs)).status).toBe(200);

      // a key of the venue is revoked, and only it
      expect((await call("POST", revokePath(S.venue, mine.id), admin)).status).toBe(200);
      expect((await stored(mine.id)).revoked_at).not.toBeNull();
      for (const t of [admin, theirs, both, all, none]) expect((await stored(t.id)).revoked_at, t.id).toBeNull();
    });

    it("200 when a key revokes itself, and 401 from then on", async () => {
      const S = await fresh();
      const admin = await venueKey(S.venue, ["admin"]);
      const self = await create(S.venue, admin, ["admin"], "self");
      const selfKey: Key = { id: self.key.id, key: self.secret };
      const r = await call("POST", revokePath(S.venue, self.key.id), selfKey);
      expect(r.status).toBe(200);
      expect((await json<{ key: KeyJson }>(r)).key).toMatchObject({ id: self.key.id, revoked_at: expect.stringMatching(ISO) });
      expect((await stored(self.key.id)).revoked_at).not.toBeNull();
      const after = await call("POST", revokePath(S.venue, self.key.id), selfKey);
      expect(after.status).toBe(401);
      expect((await call("GET", keysPath(S.venue), selfKey)).status).toBe(401);
      expect((await call("GET", keysPath(S.venue), admin)).status).toBe(200);
    });

    it("400 for a key id that is not a uuid", async () => {
      const S = await fresh();
      const admin = await venueKey(S.venue, ["admin"]);
      const before = await snapshot();
      expect((await call("POST", revokePath(S.venue, "not-a-uuid"), admin)).status).toBe(400);
      expect(await snapshot()).toEqual(before);
    });
  });

  describe("authorization", () => {
    /** One request for each of the three routes, aimed at a key of the venue. */
    function routes(venue: string, target: string): [string, string, unknown][] {
      return [
        ["GET", keysPath(venue), undefined],
        ["POST", keysPath(venue), { label: "new", capabilities: ["read"] }],
        ["POST", revokePath(venue, target), undefined],
      ];
    }

    it("401 without a key on all three routes, and nothing is written", async () => {
      const S = await fresh();
      const target = await venueKey(S.venue, ["read"], "target");
      const cases = routes(S.venue, target.id);
      expect(cases).toHaveLength(3);
      const before = await snapshot();
      for (const [method, path, body] of cases) {
        const r = await call(method, path, null, body);
        expect(r.status, `${method} ${path}`).toBe(401);
        expect(await json(r), `${method} ${path}`).toMatchObject({ code: "unauthorized" });
      }
      expect(await snapshot()).toEqual(before);
    });

    it("403 without the admin capability on all three routes, and nothing is written", async () => {
      const S = await fresh();
      const target = await venueKey(S.venue, ["read"], "target");
      const scoped = await venueKey(S.venue, ["hold", "confirm", "cancel", "seat", "read"], "scoped-desk");
      const cases = routes(S.venue, target.id);
      expect(cases).toHaveLength(3);
      const before = await snapshot();
      for (const key of [desk, scoped]) {
        for (const [method, path, body] of cases) {
          const r = await call(method, path, key, body);
          expect(r.status, `${method} ${path}`).toBe(403);
          expect(await json(r), `${method} ${path}`).toMatchObject({ code: "forbidden" });
        }
      }
      expect(await snapshot()).toEqual(before);
      expect((await stored(target.id)).revoked_at).toBeNull();
    });

    it("404 for an admin key of another venue on all three routes, and nothing is written; an admin key of the venue is served", async () => {
      const S = await fresh();
      const O = await fresh();
      const away = await venueKey(O.venue, ["admin"], "away");
      const target = await venueKey(S.venue, ["read"], "target");
      const cases = routes(S.venue, target.id);
      expect(cases).toHaveLength(3);
      const before = await snapshot();
      for (const [method, path, body] of cases) {
        const r = await call(method, path, away, body);
        expect(r.status, `${method} ${path}`).toBe(404);
        expect(await json(r), `${method} ${path}`).toMatchObject({ code: "not_found", detail: "no such venue" });
      }
      expect(await snapshot()).toEqual(before);
      expect((await stored(target.id)).revoked_at).toBeNull();
      expect((await call("GET", `/v1/venues/${S.venue}/holds`, target)).status).toBe(200);

      const home = await venueKey(S.venue, ["admin"], "home");
      expect((await call("GET", keysPath(S.venue), home)).status).toBe(200);
    });
  });

  describe("the secret", () => {
    it("appears once, in the 201 body, and in no request log line, response, or stored column", async () => {
      const S = await fresh();
      const admin = await venueKey(S.venue, ["admin"], "admin");
      const r = await call("POST", keysPath(S.venue), admin, { label: "shown-once", capabilities: ["admin"] });
      expect(r.status).toBe(201);
      const text = await r.text();
      const made = JSON.parse(text) as Created;
      expect(made.secret).toMatch(SECRET);
      expect(text.split(made.secret)).toHaveLength(2);
      expect(Object.keys(JSON.parse(text) as Json).sort()).toEqual(["key", "secret"]);
      expect(Object.keys(made.key).sort()).toEqual(KEY_FIELDS);

      // the table holds the hash alone
      const row = (await owner.query("select key_hash, label, capabilities from dastar.api_key where id = $1", [made.key.id])).rows[0] as { key_hash: Buffer; label: string; capabilities: string[] };
      expect(row.key_hash.equals(hashKey(made.secret))).toBe(true);
      expect(JSON.stringify(row)).not.toContain(made.secret);

      // the secret is the working credential
      const used = await call("GET", keysPath(S.venue), { id: made.key.id, key: made.secret });
      expect(used.status).toBe(200);
      const usedText = await used.text();
      expect(usedText).not.toContain(made.secret);
      const revoked = await call("POST", revokePath(S.venue, made.key.id), admin);
      expect(await revoked.text()).not.toContain(made.secret);

      // the log has the method, the path, the status, and the caller's key id, and never the secret
      expect(api.lines.length).toBeGreaterThan(0);
      const entry = api.lines.find((l) => l.method === "POST" && l.path === keysPath(S.venue) && l.status === 201 && l.key_id === admin.id);
      expect(entry).toBeDefined();
      expect(Object.keys(entry!).sort()).toEqual(["duration_ms", "key_id", "method", "path", "status", "trace_id", "ts"]);
      const logged = JSON.stringify(api.lines);
      expect(logged).not.toContain(made.secret);
      expect(logged).not.toContain(admin.key);
      expect(logged).not.toContain("dsk_");
      expect(logged).not.toContain(hashKey(made.secret).toString("hex"));
    });

    it("is different for each key", async () => {
      const S = await fresh();
      const admin = await venueKey(S.venue, ["admin"]);
      const a = await create(S.venue, admin, ["read"]);
      const b = await create(S.venue, admin, ["read"]);
      expect(a.secret).not.toBe(b.secret);
      expect(a.key.id).not.toBe(b.key.id);
      expect((await owner.query("select count(distinct key_hash)::int as n from dastar.api_key where id = any($1::uuid[])", [[a.key.id, b.key.id]])).rows[0].n).toBe(2);
    });
  });
});

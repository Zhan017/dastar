import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool, type Client } from "pg";
import { createHash } from "node:crypto";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { seedVenue, type Seed } from "./helpers/seed.js";
import { createDastar, type Dastar } from "../src/handle.js";
import { hold, rangeLiteral, type HoldInput } from "../src/commands/hold.js";
import { confirm } from "../src/commands/confirm.js";
import { cancel } from "../src/commands/cancel.js";
import { mintConfirmToken } from "../src/commands/mint-token.js";
import { mapPgError } from "../src/errors.js";

describe("venue isolation", () => {
  let conn: Conn; let owner: Client; let app: Client; let unbound: Client; let readonly: Client;
  let A: Seed; let B: Seed;
  let aLive: string[]; let bLive: string[]; let aCancelled: string; let bCancelled: string;
  let n = 0;
  const ABSENT = "00000000-0000-7000-8000-000000000000";

  /** One hold through the engine; every call gets its own actor and day, so no cap or overlap is in the way. */
  async function place(seed: Seed, over: Partial<HoldInput> = {}): Promise<string> {
    n += 1;
    const start = new Date(Date.UTC(2046, 0, 1 + n, 19));
    const out = await hold(app, {
      venueId: seed.venue, actor: `key:iso${n}`, traceId: `iso${n}`, idempotencyKey: `iso-k${n}`,
      partySize: 2, startsAt: start.toISOString(), durationMinutes: 90, assignment: { kind: "unit", id: seed.units[0]! }, ...over,
    });
    if (!out.ok) throw new Error(out.error.code);
    return out.receipt.reservationId;
  }

  /** Two single-unit holds, one combo hold (two unit rows), and one hold that was cancelled (an inactive unit row). */
  async function populate(seed: Seed): Promise<{ live: string[]; cancelled: string }> {
    const live = [
      await place(seed),
      await place(seed, { assignment: { kind: "unit", id: seed.units[1]! } }),
      await place(seed, { partySize: 6, assignment: { kind: "combo", id: seed.combos[0]!.id } }),
    ];
    const cancelled = await place(seed);
    await cancel(app, { reservationId: cancelled, actor: "key:iso", traceId: "iso-cancel", venueId: seed.venue, reason: "test" });
    return { live, cancelled };
  }

  /** The engine handle over a pool of the application role, closed when the callback ends. */
  async function withHandle<T>(fn: (d: Dastar) => Promise<T>): Promise<T> {
    const pool = new Pool({ connectionString: conn.app, max: 2 });
    pool.on("error", () => undefined);
    const d = createDastar({ pool });
    try {
      return await fn(d);
    } finally {
      await d.close();
      await pool.end();
    }
  }

  beforeAll(async () => {
    conn = await cloneDatabase("venue_isolation_test");
    owner = await connect(conn.owner);
    app = await connect(conn.app);
    unbound = await connect(conn.app);
    readonly = await connect(conn.readonly);
    A = await seedVenue(owner);
    B = await seedVenue(owner);
    const a = await populate(A);
    const b = await populate(B);
    aLive = a.live; aCancelled = a.cancelled;
    bLive = b.live; bCancelled = b.cancelled;
  });
  afterAll(async () => {
    await unbound.end(); await readonly.end(); await app.end(); await owner.end();
    await dropDatabase("venue_isolation_test");
  });

  /** The occupancy view in a transaction that is bound to `venueId`, or to nothing. */
  async function occupancy(client: Client, venueId: string | null): Promise<{ reservation_id: string; unit_id: string }[]> {
    await client.query("begin");
    try {
      if (venueId !== null) await client.query("select set_config('dastar.venue_id', $1, true)", [venueId]);
      return (await client.query("select reservation_id, unit_id from dastar.occupancy order by reservation_id, unit_id")).rows;
    } finally {
      await client.query("rollback");
    }
  }
  async function activeUnitRows(venueId: string): Promise<{ reservation_id: string; unit_id: string }[]> {
    return (await owner.query(
      "select reservation_id, unit_id from dastar.reservation_unit where venue_id = $1 and active order by reservation_id, unit_id",
      [venueId],
    )).rows;
  }

  /** The venue-scoped tables: the column that names the venue, and an expression that identifies one row. */
  const SCOPED = [
    { table: "venue", column: "id", key: "id::text" },
    { table: "unit", column: "venue_id", key: "id::text" },
    { table: "unit_combo", column: "venue_id", key: "id::text" },
    { table: "reservation", column: "venue_id", key: "id::text" },
    { table: "reservation_unit", column: "venue_id", key: "reservation_id::text || '/' || unit_id::text" },
    { table: "idempotency", column: "venue_id", key: "venue_id::text || '/' || actor || '/' || key" },
    { table: "audit_log", column: "venue_id", key: "id::text" },
    { table: "outbox", column: "venue_id", key: "id::text" },
  ] as const;
  type Scoped = (typeof SCOPED)[number];

  /** A reservation row written directly, as a caller of the application role could write it. */
  const INSERT_RESERVATION = `insert into dastar.reservation(venue_id, party_size, during, status, assignment_kind, assignment_id, hold_expires_at, created_by)
    values ($1, 2, $2::tstzrange, 'held', 'unit', $3, dastar.dastar_now() + interval '10 minutes', 'key:iso') returning id`;
  const FAR = "[2060-01-01T19:00:00.000Z,2060-01-01T20:00:00.000Z)";

  /** The row keys a client sees in a scoped table, in key order. */
  async function keysSeen(client: Client, t: Scoped): Promise<string[]> {
    return (await client.query(`select ${t.key} as k from dastar.${t.table} order by 1`)).rows.map((r) => r.k as string);
  }
  /** The row keys the owner holds for one venue, whatever any policy says. */
  async function keysOf(t: Scoped, venueId: string): Promise<string[]> {
    return (await owner.query(`select ${t.key} as k from dastar.${t.table} where ${t.column} = $1 order by 1`, [venueId])).rows.map((r) => r.k as string);
  }
  /** Runs `fn` in a transaction on `client` that is bound to `venueId`, or to nothing, and is rolled back at the end. */
  async function bound<T>(client: Client, venueId: string | null, fn: () => Promise<T>): Promise<T> {
    await client.query("begin");
    try {
      if (venueId !== null) await client.query("select set_config('dastar.venue_id', $1, true)", [venueId]);
      return await fn();
    } finally {
      await client.query("rollback");
    }
  }

  it("reservation_venue answers a reservation's venue to an unbound dastar_app, and null for an absent id", async () => {
    const read = async (id: string) => (await unbound.query("select dastar.reservation_venue($1) as venue_id", [id])).rows[0].venue_id as string | null;
    expect(await read(aLive[0]!)).toBe(A.venue);
    expect(await read(bLive[0]!)).toBe(B.venue);
    expect(await read(aCancelled)).toBe(A.venue);
    expect(await read(ABSENT)).toBeNull();
  });

  it("reservation_token answers one row of venue and token hash, and no row for an absent id", async () => {
    const id = await place(A);
    const read = async (rid: string) => (await unbound.query("select venue_id, confirm_token_hash from dastar.reservation_token($1)", [rid])).rows;
    expect(await read(id)).toEqual([{ venue_id: A.venue, confirm_token_hash: null }]);
    const { token } = await mintConfirmToken(app, { reservationId: id, actor: "key:iso", traceId: "iso-mint", venueId: A.venue });
    const after = await read(id);
    expect(after).toHaveLength(1);
    expect(after[0].venue_id).toBe(A.venue);
    expect((after[0].confirm_token_hash as Buffer).equals(createHash("sha256").update(token).digest())).toBe(true);
    const other = await place(B);
    expect(await read(other)).toEqual([{ venue_id: B.venue, confirm_token_hash: null }]);
    expect(await read(ABSENT)).toEqual([]);
  });

  it("dastar_readonly may call neither lookup (42501)", async () => {
    await expect(readonly.query("select dastar.reservation_venue($1)", [aLive[0]])).rejects.toMatchObject({ code: "42501" });
    await expect(readonly.query("select * from dastar.reservation_token($1)", [aLive[0]])).rejects.toMatchObject({ code: "42501" });
  });

  it("occupancy shows exactly the bound venue's active unit rows, and none when unbound", async () => {
    const forA = await activeUnitRows(A.venue);
    const forB = await activeUnitRows(B.venue);
    // the combo hold has two unit rows, and the cancelled hold's row is inactive
    expect(forA.length).toBeGreaterThanOrEqual(4);
    expect(forB.length).toBeGreaterThanOrEqual(4);
    expect(forA.map((r) => r.reservation_id)).not.toContain(aCancelled);
    expect(forB.map((r) => r.reservation_id)).not.toContain(bCancelled);
    expect(await occupancy(app, A.venue)).toEqual(forA);
    expect(await occupancy(app, B.venue)).toEqual(forB);
    // a fresh connection that never bound anything, and the same connections after a transaction-local bind ended
    expect(await occupancy(unbound, null)).toEqual([]);
    expect((await unbound.query("select 1 from dastar.occupancy")).rowCount).toBe(0);
    expect(await occupancy(unbound, A.venue)).toEqual(forA);
    expect(await occupancy(unbound, null)).toEqual([]);
    expect((await unbound.query("select 1 from dastar.occupancy")).rowCount).toBe(0);
    expect(await occupancy(app, null)).toEqual([]);
  });

  it("getReservation declares its venue: a reservation of another venue reads as absent", async () => {
    await withHandle(async (d) => {
      expect(await d.getReservation({ reservationId: aLive[0]!, venueId: A.venue })).toMatchObject({ id: aLive[0], venueId: A.venue, status: "held" });
      expect(await d.getReservation({ reservationId: aLive[0]!, venueId: B.venue })).toBeNull();
      expect(await d.getReservation({ reservationId: bLive[0]!, venueId: A.venue })).toBeNull();
      expect(await d.getReservation({ reservationId: bLive[0]!, venueId: B.venue })).toMatchObject({ id: bLive[0], venueId: B.venue });
    });
  });

  it("findReservationVenue answers the venue of an id, null for an absent one, and rejects a malformed one", async () => {
    await withHandle(async (d) => {
      expect(await d.findReservationVenue(aLive[0]!)).toBe(A.venue);
      expect(await d.findReservationVenue(bLive[1]!)).toBe(B.venue);
      expect(await d.findReservationVenue(ABSENT)).toBeNull();
      await expect(d.findReservationVenue("not-a-uuid")).rejects.toMatchObject({ name: "DastarError", code: "internal" });
    });
  });

  it("the seven trigger functions that read or write other tables run as the owner", async () => {
    const names = ["trg_fit", "trg_capacity_guard", "trg_config_version", "trg_audit", "trg_sync_unit_rows", "trg_unit_row_insert_guard", "trg_membership"];
    const r = await owner.query(
      `select proname, prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where nspname = 'dastar' and proname = any ($1::text[])`,
      [names],
    );
    expect(r.rows.map((x) => x.proname as string).sort()).toEqual([...names].sort());
    expect(r.rows.every((x) => x.prosecdef === true)).toBe(true);
  });

  it("bound to A, each scoped table shows only A's rows; B's venue is refused on insert and unreachable by update", async () => {
    await bound(app, A.venue, async () => {
      for (const t of SCOPED) {
        const mine = await keysOf(t, A.venue);
        const theirs = await keysOf(t, B.venue);
        expect(mine.length, `${t.table}: rows of A`).toBeGreaterThan(0);
        expect(theirs.length, `${t.table}: rows of B to hide`).toBeGreaterThan(0);
        const seen = await keysSeen(app, t);
        expect(seen, t.table).toEqual(mine);
        expect(seen.filter((k) => theirs.includes(k)), `${t.table}: rows of B seen`).toEqual([]);
        if (t.table === "reservation") {
          expect(seen).toEqual(expect.arrayContaining([...aLive, aCancelled]));
          for (const id of [...bLive, bCancelled]) expect(seen).not.toContain(id);
        }
      }
    });

    const refused = await bound(app, A.venue, async () => {
      await app.query("select set_config('dastar.actor', 'key:iso', true)");
      return await app.query(INSERT_RESERVATION, [B.venue, FAR, B.units[0]]).then(() => null, (e: unknown) => e);
    });
    expect(refused).toMatchObject({ code: "42501" });
    expect(mapPgError(refused)).toMatchObject({ code: "venue_scope_violation", retryable: false, sqlstate: "42501" });

    // the same statement shape reaches a reservation of the bound venue and none of the other
    const changed = await bound(app, A.venue, async () => {
      await app.query("select set_config('dastar.actor', 'key:iso', true)");
      const own = await app.query("update dastar.reservation set external_ref = 'x' where id = $1", [aLive[0]]);
      const foreign = await app.query("update dastar.reservation set external_ref = 'x' where id = $1", [bLive[0]]);
      return [own.rowCount, foreign.rowCount];
    });
    expect(changed).toEqual([1, 0]);
  });

  it("unbound, on a fresh connection and after a bind ended, every scoped table reads nothing and an insert is refused", async () => {
    const fresh = await connect(conn.app);
    try {
      await fresh.query("select set_config('dastar.actor', 'key:iso', false)");
      const sees = async (why: string): Promise<void> => {
        for (const t of SCOPED) {
          expect((await fresh.query(`select count(*)::int as n from dastar.${t.table}`)).rows[0].n, `${why}: ${t.table}`).toBe(0);
        }
        await expect(fresh.query(INSERT_RESERVATION, [A.venue, FAR, A.units[0]]), why).rejects.toMatchObject({ code: "42501" });
      };
      await sees("never bound");
      await fresh.query("begin");
      await fresh.query("select set_config('dastar.venue_id', $1, true)", [A.venue]);
      expect((await fresh.query("select count(*)::int as n from dastar.reservation")).rows[0].n).toBeGreaterThan(0);
      await fresh.query("commit");
      await sees("after a bind ended");
    } finally {
      await fresh.end();
    }
  });

  it("dastar_readonly and dastar_worker read every venue's rows", async () => {
    const worker = await connect(conn.worker);
    try {
      for (const [who, client] of [["dastar_readonly", readonly], ["dastar_worker", worker]] as const) {
        for (const t of SCOPED) {
          const all = (await owner.query(`select count(*)::int as n from dastar.${t.table}`)).rows[0].n as number;
          const seen = (await client.query(`select count(*)::int as n from dastar.${t.table}`)).rows[0].n as number;
          expect(all, `${t.table}: rows held`).toBeGreaterThan(0);
          expect(seen, `${who}: ${t.table}`).toBe(all);
        }
        const venues = (await client.query("select distinct venue_id from dastar.reservation")).rows.map((r) => r.venue_id as string);
        expect(venues, who).toEqual(expect.arrayContaining([A.venue, B.venue]));
      }
    } finally {
      await worker.end();
    }
  });

  it("the hold's overlap read keeps a range index condition under row-level security", async () => {
    const P = await seedVenue(owner);
    // 6 units for 200 days at one hour, every hold its own actor, so no cap and no overlap is in the way
    let i = 0;
    for (let day = 0; day < 200; day++) {
      for (const unit of P.units) {
        i += 1;
        const out = await hold(app, {
          venueId: P.venue, actor: `key:pin${i}`, traceId: `pin${i}`, idempotencyKey: `pin-k${i}`, partySize: 2,
          startsAt: new Date(Date.UTC(2047, 0, 1 + day, 19)).toISOString(), durationMinutes: 60, assignment: { kind: "unit", id: unit },
        });
        if (!out.ok) throw new Error(out.error.code);
      }
    }
    expect(i).toBe(1200);
    await owner.query("analyze dastar.reservation_unit");
    const during = rangeLiteral(new Date(Date.UTC(2047, 0, 1 + 100, 19)).toISOString(), 60);
    // the text of the overlap read in commands/hold.ts
    const plan = await bound(app, P.venue, async () => (await app.query(
      `explain (costs off)
       select distinct o.reservation_id as id
         from dastar.occupancy o
        where o.unit_id = any ($1::uuid[]) and o.during && $2::tstzrange`,
      [[P.units[2]!], during],
    )).rows.map((r) => r["QUERY PLAN"] as string));
    expect(plan.some((line) => /Index Cond:.*during &&/.test(line)), plan.join("\n")).toBe(true);
  }, 120_000);

  it("a venue cleared before commit does not hide a mismatched unit row from the membership check (DA010)", async () => {
    const during = "[2052-03-01T19:00:00.000Z,2052-03-01T20:00:00.000Z)";
    let id = "";
    await app.query("begin");
    try {
      await app.query("select set_config('dastar.actor', 'key:iso', true), set_config('dastar.venue_id', $1, true)", [A.venue]);
      id = (await app.query(INSERT_RESERVATION, [A.venue, during, A.units[2]])).rows[0].id as string;
      await app.query("insert into dastar.reservation_unit(venue_id, reservation_id, unit_id, during) values ($1, $2, $3, $4::tstzrange)", [A.venue, id, A.units[3], during]);
      await app.query("select set_config('dastar.venue_id', '', true)");
    } catch (e) {
      await app.query("rollback");
      throw e;
    }
    await expect(app.query("commit")).rejects.toMatchObject({ code: "DA010" });
    expect((await owner.query("select 1 from dastar.reservation where id = $1", [id])).rowCount).toBe(0);
  });

  it("every table with a venue_id column, and venue, has row-level security on and a venue_scope policy", async () => {
    const r = await owner.query(
      `select c.relname, c.relrowsecurity,
              array(select pol.polname::text from pg_policy pol where pol.polrelid = c.oid order by pol.polname) as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'dastar' and c.relkind in ('r', 'p')
          and (c.relname = 'venue' or exists (
                 select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'venue_id' and a.attnum > 0 and not a.attisdropped))
        order by c.relname`,
    );
    expect(r.rows.map((x) => x.relname as string).sort()).toEqual(SCOPED.map((t) => t.table).sort());
    for (const row of r.rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.policies, row.relname).toContain("venue_scope");
    }
  });

  it("confirm, cancel, and mint with another venue's id answer not_found for a reservation of this venue, and change nothing", async () => {
    const id = await place(A);
    const state = async () => ({
      row: (await owner.query("select * from dastar.reservation where id = $1", [id])).rows[0],
      audit: (await owner.query("select count(*)::int as n from dastar.audit_log where entity_id = $1", [id])).rows[0].n as number,
      outbox: (await owner.query("select count(*)::int as n from dastar.outbox where payload->>'reservation_id' = $1", [id])).rows[0].n as number,
    });
    const before = await state();
    const notFound = { name: "DastarError", code: "not_found" };
    await expect(confirm(app, { reservationId: id, actor: "key:iso", traceId: "iso-x1", venueId: B.venue })).rejects.toMatchObject(notFound);
    await expect(cancel(app, { reservationId: id, actor: "key:iso", traceId: "iso-x2", venueId: B.venue, reason: "test" })).rejects.toMatchObject(notFound);
    await expect(mintConfirmToken(app, { reservationId: id, actor: "key:iso", traceId: "iso-x3", venueId: B.venue })).rejects.toMatchObject(notFound);
    expect(await state()).toEqual(before);
    // the same call with the reservation's own venue reaches it
    expect((await mintConfirmToken(app, { reservationId: id, actor: "key:iso", traceId: "iso-x4", venueId: A.venue })).version).toBe(before.row.version + 1);
  });
});

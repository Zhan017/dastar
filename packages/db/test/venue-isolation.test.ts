import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool, type Client } from "pg";
import { createHash } from "node:crypto";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { seedVenue, type Seed } from "./helpers/seed.js";
import { createDastar, type Dastar } from "../src/handle.js";
import { hold, type HoldInput } from "../src/commands/hold.js";
import { cancel } from "../src/commands/cancel.js";
import { mintConfirmToken } from "../src/commands/mint-token.js";

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
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client, QueryResult } from "pg";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { setClock } from "./helpers/clock.js";
import { seedVenue, type Seed } from "./helpers/seed.js";
import { connectAs, waitForBackend, deadlockCountStable, pause, outcome, type Outcome } from "./helpers/wait.js";
import { mapPgError } from "../src/errors.js";
import { hold, rangeLiteral, type HoldInput, type HoldOutcome } from "../src/commands/hold.js";
import { confirm } from "../src/commands/confirm.js";
import { cancel } from "../src/commands/cancel.js";
import { seat, complete } from "../src/commands/seat.js";
import { expireDue } from "../src/commands/expire.js";

describe("admin guards", () => {
  let conn: Conn; let owner: Client; let app: Client; let worker: Client; let H: Client; let W: Client;
  let n = 0; let dayN = 0;

  beforeAll(async () => {
    conn = await cloneDatabase("admin_guards_test");
    owner = await connect(conn.owner);
    app = await connect(conn.app);
    worker = await connect(conn.worker);
    H = await connectAs(conn.app, "ag-H");
    W = await connectAs(conn.app, "ag-W");
  });
  afterAll(async () => {
    await W.end(); await H.end(); await worker.end(); await app.end(); await owner.end();
    await dropDatabase("admin_guards_test");
  });

  /** The two ways a row is written; the connections exist only once `beforeAll` has run, so each is read when a test starts. */
  const WRITERS: { who: string; client: () => Client }[] = [
    { who: "the owner", client: () => owner },
    { who: "dastar_app bound to the venue", client: () => app },
  ];

  /** A venue of its own for each scenario, so no reservation of another scenario is on its units. */
  const fresh = (): Promise<Seed> => seedVenue(owner);
  /** A fresh day in 2062 for each scenario. */
  const nextDay = (): number => ++dayN;
  const at = (day: number, hour: number, minute = 0): string => new Date(Date.UTC(2062, 0, day, hour, minute)).toISOString();

  function input(seed: Seed, startsAt: string, over: Partial<HoldInput> = {}): HoldInput {
    n += 1;
    return {
      venueId: seed.venue, actor: `key:ag${n}`, traceId: `ag-t${n}`, idempotencyKey: `ag-k${n}`,
      partySize: 2, startsAt, durationMinutes: 90, assignment: { kind: "unit", id: seed.units[0]! }, ...over,
    };
  }
  /** One hold through the engine; a refusal fails the test with its code. */
  async function place(seed: Seed, startsAt: string, over: Partial<HoldInput> = {}): Promise<string> {
    const out = await hold(app, input(seed, startsAt, over));
    if (!out.ok) throw new Error(out.error.code);
    return out.receipt.reservationId;
  }
  const ctx = (seed: Seed) => ({ actor: "key:desk", traceId: `ag-c${++n}`, venueId: seed.venue });
  const COMBO = (seed: Seed) => ({ partySize: 6, assignment: { kind: "combo", id: seed.combos[0]!.id } }) as const;

  type Status = "held" | "confirmed" | "seated" | "completed" | "cancelled" | "expired";
  /** A hold made on a clock an hour in the past is already due; nothing sweeps it until `expireDue` runs. */
  async function dueHold(seed: Seed, startsAt: string): Promise<string> {
    await setClock(app, new Date(Date.now() - 3_600_000).toISOString());
    return await place(seed, startsAt).finally(() => setClock(app, null));
  }
  /** A reservation of `seed`'s first unit at `startsAt` whose stored status is `status`; the expired one is stored by the sweeper. */
  async function reservationIn(seed: Seed, status: Status, startsAt: string): Promise<string> {
    if (status === "expired") {
      const id = await dueHold(seed, startsAt);
      const swept = await expireDue(worker, { limit: 100 });
      if (!swept.expired.includes(id)) throw new Error("the sweeper did not expire the hold");
      return id;
    }
    const id = await place(seed, startsAt);
    if (status === "held") return id;
    if (status === "cancelled") {
      await cancel(app, { reservationId: id, ...ctx(seed), reason: "guest" });
      return id;
    }
    await confirm(app, { reservationId: id, ...ctx(seed) });
    if (status === "confirmed") return id;
    await seat(app, { reservationId: id, ...ctx(seed) });
    if (status === "seated") return id;
    await complete(app, { reservationId: id, ...ctx(seed) });
    return id;
  }
  const storedStatus = async (id: string): Promise<string> =>
    (await owner.query("select status from dastar.reservation where id = $1", [id])).rows[0].status as string;
  const reservationsBy = async (actor: string): Promise<number> =>
    (await owner.query("select count(*)::int as n from dastar.reservation where created_by = $1", [actor])).rows[0].n as number;
  const idempotencyBy = async (actor: string): Promise<number> =>
    (await owner.query("select count(*)::int as n from dastar.idempotency where actor = $1", [actor])).rows[0].n as number;
  const activeOf = async (table: "unit" | "unit_combo", id: string): Promise<boolean> =>
    (await owner.query(`select active from dastar.${table} where id = $1`, [id])).rows[0].active as boolean;
  const advisoryHeld = async (appName: string, mode: "ExclusiveLock" | "ShareLock"): Promise<number> =>
    (await owner.query(
      `select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid = l.pid
        where a.datname = current_database() and a.application_name = $1 and l.locktype = 'advisory' and l.granted and l.mode = $2`,
      [appName, mode],
    )).rows[0].n as number;
  const refusal = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);

  /** One statement as `c`, in a transaction bound to `venueId` as an engine command binds it: committed when it succeeds, rolled back when it is refused. */
  async function writeBound(c: Client, venueId: string, sql: string, params: unknown[]): Promise<QueryResult> {
    await c.query("begin");
    try {
      await c.query("select set_config('dastar.venue_id', $1, true), set_config('dastar.actor', 'key:raw', true)", [venueId]);
      const r = await c.query(sql, params);
      await c.query("commit");
      return r;
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw e;
    }
  }
  const setUnitActive = (c: Client, seed: Seed, unit: string, active: boolean) =>
    writeBound(c, seed.venue, "update dastar.unit set active = $2 where id = $1", [unit, active]);
  const setComboActive = (c: Client, seed: Seed, combo: string, active: boolean) =>
    writeBound(c, seed.venue, "update dastar.unit_combo set active = $2 where id = $1", [combo, active]);

  const unitInUse = (unit: string, reservation: string) =>
    ({ code: "DA016", message: `unit ${unit} has a live reservation`, detail: `reservation=${reservation}`, hint: "invariant 12 assignment_in_use" });
  const comboInUse = (combo: string, reservation: string) =>
    ({ code: "DA016", message: `combination ${combo} has a live reservation`, detail: `reservation=${reservation}`, hint: "invariant 12 assignment_in_use" });
  const inactive = (assignment: string) =>
    ({ code: "DA015", message: `assignment ${assignment} is not active`, detail: expect.stringMatching(/^reservation=[0-9a-f-]{36}$/), hint: "invariant 12 assignment_inactive" });

  describe("unit deactivation (DA016)", () => {
    for (const { who, client: clientOf } of WRITERS) {
      it(`${who} cannot deactivate a unit that a held, a confirmed, a seated, or a combination reservation uses`, async () => {
        const client = clientOf();
        for (const status of ["held", "confirmed", "seated"] as const) {
          const S = await fresh(); const unit = S.units[0]!;
          const id = await reservationIn(S, status, at(nextDay(), 19));
          const refused = await refusal(setUnitActive(client, S, unit, false));
          expect(refused, status).toMatchObject(unitInUse(unit, id));
          expect(mapPgError(refused), status).toMatchObject({ code: "assignment_in_use", retryable: false, sqlstate: "DA016" });
          expect(await activeOf("unit", unit), status).toBe(true);
          expect(await storedStatus(id), status).toBe(status);
        }

        // a combination reservation holds an active row on each member, so each member is in use; a unit outside the combination is not
        const S = await fresh();
        const id = await place(S, at(nextDay(), 19), COMBO(S));
        for (const unit of S.combos[0]!.units) {
          const refused = await refusal(setUnitActive(client, S, unit, false));
          expect(refused, `member ${unit}`).toMatchObject(unitInUse(unit, id));
          expect(await activeOf("unit", unit), `member ${unit}`).toBe(true);
        }
        expect((await setUnitActive(client, S, S.units[2]!, false)).rowCount).toBe(1);
        expect(await activeOf("unit", S.units[2]!)).toBe(false);
      });

      it(`${who} deactivates a unit that only a cancelled, a completed, a swept expired, or an unswept expired reservation used`, async () => {
        const client = clientOf();
        for (const status of ["cancelled", "completed", "expired"] as const) {
          const S = await fresh(); const unit = S.units[0]!;
          const id = await reservationIn(S, status, at(nextDay(), 19));
          if (status === "completed") {
            // a completed reservation keeps its unit rows active, so only its status lets the deactivation through
            const rows = await owner.query("select active from dastar.reservation_unit where reservation_id = $1", [id]);
            expect(rows.rows).toEqual([{ active: true }]);
          }
          expect((await setUnitActive(client, S, unit, false)).rowCount, status).toBe(1);
          expect(await activeOf("unit", unit), status).toBe(false);
          expect(await storedStatus(id), status).toBe(status);
        }

        const S = await fresh(); const unit = S.units[0]!;
        const id = await dueHold(S, at(nextDay(), 19));
        // past its expiry and not swept: the stored status is still held, the effective status is expired
        expect(await storedStatus(id)).toBe("held");
        expect((await setUnitActive(client, S, unit, false)).rowCount).toBe(1);
        expect(await activeOf("unit", unit)).toBe(false);
        expect(await storedStatus(id)).toBe("held");
      });

      it(`${who} reactivates a unit without judgment, even where a reservation of it is live by a clock set back`, async () => {
        const client = clientOf();
        const S = await fresh(); const unit = S.units[0]!;
        const id = await dueHold(S, at(nextDay(), 19));
        const back = new Date(Date.now() - 3_600_000).toISOString();
        await setClock(client, back);
        try {
          // control: by this clock the hold is live, so the unit cannot be deactivated
          expect(await refusal(setUnitActive(client, S, unit, false))).toMatchObject(unitInUse(unit, id));
        } finally {
          await setClock(client, null);
        }
        expect((await setUnitActive(client, S, unit, false)).rowCount).toBe(1);
        expect(await activeOf("unit", unit)).toBe(false);
        await setClock(client, back);
        try {
          expect((await setUnitActive(client, S, unit, true)).rowCount).toBe(1);
        } finally {
          await setClock(client, null);
        }
        expect(await activeOf("unit", unit)).toBe(true);
      });

      it(`${who} updates a unit's other columns, and sets active to true, without judgment while a reservation of it is live`, async () => {
        const client = clientOf();
        const S = await fresh(); const unit = S.units[0]!;
        const id = await reservationIn(S, "confirmed", at(nextDay(), 19));
        // control: the same unit's deactivation is refused
        expect(await refusal(setUnitActive(client, S, unit, false))).toMatchObject(unitInUse(unit, id));
        expect((await writeBound(client, S.venue, "update dastar.unit set label = 'Renamed', layout = '{\"x\":1}'::jsonb where id = $1", [unit])).rowCount).toBe(1);
        expect((await writeBound(client, S.venue, "update dastar.unit set active = true where id = $1", [unit])).rowCount).toBe(1);
        expect((await writeBound(client, S.venue, "update dastar.unit set capacity_max = 6 where id = $1", [unit])).rowCount).toBe(1);
        const row = (await owner.query("select label, active, capacity_max from dastar.unit where id = $1", [unit])).rows[0];
        expect(row).toEqual({ label: "Renamed", active: true, capacity_max: 6 });
      });
    }
  });

  describe("combination deactivation (DA016)", () => {
    for (const { who, client: clientOf } of WRITERS) {
      it(`${who} cannot deactivate a combination that a held or a seated reservation is assigned to`, async () => {
        const client = clientOf();
        for (const status of ["held", "seated"] as const) {
          const S = await fresh(); const combo = S.combos[0]!.id;
          const day = nextDay();
          const id = await place(S, at(day, 19), COMBO(S));
          if (status === "seated") {
            await confirm(app, { reservationId: id, ...ctx(S) });
            await seat(app, { reservationId: id, ...ctx(S) });
          }
          const refused = await refusal(setComboActive(client, S, combo, false));
          expect(refused, status).toMatchObject(comboInUse(combo, id));
          expect(mapPgError(refused), status).toMatchObject({ code: "assignment_in_use", retryable: false, sqlstate: "DA016" });
          expect(await activeOf("unit_combo", combo), status).toBe(true);
          expect(await storedStatus(id), status).toBe(status);
        }
      });

      it(`${who} deactivates a combination that only a reservation of one of its member units uses`, async () => {
        const client = clientOf();
        const S = await fresh(); const combo = S.combos[0]!;
        const id = await place(S, at(nextDay(), 19), { assignment: { kind: "unit", id: combo.units[0]! } });
        expect((await setComboActive(client, S, combo.id, false)).rowCount).toBe(1);
        expect(await activeOf("unit_combo", combo.id)).toBe(false);
        expect(await storedStatus(id)).toBe("held");
      });

      it(`${who} deactivates a combination once its reservation is cancelled`, async () => {
        const client = clientOf();
        const S = await fresh(); const combo = S.combos[0]!.id;
        const id = await place(S, at(nextDay(), 19), COMBO(S));
        expect(await refusal(setComboActive(client, S, combo, false))).toMatchObject(comboInUse(combo, id));
        await cancel(app, { reservationId: id, ...ctx(S), reason: "guest" });
        expect((await setComboActive(client, S, combo, false)).rowCount).toBe(1);
        expect(await activeOf("unit_combo", combo)).toBe(false);
      });

      it(`${who} relabels and reactivates a combination without judgment while a reservation of it is live`, async () => {
        const client = clientOf();
        const S = await fresh(); const combo = S.combos[0]!.id;
        const id = await place(S, at(nextDay(), 19), COMBO(S));
        expect(await refusal(setComboActive(client, S, combo, false))).toMatchObject(comboInUse(combo, id));
        expect((await writeBound(client, S.venue, "update dastar.unit_combo set label = 'Renamed' where id = $1", [combo])).rowCount).toBe(1);
        expect((await setComboActive(client, S, combo, true)).rowCount).toBe(1);
        expect((await owner.query("select label, active from dastar.unit_combo where id = $1", [combo])).rows[0]).toEqual({ label: "Renamed", active: true });

        // a combination deactivated with no reservation reactivates and is bookable again
        const T = await fresh();
        expect((await setComboActive(client, T, T.combos[0]!.id, false)).rowCount).toBe(1);
        expect((await setComboActive(client, T, T.combos[0]!.id, true)).rowCount).toBe(1);
        expect(await activeOf("unit_combo", T.combos[0]!.id)).toBe(true);
        expect(await hold(app, input(T, at(nextDay(), 19), COMBO(T)))).toMatchObject({ ok: true });
      });
    }
  });

  describe("fit check on insert (DA015)", () => {
    it("a hold on an inactive unit is refused assignment_inactive by the command, and nothing is stored", async () => {
      const S = await fresh();
      expect((await setUnitActive(owner, S, S.units[0]!, false)).rowCount).toBe(1);
      const i = input(S, at(nextDay(), 19));
      await expect(hold(app, i)).rejects.toMatchObject({ name: "DastarError", code: "assignment_inactive", message: "assignment is deactivated" });
      expect(await reservationsBy(i.actor)).toBe(0);
      expect(await idempotencyBy(i.actor)).toBe(0);
    });

    it("a hold on an active combination with an inactive member unit is refused assignment_inactive by the fit trigger, and nothing is stored", async () => {
      const S = await fresh();
      const day = nextDay();
      const [open, shut] = [S.combos[1]!, S.combos[0]!];
      expect((await setUnitActive(owner, S, shut.units[0]!, false)).rowCount).toBe(1);
      expect(await activeOf("unit_combo", shut.id)).toBe(true);
      // a combination that does not contain the unit is unaffected
      expect(await hold(app, input(S, at(day, 19), { partySize: 6, assignment: { kind: "combo", id: open.id } }))).toMatchObject({ ok: true });

      const i = input(S, at(day, 19), COMBO(S));
      const refused = await refusal(hold(app, i));
      expect(refused).toMatchObject({ name: "DastarError", code: "assignment_inactive", sqlstate: "DA015", message: `assignment ${shut.id} is not active` });
      expect(await reservationsBy(i.actor)).toBe(0);
      expect(await idempotencyBy(i.actor)).toBe(0);
      expect((await owner.query("select count(*)::int as n from dastar.reservation_unit where venue_id = $1 and unit_id = any ($2::uuid[])", [S.venue, shut.units])).rows[0].n).toBe(0);

      // reactivating the unit makes the combination bookable again
      expect((await setUnitActive(owner, S, shut.units[0]!, true)).rowCount).toBe(1);
      expect(await hold(app, input(S, at(day, 19), COMBO(S)))).toMatchObject({ ok: true });
    });

    it("a combination that names a unit of another venue, or a unit that does not exist, is refused assignment_inactive, and nothing is stored", async () => {
      const S = await fresh(); const other = await fresh();
      const ABSENT = "00000000-0000-7000-8000-000000000001";
      const day = nextDay();
      for (const [label, member] of [["a unit of another venue", other.units[0]!], ["a unit that does not exist", ABSENT]] as const) {
        const members = [S.units[0]!, member].sort();
        const combo = (await owner.query(
          "insert into dastar.unit_combo(venue_id, label, unit_ids, capacity_min, capacity_max) values ($1, $2, $3::uuid[], 5, 8) returning id",
          [S.venue, label, members],
        )).rows[0].id as string;
        const i = input(S, at(day, 19), { partySize: 6, assignment: { kind: "combo", id: combo } });
        await expect(hold(app, i), label).rejects.toMatchObject({ code: "assignment_inactive", sqlstate: "DA015", message: `assignment ${combo} is not active` });
        expect(await reservationsBy(i.actor), label).toBe(0);
      }
    });

    /** A reservation row written directly, as a caller of the application role could write it, in a transaction that is always rolled back. */
    async function rawInsert(c: Client, S: Seed, kind: "unit" | "combo", assignment: string, party: number): Promise<unknown> {
      await c.query("begin");
      try {
        await c.query("select set_config('dastar.venue_id', $1, true), set_config('dastar.actor', 'key:raw', true)", [S.venue]);
        return await c.query(
          `insert into dastar.reservation(venue_id, party_size, during, status, assignment_kind, assignment_id, hold_expires_at, created_by)
           values ($1, $2, $3::tstzrange, 'held', $4, $5, dastar.dastar_now() + interval '10 minutes', 'key:raw')`,
          [S.venue, party, rangeLiteral(at(nextDay(), 19), 90), kind, assignment],
        ).then(() => null, (e: unknown) => e);
      } finally {
        await c.query("rollback");
      }
    }

    for (const { who, client: clientOf } of WRITERS) {
      it(`an insert by ${who} that bypasses the hold takes the check itself: an inactive unit, an inactive combination, and a combination over an inactive member are refused (DA015)`, async () => {
        const client = clientOf();
        const S = await fresh();
        const shutUnit = S.units[0]!; const shutCombo = S.combos[3]!.id; const overShut = S.combos[0]!.id;
        expect((await setUnitActive(owner, S, shutUnit, false)).rowCount).toBe(1);
        expect((await setComboActive(owner, S, shutCombo, false)).rowCount).toBe(1);

        for (const [label, kind, id, party] of [
          ["an inactive unit", "unit", shutUnit, 2],
          ["an inactive combination", "combo", shutCombo, 6],
          ["a combination over an inactive member", "combo", overShut, 6],
        ] as const) {
          const refused = await rawInsert(client, S, kind, id, party);
          expect(refused, label).toMatchObject(inactive(id));
          expect(mapPgError(refused), label).toMatchObject({ code: "assignment_inactive", retryable: false, sqlstate: "DA015" });
        }
        // controls: the same statements on an active unit and on a combination whose members are all active are not refused
        expect(await rawInsert(client, S, "unit", S.units[4]!, 2)).toBeNull();
        expect(await rawInsert(client, S, "combo", S.combos[1]!.id, 6)).toBeNull();
        expect(await reservationsBy("key:raw")).toBe(0);
      });
    }

    it("trg_fit is still owner-run with its pinned search path, executable by no role, and attached to the same events, and the guards are attached to their tables", async () => {
      const fn = (await owner.query(
        `select pg_get_userbyid(p.proowner)::text as owner, p.prosecdef, p.proconfig
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'dastar' and p.proname = 'trg_fit'`,
      )).rows;
      expect(fn).toHaveLength(1);
      expect(fn[0]).toMatchObject({ owner: "dastar_owner", prosecdef: true });
      expect(fn[0].proconfig).toContain("search_path=pg_catalog, dastar, pg_temp");
      for (const role of ["dastar_app", "dastar_worker", "dastar_readonly"]) {
        expect((await owner.query("select has_function_privilege($1::name, 'dastar.trg_fit()', 'EXECUTE') as ok", [role])).rows[0].ok, role).toBe(false);
      }

      const defs = new Map((await owner.query(
        `select t.tgname::text as name, pg_get_triggerdef(t.oid) as def, t.tgenabled::text as enabled
           from pg_trigger t where not t.tgisinternal and t.tgname = any ($1::text[])`,
        [["t40_fit", "t44_unit_active_guard", "t44_combo_active_guard", "t49_venue_timezone"]],
      )).rows.map((r) => [r.name as string, r] as const));
      expect([...defs.keys()].sort()).toEqual(["t40_fit", "t44_combo_active_guard", "t44_unit_active_guard", "t49_venue_timezone"]);
      for (const r of defs.values()) expect(r.enabled, r.name).toBe("O");
      expect(defs.get("t40_fit")!.def).toMatch(/BEFORE INSERT OR UPDATE OF party_size, assignment_kind, assignment_id, status ON (dastar\.)?reservation FOR EACH ROW EXECUTE FUNCTION (dastar\.)?trg_fit\(\)/);
      expect(defs.get("t44_unit_active_guard")!.def).toMatch(/BEFORE UPDATE OF active ON (dastar\.)?unit FOR EACH ROW EXECUTE FUNCTION (dastar\.)?trg_unit_active_guard\(\)/);
      expect(defs.get("t44_combo_active_guard")!.def).toMatch(/BEFORE UPDATE OF active ON (dastar\.)?unit_combo FOR EACH ROW EXECUTE FUNCTION (dastar\.)?trg_combo_active_guard\(\)/);
      expect(defs.get("t49_venue_timezone")!.def).toMatch(/BEFORE INSERT OR UPDATE OF timezone ON (dastar\.)?venue FOR EACH ROW EXECUTE FUNCTION (dastar\.)?trg_venue_timezone\(\)/);
    });
  });

  describe("fit check on the confirmation of a hold (DA015)", () => {
    /** A deactivation by the owner on a clock an hour ahead, by which a hold placed now is expired and the guard lets it through. */
    async function deactivateByLaterClock(deactivate: () => Promise<QueryResult>): Promise<void> {
      await setClock(owner, new Date(Date.now() + 3_600_000).toISOString());
      try {
        expect((await deactivate()).rowCount).toBe(1);
      } finally {
        await setClock(owner, null);
      }
    }

    it("a hold whose unit a later clock deactivated is refused assignment_inactive when confirmed on the real clock, and stays held", async () => {
      const S = await fresh(); const unit = S.units[0]!;
      const id = await place(S, at(nextDay(), 19));
      // control: the hold is live by the real clock, so the same deactivation is refused
      expect(await refusal(setUnitActive(owner, S, unit, false))).toMatchObject(unitInUse(unit, id));
      await deactivateByLaterClock(() => setUnitActive(owner, S, unit, false));
      expect(await activeOf("unit", unit)).toBe(false);
      expect(await storedStatus(id)).toBe("held");

      const refused = await refusal(confirm(app, { reservationId: id, ...ctx(S) }));
      expect(refused).toMatchObject({ name: "DastarError", code: "assignment_inactive", sqlstate: "DA015", message: `assignment ${unit} is not active` });
      expect(await storedStatus(id)).toBe("held");

      // reactivating the unit lets the same hold be confirmed
      expect((await setUnitActive(owner, S, unit, true)).rowCount).toBe(1);
      expect(await confirm(app, { reservationId: id, ...ctx(S) })).toMatchObject({ reservationId: id, status: "confirmed" });
    });

    it("a hold on a combination whose member unit a later clock deactivated is refused assignment_inactive when confirmed, and stays held", async () => {
      const S = await fresh(); const combo = S.combos[0]!;
      const id = await place(S, at(nextDay(), 19), COMBO(S));
      const member = combo.units[0]!;
      expect(await refusal(setUnitActive(owner, S, member, false))).toMatchObject(unitInUse(member, id));
      await deactivateByLaterClock(() => setUnitActive(owner, S, member, false));
      expect(await activeOf("unit", member)).toBe(false);
      expect(await activeOf("unit_combo", combo.id)).toBe(true);

      const refused = await refusal(confirm(app, { reservationId: id, ...ctx(S) }));
      expect(refused).toMatchObject({ name: "DastarError", code: "assignment_inactive", sqlstate: "DA015", message: `assignment ${combo.id} is not active` });
      expect(await storedStatus(id)).toBe("held");
    });
  });

  describe("venue time zone (DA017)", () => {
    const newId = async (): Promise<string> => (await owner.query("select uuidv7() as id")).rows[0].id as string;
    /** A venue written by `c`, bound to its own id as an engine command binds it. */
    async function insertVenue(c: Client, name: string, timezone: string): Promise<string> {
      const id = await newId();
      await writeBound(c, id, "insert into dastar.venue(id, name, timezone) values ($1, $2, $3)", [id, name, timezone]);
      return id;
    }
    const setZone = (c: Client, venueId: string, timezone: string) =>
      writeBound(c, venueId, "update dastar.venue set timezone = $2 where id = $1", [venueId, timezone]);
    const zoneOf = async (venueId: string): Promise<string> =>
      (await owner.query("select timezone from dastar.venue where id = $1", [venueId])).rows[0].timezone as string;

    for (const { who, client: clientOf } of WRITERS) {
      it(`${who} is refused a venue with a time zone Postgres does not know, and one update to such a zone`, async () => {
        const client = clientOf();
        const id = await newId();
        const refused = await refusal(writeBound(client, id, "insert into dastar.venue(id, name, timezone) values ($1, 'tz-refused', 'Mars/Olympus')", [id]));
        expect(refused).toMatchObject({ code: "DA017", message: "unknown time zone Mars/Olympus", hint: "invalid_timezone" });
        expect(mapPgError(refused)).toMatchObject({ code: "invalid_timezone", retryable: false, sqlstate: "DA017" });
        expect((await owner.query("select count(*)::int as n from dastar.venue where id = $1 or name = 'tz-refused'", [id])).rows[0].n).toBe(0);

        // a misspelt name with a trailing digit would read as a POSIX offset rule to `at time zone`; only exact names pass
        for (const zone of ["Europe/Berln2", "UTC+5", "utc"]) {
          const refusedName = await refusal(writeBound(client, id, "insert into dastar.venue(id, name, timezone) values ($1, 'tz-refused', $2)", [id, zone]));
          expect(refusedName, zone).toMatchObject({ code: "DA017", message: `unknown time zone ${zone}` });
        }

        const venue = await insertVenue(client, "tz-update", "UTC");
        const refusedUpdate = await refusal(setZone(client, venue, "Not/AZone"));
        expect(refusedUpdate).toMatchObject({ code: "DA017", message: "unknown time zone Not/AZone", hint: "invalid_timezone" });
        expect(mapPgError(refusedUpdate)).toMatchObject({ code: "invalid_timezone" });
        expect(await zoneOf(venue)).toBe("UTC");
      });

      it(`${who} writes UTC, Asia/Almaty, and America/New_York on insert and on update`, async () => {
        const client = clientOf();
        for (const zone of ["UTC", "Asia/Almaty", "America/New_York"]) {
          const inserted = await insertVenue(client, `tz-ok-${zone}`, zone);
          expect(await zoneOf(inserted), `insert ${zone}`).toBe(zone);
        }
        const venue = await insertVenue(client, "tz-ok-update", "Europe/Berlin");
        for (const zone of ["UTC", "Asia/Almaty", "America/New_York"]) {
          expect((await setZone(client, venue, zone)).rowCount, `update ${zone}`).toBe(1);
          expect(await zoneOf(venue), `update ${zone}`).toBe(zone);
        }
      });

      it(`${who} changes other columns of a venue that already holds an unknown zone: an update that leaves the zone alone is not judged`, async () => {
        const client = clientOf();
        const id = await newId();
        // a row written before the guard existed, which no insert can write now
        await owner.query("alter table dastar.venue disable trigger t49_venue_timezone");
        try {
          await owner.query("insert into dastar.venue(id, name, timezone) values ($1, 'legacy', 'Legacy/Zone')", [id]);
        } finally {
          await owner.query("alter table dastar.venue enable trigger t49_venue_timezone");
        }
        // control: with the trigger back, an update that names the column is judged
        expect(await refusal(setZone(client, id, "Legacy/Zone2"))).toMatchObject({ code: "DA017" });
        expect((await writeBound(client, id, "update dastar.venue set name = 'legacy renamed', hold_ttl_seconds = 900 where id = $1", [id])).rowCount).toBe(1);
        const row = (await owner.query("select name, hold_ttl_seconds, timezone from dastar.venue where id = $1", [id])).rows[0];
        expect(row).toEqual({ name: "legacy renamed", hold_ttl_seconds: 900, timezone: "Legacy/Zone" });
      });
    }
  });

  describe("two connections on the unit locks", () => {
    const settled = <T>(o: Outcome<T>): T => {
      if (!o.ok) throw o.error instanceof Error ? o.error : new Error(String(o.error));
      return o.value;
    };
    const receiptOf = (out: HoldOutcome): string => (out as { receipt: { reservationId: string } }).receipt.reservationId;

    it("(a) a raw unit deactivation queues on the unit lock behind a hold paused after its unit locks, then is refused DA016 naming the hold's reservation", async () => {
      const before = await deadlockCountStable(owner);
      const S = await fresh(); const unit = S.units[0]!;
      const i = input(S, at(nextDay(), 19));
      const p = pause();
      const retries: string[] = [];
      const pHold = outcome(hold(H, i, { afterUnitLocks: p.hook, onRetry: (r) => { retries.push(r.sqlstate); } }));
      let pDeactivate: Promise<Outcome<unknown>> | undefined;
      try {
        await p.reached;
        expect(await advisoryHeld("ag-H", "ExclusiveLock")).toBe(1);
        await W.query("begin");
        await W.query("select set_config('dastar.venue_id', $1, true)", [S.venue]);
        pDeactivate = outcome(W.query("update dastar.unit set active = false where id = $1", [unit]));
        await waitForBackend(owner, "ag-W", { type: "Lock", event: "advisory" });
        p.release();
        const reservationId = receiptOf(settled(await pHold));
        expect(await pDeactivate).toMatchObject({ ok: false, error: unitInUse(unit, reservationId) });
        expect(retries).toEqual([]);
        expect(await storedStatus(reservationId)).toBe("held");
      } finally {
        p.release();
        if (pDeactivate) await pDeactivate;
        await W.query("rollback").catch(() => undefined);
      }
      expect(await activeOf("unit", unit)).toBe(true);
      expect(await advisoryHeld("ag-H", "ExclusiveLock") + await advisoryHeld("ag-W", "ExclusiveLock")).toBe(0);
      expect(await deadlockCountStable(owner)).toBe(before);
    });

    it("(b) a hold that resolved its unit as active queues on the unit lock behind a raw deactivation, then is refused assignment_inactive by the fit trigger and stores nothing", async () => {
      const before = await deadlockCountStable(owner);
      const S = await fresh(); const unit = S.units[0]!;
      const i = input(S, at(nextDay(), 19));
      const retries: string[] = [];
      await W.query("begin");
      let pHold!: Promise<Outcome<HoldOutcome>>;
      try {
        await W.query("select set_config('dastar.venue_id', $1, true)", [S.venue]);
        expect((await W.query("update dastar.unit set active = false where id = $1", [unit])).rowCount).toBe(1);
        // the guard took the unit lock, and the deactivation is not committed, so the hold still reads the unit as active
        expect(await advisoryHeld("ag-W", "ExclusiveLock")).toBe(1);
        pHold = outcome(hold(H, i, { onRetry: (r) => { retries.push(r.sqlstate); } }));
        await waitForBackend(owner, "ag-H", { type: "Lock", event: "advisory" });
        await W.query("commit");
      } catch (e) {
        await W.query("rollback").catch(() => undefined);
        await pHold;
        throw e;
      }
      const out = await pHold;
      expect(out.ok).toBe(false);
      // the command's own check reads "assignment is deactivated" without a SQLSTATE; this refusal came from the trigger
      expect(out).toMatchObject({ ok: false, error: { name: "DastarError", code: "assignment_inactive", sqlstate: "DA015", message: `assignment ${unit} is not active` } });
      expect(retries).toEqual([]);
      expect(await reservationsBy(i.actor)).toBe(0);
      expect(await idempotencyBy(i.actor)).toBe(0);
      expect(await activeOf("unit", unit)).toBe(false);
      expect(await deadlockCountStable(owner)).toBe(before);
    });

    it("(c) a raw combination deactivation queues on the member unit locks behind a hold on the combination paused after its unit locks, then is refused DA016", async () => {
      const before = await deadlockCountStable(owner);
      const S = await fresh(); const combo = S.combos[0]!.id;
      const i = input(S, at(nextDay(), 19), COMBO(S));
      const p = pause();
      const retries: string[] = [];
      const pHold = outcome(hold(H, i, { afterUnitLocks: p.hook, onRetry: (r) => { retries.push(r.sqlstate); } }));
      let pDeactivate: Promise<Outcome<unknown>> | undefined;
      try {
        await p.reached;
        // one lock for each member of the combination
        expect(await advisoryHeld("ag-H", "ExclusiveLock")).toBe(2);
        await W.query("begin");
        await W.query("select set_config('dastar.venue_id', $1, true)", [S.venue]);
        pDeactivate = outcome(W.query("update dastar.unit_combo set active = false where id = $1", [combo]));
        await waitForBackend(owner, "ag-W", { type: "Lock", event: "advisory" });
        p.release();
        const reservationId = receiptOf(settled(await pHold));
        expect(await pDeactivate).toMatchObject({ ok: false, error: comboInUse(combo, reservationId) });
        expect(retries).toEqual([]);
        expect(await storedStatus(reservationId)).toBe("held");
      } finally {
        p.release();
        if (pDeactivate) await pDeactivate;
        await W.query("rollback").catch(() => undefined);
      }
      expect(await activeOf("unit_combo", combo)).toBe(true);
      expect(await advisoryHeld("ag-H", "ExclusiveLock") + await advisoryHeld("ag-W", "ExclusiveLock")).toBe(0);
      expect(await deadlockCountStable(owner)).toBe(before);
    });

    it("(d) a confirmation queues on the unit lock behind a deactivation on a later clock that judged its hold expired, then is refused assignment_inactive and the hold stays held", async () => {
      const before = await deadlockCountStable(owner);
      const S = await fresh(); const unit = S.units[0]!;
      const id = await place(S, at(nextDay(), 19));
      let pConfirm: Promise<Outcome<unknown>> | undefined;
      await setClock(W, new Date(Date.now() + 3_600_000).toISOString());
      try {
        await W.query("begin");
        await W.query("select set_config('dastar.venue_id', $1, true)", [S.venue]);
        // by W's clock the hold is expired, so the guard lets the deactivation through and keeps the unit lock
        expect((await W.query("update dastar.unit set active = false where id = $1", [unit])).rowCount).toBe(1);
        expect(await advisoryHeld("ag-W", "ExclusiveLock")).toBe(1);
        // the confirmation runs on the real clock, by which the hold is live
        pConfirm = outcome(confirm(H, { reservationId: id, ...ctx(S) }));
        await waitForBackend(owner, "ag-H", { type: "Lock", event: "advisory" });
        expect(await storedStatus(id)).toBe("held");
        await W.query("commit");
      } catch (e) {
        await W.query("rollback").catch(() => undefined);
        if (pConfirm) await pConfirm;
        throw e;
      } finally {
        await setClock(W, null);
      }
      expect(await pConfirm).toMatchObject({ ok: false, error: { name: "DastarError", code: "assignment_inactive", sqlstate: "DA015", message: `assignment ${unit} is not active` } });
      expect(await storedStatus(id)).toBe("held");
      expect(await activeOf("unit", unit)).toBe(false);
      expect(await advisoryHeld("ag-H", "ExclusiveLock") + await advisoryHeld("ag-W", "ExclusiveLock")).toBe(0);
      expect(await deadlockCountStable(owner)).toBe(before);
    });
  });
});

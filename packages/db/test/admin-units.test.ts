import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool, type Client } from "pg";
import { BOUNDS } from "@dastar/core";
import { cloneDatabase, dropDatabase, connect, type Conn } from "./helpers/db.js";
import { setClock } from "./helpers/clock.js";
import { seedVenue, type Seed } from "./helpers/seed.js";
import { connectAs, waitForBackend, deadlockCountStable, pause, outcome, type Outcome } from "./helpers/wait.js";
import { hold, type HoldInput, type HoldOutcome } from "../src/commands/hold.js";
import { confirm } from "../src/commands/confirm.js";
import { cancel } from "../src/commands/cancel.js";
import { seat, complete } from "../src/commands/seat.js";
import { adminRead, adminTx, adminWrite, LIVE, type AdminContext, type AdminOutcome } from "../src/commands/admin.js";
import { createUnit, updateUnit, listUnits, createCombo, updateCombo, listCombos } from "../src/commands/admin-units.js";
import { createDastar } from "../src/handle.js";

describe("admin commands: units and combinations", () => {
  let conn: Conn; let owner: Client; let app: Client; let H: Client; let W: Client;
  let n = 0; let dayN = 0;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const ABSENT = "00000000-0000-7000-8000-000000000001";

  beforeAll(async () => {
    conn = await cloneDatabase("admin_units_test");
    owner = await connect(conn.owner);
    app = await connect(conn.app);
    H = await connectAs(conn.app, "au-H");
    W = await connectAs(conn.app, "au-W");
  });
  afterAll(async () => {
    await W.end(); await H.end(); await app.end(); await owner.end();
    await dropDatabase("admin_units_test");
  });

  /** A venue of its own for each scenario, so no reservation of another scenario is on its units. */
  const fresh = (): Promise<Seed> => seedVenue(owner);
  /** A fresh day in 2062 for each scenario. */
  const nextDay = (): number => ++dayN;
  const at = (day: number, hour: number, minute = 0): string => new Date(Date.UTC(2062, 0, day, hour, minute)).toISOString();
  /** The i-th day of a run of consecutive days in 2063, for the scenario that needs hundreds of reservations on one unit. */
  const farAt = (i: number): string => new Date(Date.UTC(2063, 0, 1 + i, 19)).toISOString();

  /** The context of an admin write, with a trace id of its own. */
  const ctx = (seed: Seed): AdminContext => ({ venueId: seed.venue, actor: "key:admin", traceId: `au-c${++n}` });
  const desk = (seed: Seed) => ({ actor: "key:desk", traceId: `au-d${++n}`, venueId: seed.venue });
  const COMBO = (seed: Seed) => ({ partySize: 6, assignment: { kind: "combo", id: seed.combos[0]!.id } }) as const;

  function input(seed: Seed, startsAt: string, over: Partial<HoldInput> = {}): HoldInput {
    n += 1;
    return {
      venueId: seed.venue, actor: `key:au${n}`, traceId: `au-t${n}`, idempotencyKey: `au-k${n}`,
      partySize: 2, startsAt, durationMinutes: 90, assignment: { kind: "unit", id: seed.units[0]! }, ...over,
    };
  }
  /** One hold through the engine; a refusal fails the test with its code. */
  async function place(seed: Seed, startsAt: string, over: Partial<HoldInput> = {}): Promise<string> {
    const out = await hold(app, input(seed, startsAt, over));
    if (!out.ok) throw new Error(out.error.code);
    return out.receipt.reservationId;
  }
  async function confirmedAt(seed: Seed, startsAt: string, over: Partial<HoldInput> = {}): Promise<string> {
    const id = await place(seed, startsAt, over);
    await confirm(app, { reservationId: id, ...desk(seed) });
    return id;
  }
  async function seatedAt(seed: Seed, startsAt: string, over: Partial<HoldInput> = {}): Promise<string> {
    const id = await confirmedAt(seed, startsAt, over);
    await seat(app, { reservationId: id, ...desk(seed) });
    return id;
  }

  /** The outcome of a write that must refuse, narrowed to the refusal. */
  function refused<T>(out: AdminOutcome<T>): Extract<AdminOutcome<T>, { ok: false }> {
    if (out.ok) throw new Error(`expected a refusal, got ok with cancelled=[${out.cancelled.join(",")}]`);
    return out;
  }
  /** The outcome of a write that must succeed, narrowed to the success. */
  function accepted<T>(out: AdminOutcome<T>): Extract<AdminOutcome<T>, { ok: true }> {
    if (!out.ok) throw new Error(`expected ok, got ${out.error.code}: ${out.error.message}`);
    return out;
  }
  const settled = <T>(o: Outcome<T>): T => {
    if (!o.ok) throw o.error instanceof Error ? o.error : new Error(String(o.error));
    return o.value;
  };

  const storedRow = async (id: string) =>
    (await owner.query("select status, cancel_reason from dastar.reservation where id = $1", [id])).rows[0] as { status: string; cancel_reason: string | null };
  const cancelEvents = async (venueId: string, id: string): Promise<Record<string, unknown>[]> =>
    (await owner.query(
      "select payload from dastar.outbox where venue_id = $1 and topic = 'reservation.cancelled' and payload->>'reservation_id' = $2",
      [venueId, id],
    )).rows.map((r) => r.payload as Record<string, unknown>);
  const cancelEventCount = async (venueId: string): Promise<number> =>
    (await owner.query("select count(*)::int as n from dastar.outbox where venue_id = $1 and topic = 'reservation.cancelled'", [venueId])).rows[0].n as number;
  const unitRow = async (id: string) =>
    (await owner.query("select label, capacity_min, capacity_max, active, layout from dastar.unit where id = $1", [id])).rows[0] as
      { label: string; capacity_min: number; capacity_max: number; active: boolean; layout: unknown };
  const comboRow = async (id: string) =>
    (await owner.query("select label, active from dastar.unit_combo where id = $1", [id])).rows[0] as { label: string; active: boolean };
  const configVersion = async (venueId: string): Promise<number> =>
    Number((await owner.query("select config_version from dastar.venue where id = $1", [venueId])).rows[0].config_version);
  const countRows = async (table: "unit" | "unit_combo", venueId: string): Promise<number> =>
    (await owner.query(`select count(*)::int as n from dastar.${table} where venue_id = $1`, [venueId])).rows[0].n as number;
  const advisoryHeld = async (appName: string, mode: "ExclusiveLock" | "ShareLock"): Promise<number> =>
    (await owner.query(
      `select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid = l.pid
        where a.datname = current_database() and a.application_name = $1 and l.locktype = 'advisory' and l.granted and l.mode = $2`,
      [appName, mode],
    )).rows[0].n as number;

  /** A reservation the admin write cancelled: stored cancelled with the reason, one outbox event, one audit row written under the write's actor and trace. */
  async function expectCancelledByAdmin(seed: Seed, id: string, reason: string, c: AdminContext): Promise<void> {
    expect(await storedRow(id), id).toEqual({ status: "cancelled", cancel_reason: reason });
    const events = await cancelEvents(seed.venue, id);
    expect(events, id).toHaveLength(1);
    expect(events[0], id).toMatchObject({ reservation_id: id, venue_id: seed.venue, status: "cancelled" });
    const audit = (await owner.query("select actor, trace_id from dastar.audit_log where entity_id = $1 and action like 'update:%>cancelled'", [id])).rows;
    expect(audit, id).toEqual([{ actor: c.actor, trace_id: c.traceId }]);
  }
  /** A reservation the admin write left alone: its stored status is unchanged and nothing was published for it. */
  async function expectUntouched(seed: Seed, id: string, status: string): Promise<void> {
    expect(await storedRow(id), id).toEqual({ status, cancel_reason: null });
    expect(await cancelEvents(seed.venue, id), id).toEqual([]);
  }

  describe("the shared transaction helpers", () => {
    it("adminWrite takes the venue lock exclusively, commits an outcome that is ok, and rolls back one that refuses and one that throws", async () => {
      const S = await fresh();
      const add = (label: string) =>
        app.query("insert into dastar.unit (venue_id, label, capacity_min, capacity_max) values ($1, $2, 1, 2)", [S.venue, label]);
      const held = async () =>
        (await app.query("select count(*)::int as n from pg_locks where pid = pg_backend_pid() and locktype = 'advisory' and granted and mode = 'ExclusiveLock'")).rows[0].n as number;
      const labels = async () =>
        (await owner.query("select label from dastar.unit where venue_id = $1 and label like 'probe-%' order by label", [S.venue])).rows.map((r) => r.label as string);

      let during = -1;
      const ok = await adminWrite(app, ctx(S), async (): Promise<AdminOutcome<number>> => {
        during = await held();
        await add("probe-ok");
        return { ok: true, value: 7, cancelled: [] };
      });
      expect(ok).toEqual({ ok: true, value: 7, cancelled: [] });
      expect(during).toBe(1);
      expect(await held()).toBe(0);

      const no = await adminWrite(app, ctx(S), async (): Promise<AdminOutcome<number>> => {
        await add("probe-refused");
        return { ok: false, error: { code: "capacity_conflict", message: "probe" }, stranded: [ABSENT] };
      });
      expect(no).toEqual({ ok: false, error: { code: "capacity_conflict", message: "probe" }, stranded: [ABSENT] });
      expect(await held()).toBe(0);

      await expect(adminWrite(app, ctx(S), async (): Promise<AdminOutcome<number>> => {
        await add("probe-threw");
        throw new Error("boom");
      })).rejects.toMatchObject({ name: "DastarError", code: "internal", message: "boom" });
      expect(await held()).toBe(0);

      // a check violation inside the write is mapped, and the transaction is rolled back
      await expect(adminWrite(app, ctx(S), async (): Promise<AdminOutcome<number>> => {
        await app.query("insert into dastar.unit (venue_id, label, capacity_min, capacity_max) values ($1, 'probe-check', 3, 1)", [S.venue]);
        return { ok: true, value: 0, cancelled: [] };
      })).rejects.toMatchObject({ name: "DastarError", code: "invalid_input", sqlstate: "23514" });

      expect(await labels()).toEqual(["probe-ok"]);
    });

    it("adminTx takes the venue lock exclusively and commits what `fn` returns, and rolls back when it throws", async () => {
      const S = await fresh();
      const held = async () =>
        (await app.query("select count(*)::int as n from pg_locks where pid = pg_backend_pid() and locktype = 'advisory' and granted and mode = 'ExclusiveLock'")).rows[0].n as number;
      const add = (label: string) => app.query("insert into dastar.unit (venue_id, label, capacity_min, capacity_max) values ($1, $2, 1, 2)", [S.venue, label]);

      let during = -1;
      expect(await adminTx(app, ctx(S), async () => { during = await held(); await add("probe-tx-ok"); return "done"; })).toBe("done");
      expect(during).toBe(1);
      await expect(adminTx(app, ctx(S), async () => { await add("probe-tx-threw"); throw new Error("boom"); })).rejects.toMatchObject({ code: "internal", message: "boom" });
      expect(await held()).toBe(0);
      const labels = (await owner.query("select label from dastar.unit where venue_id = $1 and label like 'probe-tx-%'", [S.venue])).rows.map((r) => r.label);
      expect(labels).toEqual(["probe-tx-ok"]);
    });

    it("a transaction is bound to its venue: a query with no venue predicate reads only that venue's reservations, in a write and in a read", async () => {
      const S = await fresh(); const O = await fresh();
      const mine = await place(S, at(nextDay(), 19));
      const theirs = await place(O, at(nextDay(), 19));
      const live = `select r.id from dastar.reservation r where ${LIVE} order by r.id`;

      // controls: the owner sees both, and the application role unbound sees neither
      const both = (await owner.query(`select r.id from dastar.reservation r where ${LIVE} and r.venue_id = any ($1::uuid[])`, [[S.venue, O.venue]])).rows.map((r) => r.id as string);
      expect([...both].sort()).toEqual([mine, theirs].sort());
      expect((await app.query(live)).rows).toEqual([]);

      const seenByWrite = await adminWrite(app, ctx(S), async (): Promise<AdminOutcome<null>> => {
        const r = await app.query(live);
        return { ok: false, error: { code: "capacity_conflict", message: "probe" }, stranded: r.rows.map((x) => x.id as string) };
      });
      expect(refused(seenByWrite).stranded).toEqual([mine]);
      expect(await adminRead(app, S.venue, async () => (await app.query(live)).rows.map((r) => r.id as string))).toEqual([mine]);
      expect(await adminRead(app, O.venue, async () => (await app.query(live)).rows.map((r) => r.id as string))).toEqual([theirs]);
    });
  });

  const LAYOUT_REFUSED = "layout must be a JSON object without NUL characters or unpaired surrogates";
  /** Layouts Postgres cannot store, or that are not objects; the types refuse some of them, so each use casts. */
  const BAD_LAYOUTS: [string, unknown][] = [
    ["a NUL in a value", { note: "a\u0000b" }],
    ["a NUL in a key", { "a\u0000b": 1 }],
    ["a NUL in a nested value", { rows: [{ name: "x\u0000" }] }],
    ["a lone high surrogate", { note: "\ud800" }],
    ["a lone low surrogate", { note: "\udc00" }],
    ["a lone surrogate in a key", { "\ud800": 1 }],
    ["a high surrogate followed by a letter", { note: "\ud83dx" }],
    ["an array", [1, 2]],
    ["null", null],
    ["a string", "text"],
  ];

  describe("createUnit and listUnits", () => {
    it("createUnit returns the view, stores the row, and steps the config version once", async () => {
      const S = await fresh();
      const before = await configVersion(S.venue);
      const view = await createUnit(app, ctx(S), { label: "Patio 1", capacityMin: 2, capacityMax: 6, layout: { x: 10, tags: ["outdoor"] } });
      expect(view).toEqual({ id: expect.stringMatching(UUID), label: "Patio 1", capacityMin: 2, capacityMax: 6, active: true, layout: { x: 10, tags: ["outdoor"] } });
      expect(await configVersion(S.venue)).toBe(before + 1);
      expect(await unitRow(view.id)).toEqual({ label: "Patio 1", capacity_min: 2, capacity_max: 6, active: true, layout: { x: 10, tags: ["outdoor"] } });
      expect((await owner.query("select venue_id from dastar.unit where id = $1", [view.id])).rows[0].venue_id).toBe(S.venue);

      const plain = await createUnit(app, ctx(S), { label: "Patio 2", capacityMin: 1, capacityMax: 1 });
      expect(plain.layout).toEqual({});
      expect(await configVersion(S.venue)).toBe(before + 2);
    });

    it("createUnit refuses capacity_max below capacity_min and capacity_min below 1 as invalid_input and writes nothing", async () => {
      const S = await fresh();
      const before = await configVersion(S.venue);
      const units = await countRows("unit", S.venue);
      for (const [label, min, max] of [["max below min", 5, 3], ["min zero", 0, 4]] as const) {
        await expect(createUnit(app, ctx(S), { label: `bad ${label}`, capacityMin: min, capacityMax: max }), label)
          .rejects.toMatchObject({ name: "DastarError", code: "invalid_input", retryable: false, sqlstate: "23514" });
      }
      expect(await countRows("unit", S.venue)).toBe(units);
      expect(await configVersion(S.venue)).toBe(before);
      // control: the refused transactions were rolled back, so the connection takes the next create
      expect(await createUnit(app, ctx(S), { label: "after the refusals", capacityMin: 1, capacityMax: 2 })).toMatchObject({ label: "after the refusals" });
    });

    it("createUnit refuses a layout that is not an object, or holds a NUL or an unpaired surrogate, as invalid_input and writes nothing", async () => {
      const S = await fresh();
      const before = await configVersion(S.venue);
      const units = await countRows("unit", S.venue);
      for (const [label, layout] of BAD_LAYOUTS) {
        await expect(createUnit(app, ctx(S), { label: `bad ${label}`, capacityMin: 1, capacityMax: 2, layout: layout as Record<string, unknown> }), label)
          .rejects.toMatchObject({ name: "DastarError", code: "invalid_input", message: LAYOUT_REFUSED });
      }
      expect(await countRows("unit", S.venue)).toBe(units);
      expect(await configVersion(S.venue)).toBe(before);

      // controls: escape-looking text, a well-formed surrogate pair, and a nested object are stored as given
      const layout = { note: "\\ud800 and \\u0000 are text", emoji: "\ud83d\ude00", nested: { rows: [1, 2] } };
      const view = await createUnit(app, ctx(S), { label: "escapes", capacityMin: 1, capacityMax: 2, layout });
      expect(view.layout).toEqual(layout);
      expect((await unitRow(view.id)).layout).toEqual(layout);
    });

    it("listUnits returns every unit of the venue, inactive ones included, in label order, and no unit of another venue", async () => {
      const S = await fresh(); const O = await fresh();
      await createUnit(app, ctx(S), { label: "Zed", capacityMin: 1, capacityMax: 2 });
      await createUnit(app, ctx(S), { label: "Bar", capacityMin: 1, capacityMax: 2 });
      await createUnit(app, ctx(O), { label: "Other venue unit", capacityMin: 1, capacityMax: 2 });
      expect((await owner.query("update dastar.unit set active = false where id = $1", [S.units[2]!])).rowCount).toBe(1);

      const list = await listUnits(app, S.venue);
      expect(list.map((u) => u.label)).toEqual(["Bar", "T1", "T2", "T3", "T4", "T5", "T6", "Zed"]);
      expect(list.find((u) => u.id === S.units[2])).toMatchObject({ label: "T3", active: false, capacityMin: 1, capacityMax: 4 });
      expect(list.filter((u) => u.active)).toHaveLength(7);
      expect(list.find((u) => u.id === S.units[0])).toEqual({ id: S.units[0], label: "T1", capacityMin: 1, capacityMax: 4, active: true, layout: {} });
    });
  });

  describe("updateUnit", () => {
    it("a change to label and layout only is not judged against live reservations, with or without force", async () => {
      const S = await fresh(); const unit = S.units[0]!;
      const held = await place(S, at(nextDay(), 19));
      const conf = await confirmedAt(S, at(nextDay(), 19));
      const seated = await seatedAt(S, at(nextDay(), 19));

      const out = accepted(await updateUnit(app, ctx(S), { unitId: unit, label: "Window", layout: { side: "left" } }));
      expect(out.cancelled).toEqual([]);
      expect(out.value).toEqual({ id: unit, label: "Window", capacityMin: 1, capacityMax: 4, active: true, layout: { side: "left" } });
      // force on a change that strands nothing cancels nothing
      expect(accepted(await updateUnit(app, ctx(S), { unitId: unit, label: "Window 2", force: true })).cancelled).toEqual([]);
      await expectUntouched(S, held, "held");
      await expectUntouched(S, conf, "confirmed");
      await expectUntouched(S, seated, "seated");
      expect(await unitRow(unit)).toMatchObject({ label: "Window 2", layout: { side: "left" }, active: true });
      expect(await cancelEventCount(S.venue)).toBe(0);
    });

    it("updateUnit refuses a layout that is not an object, or holds a NUL or an unpaired surrogate, as invalid_input and writes nothing", async () => {
      const S = await fresh(); const unit = S.units[0]!;
      const before = await configVersion(S.venue);
      const row = await unitRow(unit);
      for (const [label, layout] of BAD_LAYOUTS) {
        await expect(updateUnit(app, ctx(S), { unitId: unit, label: "Changed", layout: layout as Record<string, unknown> }), label)
          .rejects.toMatchObject({ name: "DastarError", code: "invalid_input", message: LAYOUT_REFUSED });
      }
      expect(await unitRow(unit)).toEqual(row);
      expect(await configVersion(S.venue)).toBe(before);
      // control: the same update with a valid layout is applied
      expect(accepted(await updateUnit(app, ctx(S), { unitId: unit, label: "Changed", layout: { ok: true } })).value).toMatchObject({ label: "Changed", layout: { ok: true } });
    });

    it("a change that does not name the layout keeps the stored jsonb byte for byte, numbers beyond a JavaScript double included", async () => {
      const S = await fresh();
      const raw = '{"n": 12345678901234567890, "x": 1.0}';
      const unit = (await owner.query(
        "insert into dastar.unit (venue_id, label, capacity_min, capacity_max, layout) values ($1, 'Raw', 1, 2, $2::jsonb) returning id",
        [S.venue, raw],
      )).rows[0].id as string;
      const text = async (): Promise<string> => (await owner.query("select layout::text as t from dastar.unit where id = $1", [unit])).rows[0].t as string;
      expect(await text()).toBe(raw);

      const out = accepted(await updateUnit(app, ctx(S), { unitId: unit, label: "Renamed" }));
      expect(out.value.label).toBe("Renamed");
      expect(await text()).toBe(raw);
      expect((await unitRow(unit)).label).toBe("Renamed");
      // a deactivation and a capacity change leave it alone as well
      accepted(await updateUnit(app, ctx(S), { unitId: unit, capacityMax: 3, active: false }));
      expect(await text()).toBe(raw);
      expect(await unitRow(unit)).toMatchObject({ capacity_max: 3, active: false });

      // control: a layout in the input does replace it
      accepted(await updateUnit(app, ctx(S), { unitId: unit, layout: { replaced: 1 } }));
      expect(await text()).toBe('{"replaced": 1}');
    });

    it("a capacity range widened, or narrowed around the live parties, is applied", async () => {
      const S = await fresh(); const unit = S.units[0]!;
      const id = await place(S, at(nextDay(), 19), { partySize: 3 });

      const wider = accepted(await updateUnit(app, ctx(S), { unitId: unit, capacityMax: 6 }));
      expect(wider).toMatchObject({ cancelled: [], value: { capacityMin: 1, capacityMax: 6 } });
      expect(await unitRow(unit)).toMatchObject({ capacity_min: 1, capacity_max: 6 });
      const around = accepted(await updateUnit(app, ctx(S), { unitId: unit, capacityMin: 3, capacityMax: 3 }));
      expect(around).toMatchObject({ cancelled: [], value: { capacityMin: 3, capacityMax: 3 } });
      expect(await unitRow(unit)).toMatchObject({ capacity_min: 3, capacity_max: 3 });
      await expectUntouched(S, id, "held");
    });

    it("a range that leaves a live party outside it, above or below, refuses as capacity_conflict naming the reservations in start order, and writes nothing", async () => {
      const S = await fresh(); const unit = S.units[0]!;
      const big = await place(S, at(nextDay(), 19), { partySize: 4 });
      const small = await place(S, at(nextDay(), 19), { partySize: 2 });

      const above = refused(await updateUnit(app, ctx(S), { unitId: unit, capacityMax: 3 }));
      expect(above).toEqual({
        ok: false,
        error: { code: "capacity_conflict", message: "this change to unit T1 would strand 1 live reservation; cancel them or retry with force" },
        stranded: [big],
      });
      const below = refused(await updateUnit(app, ctx(S), { unitId: unit, capacityMin: 5, capacityMax: 6 }));
      expect(below).toEqual({
        ok: false,
        error: { code: "capacity_conflict", message: "this change to unit T1 would strand 2 live reservations; cancel them or retry with force" },
        stranded: [big, small],
      });
      expect(await unitRow(unit)).toMatchObject({ capacity_min: 1, capacity_max: 4 });
      await expectUntouched(S, big, "held");
      await expectUntouched(S, small, "held");
      expect(await cancelEventCount(S.venue)).toBe(0);
    });

    for (const reason of [undefined, "renovation"]) {
      it(`with force, a narrowing cancels exactly the stranded held and confirmed reservations ${reason ? `with the reason "${reason}"` : "with the default reason"}, and applies the range`, async () => {
        // a seated party counts as started, so force never cancels it (the seated-party test below)
        const S = await fresh(); const unit = S.units[0]!;
        const held = await place(S, at(nextDay(), 19), { partySize: 4 });
        const conf = await confirmedAt(S, at(nextDay(), 19), { partySize: 4 });
        const kept = await place(S, at(nextDay(), 19), { partySize: 2 });
        const c = ctx(S);

        const out = accepted(await updateUnit(app, c, { unitId: unit, capacityMax: 3, force: true, ...(reason ? { cancelReason: reason } : {}) }));
        expect(out.cancelled).toEqual([held, conf].sort());
        expect(out.value).toMatchObject({ id: unit, capacityMin: 1, capacityMax: 3 });
        for (const id of [held, conf]) await expectCancelledByAdmin(S, id, reason ?? "venue change", c);
        await expectUntouched(S, kept, "held");
        expect(await unitRow(unit)).toMatchObject({ capacity_min: 1, capacity_max: 3 });
        expect(await cancelEventCount(S.venue)).toBe(2);
      });
    }

    it("a narrowing is judged against reservations of the unit itself, not those of a combination that contains it", async () => {
      const S = await fresh();
      const comboRes = await place(S, at(nextDay(), 19), COMBO(S));
      const member = S.units[0]!;
      expect(S.combos[0]!.units).toContain(member);
      const narrowed = accepted(await updateUnit(app, ctx(S), { unitId: member, capacityMin: 1, capacityMax: 1, force: true }));
      expect(narrowed.cancelled).toEqual([]);
      expect(await unitRow(member)).toMatchObject({ capacity_min: 1, capacity_max: 1 });
      await expectUntouched(S, comboRes, "held");

      // control: the same narrowing of a unit with a party of its own is judged
      const direct = await place(S, at(nextDay(), 19), { assignment: { kind: "unit", id: S.units[2]! } });
      expect(refused(await updateUnit(app, ctx(S), { unitId: S.units[2]!, capacityMax: 1 })).stranded).toEqual([direct]);
    });

    it("a range with capacity_max below capacity_min is invalid_input, never judged against reservations, and cancels nothing even with force", async () => {
      const S = await fresh(); const unit = S.units[0]!;
      const id = await place(S, at(nextDay(), 19), { partySize: 2 });
      await expect(updateUnit(app, ctx(S), { unitId: unit, capacityMin: 4, capacityMax: 3, force: true }))
        .rejects.toMatchObject({ name: "DastarError", code: "invalid_input" });
      await expect(updateUnit(app, ctx(S), { unitId: unit, capacityMin: 0 }))
        .rejects.toMatchObject({ name: "DastarError", code: "invalid_input" });
      expect(await unitRow(unit)).toMatchObject({ capacity_min: 1, capacity_max: 4 });
      await expectUntouched(S, id, "held");
    });
  });

  describe("updateUnit deactivation", () => {
    const IN_USE = (id: string, label = "T1") => ({
      ok: false,
      error: { code: "assignment_in_use", message: `this change to unit ${label} would strand 1 live reservation; cancel them or retry with force` },
      stranded: [id],
    });

    it("a held, a confirmed, or a seated reservation on the unit refuses the deactivation as assignment_in_use naming it, and the unit stays active", async () => {
      for (const make of [place, confirmedAt, seatedAt]) {
        const S = await fresh(); const unit = S.units[0]!;
        const id = await make(S, at(nextDay(), 19));
        const status = (await storedRow(id)).status;
        expect(refused(await updateUnit(app, ctx(S), { unitId: unit, active: false })), status).toEqual(IN_USE(id));
        expect((await unitRow(unit)).active, status).toBe(true);
        await expectUntouched(S, id, status);
        expect(await cancelEventCount(S.venue), status).toBe(0);
      }
    });

    it("a reservation of a combination that contains the unit refuses it, naming the combination's reservation, for each member, and a unit outside the combination deactivates", async () => {
      const S = await fresh();
      const comboRes = await place(S, at(nextDay(), 19), COMBO(S));
      expect(S.combos[0]!.units).toHaveLength(2);
      for (const member of S.combos[0]!.units) {
        expect(refused(await updateUnit(app, ctx(S), { unitId: member, active: false })), member).toMatchObject(IN_USE(comboRes, S.units.indexOf(member) === 0 ? "T1" : "T2"));
        expect((await unitRow(member)).active, member).toBe(true);
      }
      await expectUntouched(S, comboRes, "held");

      const outside = accepted(await updateUnit(app, ctx(S), { unitId: S.units[2]!, active: false }));
      expect(outside).toMatchObject({ cancelled: [], value: { id: S.units[2], active: false } });
      expect((await unitRow(S.units[2]!)).active).toBe(false);
    });

    it("with force, it cancels the reservations of the unit and of a combination containing it, publishes each, and deactivates; other units' reservations stay", async () => {
      const S = await fresh(); const unit = S.units[0]!;
      const direct = await place(S, at(nextDay(), 19));
      const viaCombo = await confirmedAt(S, at(nextDay(), 19), COMBO(S));
      const elsewhere = await place(S, at(nextDay(), 19), { assignment: { kind: "unit", id: S.units[4]! } });
      const c = ctx(S);

      const out = accepted(await updateUnit(app, c, { unitId: unit, active: false, force: true }));
      expect(out.cancelled).toEqual([direct, viaCombo].sort());
      expect(out.value).toMatchObject({ id: unit, active: false });
      for (const id of [direct, viaCombo]) await expectCancelledByAdmin(S, id, "venue change", c);
      await expectUntouched(S, elsewhere, "held");
      expect((await unitRow(unit)).active).toBe(false);
      // the combination itself stays active
      expect((await comboRow(S.combos[0]!.id)).active).toBe(true);
      expect(await cancelEventCount(S.venue)).toBe(2);

      // the unit is no longer bookable, and reactivating it needs no judgment
      await expect(hold(app, input(S, at(nextDay(), 19)))).rejects.toMatchObject({ code: "assignment_inactive" });
      const back = accepted(await updateUnit(app, ctx(S), { unitId: unit, active: true }));
      expect(back).toMatchObject({ cancelled: [], value: { active: true } });
      expect((await unitRow(unit)).active).toBe(true);
    });

    it("with only cancelled and completed reservations on it, it deactivates with nothing to cancel", async () => {
      const S = await fresh(); const unit = S.units[0]!;
      const gone = await place(S, at(nextDay(), 19));
      await cancel(app, { reservationId: gone, ...desk(S), reason: "guest" });
      const done = await seatedAt(S, at(nextDay(), 19));
      await complete(app, { reservationId: done, ...desk(S) });

      const out = accepted(await updateUnit(app, ctx(S), { unitId: unit, active: false }));
      expect(out.cancelled).toEqual([]);
      expect((await unitRow(unit)).active).toBe(false);
      expect(await storedRow(done)).toEqual({ status: "completed", cancel_reason: null });
      expect(await cancelEventCount(S.venue)).toBe(1);
    });

    it("force refuses a started reservation as reservation_in_progress naming only the started ones, cancels nothing, and succeeds when none has started", async () => {
      const S = await fresh(); const unit = S.units[0]!;
      const day = nextDay();
      // confirmed reservations: a hold whose start has passed by the moved clock is also past its expiry, so it is not live
      const first = await confirmedAt(S, at(day, 19));
      const second = await confirmedAt(S, at(day + 1, 19));
      try {
        await setClock(app, at(day, 19, 1));
        // control: without force both are stranded, started or not
        const plain = refused(await updateUnit(app, ctx(S), { unitId: unit, active: false }));
        expect(plain.error.code).toBe("assignment_in_use");
        expect(plain.stranded).toEqual([first, second]);
        const forced = refused(await updateUnit(app, ctx(S), { unitId: unit, active: false, force: true }));
        expect(forced).toEqual({
          ok: false,
          error: { code: "reservation_in_progress", message: "1 stranded reservation has already started; close it first" },
          stranded: [first],
        });
      } finally {
        await setClock(app, null);
      }
      await expectUntouched(S, first, "confirmed");
      await expectUntouched(S, second, "confirmed");
      expect((await unitRow(unit)).active).toBe(true);
      expect(await cancelEventCount(S.venue)).toBe(0);

      // by the real clock neither has started, so the same forced write cancels both
      const control = accepted(await updateUnit(app, ctx(S), { unitId: unit, active: false, force: true }));
      expect(control.cancelled).toEqual([first, second].sort());
      expect((await unitRow(unit)).active).toBe(false);
    });

    it("force refuses a seated party as in progress even when its start is still ahead, naming only it, and cancels nothing", async () => {
      const S = await fresh(); const unit = S.units[0]!;
      const seated = await seatedAt(S, at(nextDay(), 19));
      const confirmed = await confirmedAt(S, at(nextDay(), 19));
      // the seated party was seated before its start time: by the range it has not started
      expect((await owner.query("select lower(during) > now() as ahead from dastar.reservation where id = $1", [seated])).rows[0].ahead).toBe(true);
      const plain = refused(await updateUnit(app, ctx(S), { unitId: unit, active: false }));
      expect(plain.stranded).toEqual([seated, confirmed]);
      const forced = refused(await updateUnit(app, ctx(S), { unitId: unit, active: false, force: true }));
      expect(forced).toEqual({
        ok: false,
        error: { code: "reservation_in_progress", message: "1 stranded reservation has already started; close it first" },
        stranded: [seated],
      });
      await expectUntouched(S, seated, "seated");
      await expectUntouched(S, confirmed, "confirmed");
      expect((await unitRow(unit)).active).toBe(true);
      expect(await cancelEventCount(S.venue)).toBe(0);

      // once the party is completed, only the confirmed reservation is stranded, and force cancels it
      await complete(app, { reservationId: seated, ...desk(S) });
      const control = accepted(await updateUnit(app, ctx(S), { unitId: unit, active: false, force: true }));
      expect(control.cancelled).toEqual([confirmed]);
      expect((await unitRow(unit)).active).toBe(false);
    });

    it("force refuses with force_too_large above the bound, names at most 201 reservations in start order, and accepts exactly the bound", async () => {
      const S = await fresh(); const unit = S.units[0]!;
      const LIMIT = BOUNDS.forceCancellations;
      expect(LIMIT).toBe(200);
      // one reservation a day on one unit, each by an actor of its own, so no per-actor cap and no overlap
      const ids: string[] = [];
      for (let i = 0; i < LIMIT + 2; i++) ids.push(await place(S, farAt(i)));
      const earliest = ids.slice(0, LIMIT + 1);

      const plain = refused(await updateUnit(app, ctx(S), { unitId: unit, active: false }));
      expect(plain.error).toEqual({
        code: "assignment_in_use",
        message: `this change to unit T1 would strand more than ${LIMIT} live reservations; cancel them or retry with force`,
      });
      expect(plain.stranded).toHaveLength(LIMIT + 1);
      expect(plain.stranded).toEqual(earliest);

      const forced = refused(await updateUnit(app, ctx(S), { unitId: unit, active: false, force: true }));
      expect(forced.error).toEqual({
        code: "force_too_large",
        message: `force cancels at most ${LIMIT} reservations; this change to unit T1 would strand more than ${LIMIT}`,
      });
      expect(forced.stranded).toHaveLength(LIMIT + 1);
      expect(forced.stranded).toEqual(earliest);
      expect((await unitRow(unit)).active).toBe(true);
      expect(await cancelEventCount(S.venue)).toBe(0);
      expect((await owner.query("select count(*)::int as n from dastar.reservation where venue_id = $1 and status = 'held'", [S.venue])).rows[0].n).toBe(LIMIT + 2);

      // 201 live reservations are still too many
      await cancel(app, { reservationId: ids[LIMIT + 1]!, ...desk(S), reason: "guest" });
      const at201 = refused(await updateUnit(app, ctx(S), { unitId: unit, active: false, force: true }));
      expect(at201.error.code).toBe("force_too_large");
      expect(at201.stranded).toEqual(earliest);

      // exactly 200 are cancelled together with the deactivation
      await cancel(app, { reservationId: ids[LIMIT]!, ...desk(S), reason: "guest" });
      const c = ctx(S);
      const at200 = accepted(await updateUnit(app, c, { unitId: unit, active: false, force: true }));
      expect(at200.cancelled).toEqual(ids.slice(0, LIMIT).sort());
      expect((await unitRow(unit)).active).toBe(false);
      expect((await owner.query("select count(*)::int as n from dastar.reservation where venue_id = $1 and cancel_reason = 'venue change'", [S.venue])).rows[0].n).toBe(LIMIT);
      expect((await owner.query("select count(*)::int as n from dastar.audit_log where venue_id = $1 and actor = $2 and action like 'update:%>cancelled'", [S.venue, c.actor])).rows[0].n).toBe(LIMIT);
      // the two cancelled by hand and the 200 forced
      expect(await cancelEventCount(S.venue)).toBe(LIMIT + 2);
    }, 120_000);
  });

  describe("combinations", () => {
    it("createCombo refuses a combination that is not 2 to 6 distinct units of the venue as assignment_mismatch and stores nothing", async () => {
      const S = await seedVenue(owner, { units: 7 }); const O = await fresh();
      const [a, b, c, d, e, f, g] = S.units as [string, string, string, string, string, string, string];
      const cases: [string, string[]][] = [
        ["no member", []],
        ["one member", [a]],
        ["seven members", [a, b, c, d, e, f, g]],
        ["a duplicate", [a, b, a]],
        ["a duplicate that differs in case", [a, a.toUpperCase()]],
        ["a unit of another venue", [a, O.units[0]!]],
        ["an id that names no unit", [a, ABSENT]],
        ["an id that is not a uuid", [a, "not-a-uuid"]],
      ];
      const combos = await countRows("unit_combo", S.venue);
      const version = await configVersion(S.venue);
      for (const [label, unitIds] of cases) {
        await expect(createCombo(app, ctx(S), { label: `bad ${label}`, unitIds, capacityMin: 2, capacityMax: 6 }), label)
          .rejects.toMatchObject({ name: "DastarError", code: "assignment_mismatch", message: "a combination has 2 to 6 distinct units of its venue" });
      }
      expect(await countRows("unit_combo", S.venue)).toBe(combos);
      expect(await configVersion(S.venue)).toBe(version);

      // controls: the bounds themselves are accepted
      expect(await createCombo(app, ctx(S), { label: "two", unitIds: [a, b], capacityMin: 2, capacityMax: 4 })).toMatchObject({ label: "two" });
      expect(await createCombo(app, ctx(S), { label: "six", unitIds: [a, b, c, d, e, f], capacityMin: 6, capacityMax: 12 })).toMatchObject({ label: "six" });
      expect(await countRows("unit_combo", S.venue)).toBe(combos + 2);
    });

    it("createCombo stores the members lowercased and sorted, returns the view, and steps the config version once", async () => {
      const S = await fresh();
      const sorted = [...S.units.slice(0, 3)].sort();
      const given = [...sorted].reverse().map((u, i) => (i === 0 ? u.toUpperCase() : u));
      expect(given.map((u) => u.toLowerCase())).not.toEqual(sorted);
      const before = await configVersion(S.venue);

      const view = await createCombo(app, ctx(S), { label: "Trio", unitIds: given, capacityMin: 5, capacityMax: 12 });
      expect(view).toEqual({ id: expect.stringMatching(UUID), label: "Trio", unitIds: sorted, capacityMin: 5, capacityMax: 12, active: true });
      const row = (await owner.query("select venue_id, unit_ids, capacity_min, capacity_max, active from dastar.unit_combo where id = $1", [view.id])).rows[0];
      expect(row).toEqual({ venue_id: S.venue, unit_ids: sorted, capacity_min: 5, capacity_max: 12, active: true });
      expect(await configVersion(S.venue)).toBe(before + 1);
    });

    it("createCombo refuses capacity_max below capacity_min as invalid_input and stores nothing", async () => {
      const S = await fresh();
      const combos = await countRows("unit_combo", S.venue);
      await expect(createCombo(app, ctx(S), { label: "backwards", unitIds: [S.units[0]!, S.units[1]!], capacityMin: 5, capacityMax: 3 }))
        .rejects.toMatchObject({ name: "DastarError", code: "invalid_input", sqlstate: "23514" });
      expect(await countRows("unit_combo", S.venue)).toBe(combos);
    });

    it("listCombos returns every combination of the venue, inactive ones included, in label order, and none of another venue", async () => {
      const S = await fresh(); const O = await fresh();
      await createCombo(app, ctx(S), { label: "Zzz", unitIds: [S.units[4]!, S.units[5]!], capacityMin: 2, capacityMax: 4 });
      await createCombo(app, ctx(S), { label: "Aaa", unitIds: [S.units[4]!, S.units[5]!], capacityMin: 2, capacityMax: 4 });
      await createCombo(app, ctx(O), { label: "Other venue combo", unitIds: [O.units[0]!, O.units[1]!], capacityMin: 2, capacityMax: 4 });
      const deactivated = S.combos[2]!;
      expect((await owner.query("update dastar.unit_combo set active = false where id = $1", [deactivated.id])).rowCount).toBe(1);

      const list = await listCombos(app, S.venue);
      expect(list.map((x) => x.label)).toEqual(["Aaa", "C12", "C13", "C14", "C23", "C24", "C34", "Zzz"]);
      expect(list.find((x) => x.id === deactivated.id)).toEqual({ id: deactivated.id, label: "C13", unitIds: deactivated.units, capacityMin: 5, capacityMax: 8, active: false });
      expect(list.filter((x) => x.active)).toHaveLength(7);
    });

    it("a live reservation assigned to the combination refuses its deactivation as assignment_in_use naming it, and with force it is cancelled, published, and the combination deactivated", async () => {
      const S = await fresh(); const combo = S.combos[0]!.id;
      const id = await place(S, at(nextDay(), 19), COMBO(S));
      const other = await place(S, at(nextDay(), 19), { partySize: 6, assignment: { kind: "combo", id: S.combos[1]!.id } });

      const out = refused(await updateCombo(app, ctx(S), { comboId: combo, active: false }));
      expect(out).toEqual({
        ok: false,
        error: { code: "assignment_in_use", message: "this change to combination C12 would strand 1 live reservation; cancel them or retry with force" },
        stranded: [id],
      });
      expect((await comboRow(combo)).active).toBe(true);
      await expectUntouched(S, id, "held");

      const c = ctx(S);
      const forced = accepted(await updateCombo(app, c, { comboId: combo, active: false, force: true, cancelReason: "closed for repairs" }));
      expect(forced.cancelled).toEqual([id]);
      expect(forced.value).toEqual({ id: combo, label: "C12", unitIds: S.combos[0]!.units, capacityMin: 5, capacityMax: 8, active: false });
      await expectCancelledByAdmin(S, id, "closed for repairs", c);
      await expectUntouched(S, other, "held");
      expect((await comboRow(combo)).active).toBe(false);

      // reactivation needs no judgment
      expect(accepted(await updateCombo(app, ctx(S), { comboId: combo, active: true }))).toMatchObject({ cancelled: [], value: { active: true } });
    });

    it("a reservation of one of the combination's member units does not strand it, even with force", async () => {
      const S = await fresh(); const combo = S.combos[0]!;
      const memberRes = await place(S, at(nextDay(), 19), { assignment: { kind: "unit", id: combo.units[0]! } });
      const out = accepted(await updateCombo(app, ctx(S), { comboId: combo.id, active: false, force: true }));
      expect(out.cancelled).toEqual([]);
      expect((await comboRow(combo.id)).active).toBe(false);
      await expectUntouched(S, memberRes, "held");
    });

    it("a change of label, or setting active on an active combination, is not judged against live reservations", async () => {
      const S = await fresh(); const combo = S.combos[0]!.id;
      const id = await place(S, at(nextDay(), 19), COMBO(S));
      const renamed = accepted(await updateCombo(app, ctx(S), { comboId: combo, label: "Renamed" }));
      expect(renamed).toMatchObject({ cancelled: [], value: { label: "Renamed", active: true } });
      expect(accepted(await updateCombo(app, ctx(S), { comboId: combo, active: true, force: true })).cancelled).toEqual([]);
      expect(await comboRow(combo)).toEqual({ label: "Renamed", active: true });
      await expectUntouched(S, id, "held");
    });

    it("force refuses a started reservation of the combination as reservation_in_progress and cancels nothing", async () => {
      const S = await fresh(); const combo = S.combos[0]!.id;
      const day = nextDay();
      const id = await confirmedAt(S, at(day, 19), COMBO(S));
      try {
        await setClock(app, at(day, 19, 1));
        const out = refused(await updateCombo(app, ctx(S), { comboId: combo, active: false, force: true }));
        expect(out).toEqual({
          ok: false,
          error: { code: "reservation_in_progress", message: "1 stranded reservation has already started; close it first" },
          stranded: [id],
        });
      } finally {
        await setClock(app, null);
      }
      expect((await comboRow(combo)).active).toBe(true);
      await expectUntouched(S, id, "confirmed");
    });
  });

  describe("targets and venue scope", () => {
    it("a unit or combination of another venue, or one that does not exist, is not_found, and the other venue is left as it was", async () => {
      const S = await fresh(); const O = await fresh();
      const theirs = await place(O, at(nextDay(), 19));
      const theirCombo = await place(O, at(nextDay(), 19), COMBO(O));

      const unitRefusal = { name: "DastarError", code: "not_found", message: "unit not found" };
      const comboRefusal = { name: "DastarError", code: "not_found", message: "combination not found" };
      for (const unitId of [O.units[0]!, ABSENT]) {
        await expect(updateUnit(app, ctx(S), { unitId, label: "Hijacked", active: false, force: true })).rejects.toMatchObject(unitRefusal);
      }
      for (const comboId of [O.combos[0]!.id, ABSENT]) {
        await expect(updateCombo(app, ctx(S), { comboId, label: "Hijacked", active: false, force: true })).rejects.toMatchObject(comboRefusal);
      }
      expect(await unitRow(O.units[0]!)).toMatchObject({ label: "T1", active: true });
      expect(await comboRow(O.combos[0]!.id)).toEqual({ label: "C12", active: true });
      await expectUntouched(O, theirs, "held");
      await expectUntouched(O, theirCombo, "held");
      expect(await cancelEventCount(O.venue)).toBe(0);
    });

    it("a forced change in one venue cancels none of another venue's reservations, even ones of the same shape on the same days", async () => {
      const S = await fresh(); const O = await fresh();
      const day = nextDay();
      const mine = await place(S, at(day, 19), { partySize: 4 });
      const theirs = await place(O, at(day, 19), { partySize: 4 });
      const c = ctx(S);
      const out = accepted(await updateUnit(app, c, { unitId: S.units[0]!, capacityMax: 3, force: true }));
      expect(out.cancelled).toEqual([mine]);
      await expectCancelledByAdmin(S, mine, "venue change", c);
      await expectUntouched(O, theirs, "held");
      expect(await unitRow(O.units[0]!)).toMatchObject({ capacity_max: 4 });
    });
  });

  describe("the handle's admin methods", () => {
    it("run each command on a pooled client under its own command name and trace id, and return the client idle", async () => {
      const S = await fresh();
      const seen: string[] = [];
      const pool = new Pool({ connectionString: conn.app, max: 2, application_name: "au-pool" });
      pool.on("error", () => undefined);
      const d = createDastar({ pool, onAcquire: (info) => { seen.push(`${info.command}:${info.traceId}`); } });
      try {
        const c1 = ctx(S); const c2 = ctx(S); const c3 = ctx(S); const c4 = ctx(S); const c5 = ctx(S);
        const unit = await d.admin.createUnit(c1, { label: "Handle unit", capacityMin: 1, capacityMax: 2 });
        expect((await d.admin.listUnits(S.venue)).map((u) => u.id)).toContain(unit.id);
        const combo = await d.admin.createCombo(c2, { label: "Handle combo", unitIds: [S.units[0]!, S.units[1]!], capacityMin: 2, capacityMax: 4 });
        expect((await d.admin.listCombos(S.venue)).map((x) => x.id)).toContain(combo.id);
        expect(await d.admin.updateUnit(c3, { unitId: unit.id, active: false })).toMatchObject({ ok: true, cancelled: [], value: { id: unit.id, active: false } });
        expect(await d.admin.updateCombo(c4, { comboId: combo.id, active: false })).toMatchObject({ ok: true, cancelled: [], value: { id: combo.id, active: false } });
        await expect(d.admin.updateUnit(c5, { unitId: ABSENT, active: false })).rejects.toMatchObject({ code: "not_found" });
        expect(pool.idleCount).toBe(pool.totalCount);
        expect(seen).toEqual([
          `createUnit:${c1.traceId}`, "listUnits:null", `createCombo:${c2.traceId}`, "listCombos:null",
          `updateUnit:${c3.traceId}`, `updateCombo:${c4.traceId}`, `updateUnit:${c5.traceId}`,
        ]);
        expect(await unitRow(unit.id)).toMatchObject({ label: "Handle unit", active: false });
      } finally {
        await d.close();
        await pool.end();
      }
    });
  });

  describe("two connections", () => {
    const receiptOf = (out: HoldOutcome): string => (out as { receipt: { reservationId: string } }).receipt.reservationId;

    it("(a) a deactivation queues on the venue lock behind a hold that holds it, then refuses naming the hold's reservation; a forced one cancels it", async () => {
      const before = await deadlockCountStable(owner);
      const S = await fresh(); const unit = S.units[0]!;
      const i = input(S, at(nextDay(), 19));
      const p = pause();
      const pHold = outcome(hold(H, i, { beforeUnitLocks: p.hook }));
      let pRefused: Promise<Outcome<AdminOutcome<unknown>>> | undefined;
      let reservationId = "";
      try {
        await p.reached;
        // the hold holds the venue lock shared and has taken no unit lock, and has stored nothing
        expect(await advisoryHeld("au-H", "ShareLock")).toBe(1);
        expect(await advisoryHeld("au-H", "ExclusiveLock")).toBe(0);
        pRefused = outcome(updateUnit(W, ctx(S), { unitId: unit, active: false }));
        await waitForBackend(owner, "au-W", { type: "Lock", event: "advisory" });
        p.release();
        reservationId = receiptOf(settled(await pHold));
        // the command saw the hold only because it waited for it
        expect(refused(settled(await pRefused))).toMatchObject({
          error: { code: "assignment_in_use" },
          stranded: [reservationId],
        });
      } finally {
        p.release();
        await pHold;
        if (pRefused) await pRefused;
        await W.query("rollback").catch(() => undefined);
      }
      expect((await unitRow(unit)).active).toBe(true);
      await expectUntouched(S, reservationId, "held");

      const c = ctx(S);
      const forced = accepted(await updateUnit(W, c, { unitId: unit, active: false, force: true }));
      expect(forced.cancelled).toEqual([reservationId]);
      await expectCancelledByAdmin(S, reservationId, "venue change", c);
      expect((await unitRow(unit)).active).toBe(false);
      expect(await advisoryHeld("au-H", "ShareLock") + await advisoryHeld("au-W", "ExclusiveLock")).toBe(0);
      expect(await deadlockCountStable(owner)).toBe(before);
    });

    it("(b) a forced deactivation waits on the row of a reservation another transaction is cancelling, then skips it, keeps the other's reason and event, and deactivates", async () => {
      const before = await deadlockCountStable(owner);
      const S = await fresh(); const unit = S.units[0]!;
      const id = await place(S, at(nextDay(), 19));
      const p = pause();
      const pCancel = outcome(cancel(H, { reservationId: id, ...desk(S), reason: "guest" }, { afterLock: p.hook }));
      let pAdmin: Promise<Outcome<AdminOutcome<unknown>>> | undefined;
      try {
        await p.reached;
        // the cancel holds the row and has committed nothing, so the reservation is still live for the command
        expect((await storedRow(id)).status).toBe("held");
        pAdmin = outcome(updateUnit(W, ctx(S), { unitId: unit, active: false, force: true }));
        await waitForBackend(owner, "au-W", { type: "Lock" });
        expect((await storedRow(id)).status).toBe("held");
        p.release();
        expect(settled(await pCancel).status).toBe("cancelled");
        const out = accepted(settled(await pAdmin));
        // the reservation was cancelled by the other transaction, so there is nothing for the command to cancel
        expect(out.cancelled).toEqual([]);
      } finally {
        p.release();
        await pCancel;
        if (pAdmin) await pAdmin;
        await W.query("rollback").catch(() => undefined);
      }
      expect((await unitRow(unit)).active).toBe(false);
      expect(await storedRow(id)).toEqual({ status: "cancelled", cancel_reason: "guest" });
      expect(await cancelEvents(S.venue, id)).toHaveLength(1);
      const audit = (await owner.query("select actor from dastar.audit_log where entity_id = $1 and action like 'update:%>cancelled'", [id])).rows;
      expect(audit).toEqual([{ actor: "key:desk" }]);
      expect(await deadlockCountStable(owner)).toBe(before);
    });
  });
});

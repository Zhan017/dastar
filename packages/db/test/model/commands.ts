import fc, { type Arbitrary, type AsyncCommand } from "fast-check";
import type { Client } from "pg";
import { expect } from "vitest";
import { DastarError } from "../../src/errors.js";
import { hold, type HoldInput } from "../../src/commands/hold.js";
import { confirm } from "../../src/commands/confirm.js";
import { cancel } from "../../src/commands/cancel.js";
import { seat, complete } from "../../src/commands/seat.js";
import { mintConfirmToken } from "../../src/commands/mint-token.js";
import { expireDue } from "../../src/commands/expire.js";
import { getReservation } from "../../src/commands/get.js";
import { listHolds } from "../../src/commands/list-holds.js";
import { updateUnit, updateCombo } from "../../src/commands/admin-units.js";
import { createBlackout, updateBlackout } from "../../src/commands/admin-calendar.js";
import type { AdminContext } from "../../src/commands/admin.js";
import { setClock } from "../helpers/clock.js";
import { verify } from "./checks.js";
import {
  MINUTE, applyAdvance, applyCancel, applyCancellations, applyComboChange, applyConfirm, applyHold, applyMint, applySweep, applyUnitChange,
  effective, expectAdvance, expectBlackout, expectCancel, expectComboChange, expectConfirm, expectHold, expectListHolds, expectMint,
  expectSweep, expectUnitChange, type AdminExpectation, type HoldRequest, type Kind, type Model, type ModelReservation, type Outcome,
} from "./model.js";

/** The system under test: the app role runs commands, the worker role sweeps, the owner reads for the checks. */
export type Real = { app: Client; worker: Client; owner: Client };
type Cmd = AsyncCommand<Model, Real>;

export const ACTORS = ["key:a", "key:b"] as const;
const ADMIN = "key:admin";
const SLOT = 15 * MINUTE;
const iso = (t: number): string => new Date(t).toISOString();
const ctxOf = (m: Model): AdminContext => ({ venueId: m.venueId, actor: ADMIN, traceId: "model" });

/** How often each outcome came up, so the test can print what it exercised and refuse to pass on too little. */
export const tally = new Map<string, number>();
const count = (label: string, n = 1): void => { if (n > 0) tally.set(label, (tally.get(label) ?? 0) + n); };

type Attempt<T> = { ok: true; value: T } | { ok: false; code: string };
/** The command's answer, or the code of the domain error it threw; anything else is a test failure. */
async function attempt<T>(f: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await f() };
  } catch (e) {
    if (e instanceof DastarError) return { ok: false, code: e.code };
    throw e;
  }
}

/** Sets the database clock on every connection, so commands, the sweeper, and the checks share one time. */
export async function setClocks(m: Model, r: Real): Promise<void> {
  for (const c of [r.app, r.worker, r.owner]) await setClock(c, iso(m.clock));
}

const pickOf = <T>(xs: readonly T[], n: number): T | undefined => (xs.length === 0 ? undefined : xs[n % xs.length]);
type VersionMode = "none" | "right" | "wrong";
const versionOf = (r: ModelReservation, mode: VersionMode): number | undefined => (mode === "none" ? undefined : mode === "right" ? r.version : r.version + 7);
const withVersion = (v: number | undefined): { expectedVersion?: number } => (v === undefined ? {} : { expectedVersion: v });

/** A refused command answers the model's code; an accepted one returns a receipt one version on. */
function expectReceipt(out: Attempt<{ status: string; version: number }>, e: Outcome, status: string, version: number, where: string): void {
  if (e.ok) expect(out, where).toMatchObject({ ok: true, value: { status, version } });
  else expect(out, where).toEqual({ ok: false, code: e.code });
}

// ---------------------------------------------------------------------------------------------------- hold

type HoldParams = {
  actor: number; target: "unit" | "combo" | "missing"; pick: number; party: number; slot: number; duration: number;
  reuse: number | null; same: boolean; enforce: boolean;
};

class Hold implements Cmd {
  constructor(readonly p: HoldParams) {}
  check(): boolean { return true; }
  async run(m: Model, r: Real): Promise<void> {
    const actor = ACTORS[this.p.actor % ACTORS.length]!;
    const prior = m.holdLog.filter((h) => h.actor === actor);
    const old = this.p.reuse === null ? undefined : pickOf(prior, this.p.reuse);
    const kind: Kind = this.p.target === "combo" && m.combos.length > 0 ? "combo" : "unit";
    let assignmentId: string;
    if (this.p.target === "missing") assignmentId = `00000000-0000-4000-8000-${String(this.p.pick % 1e12).padStart(12, "0")}`;
    else assignmentId = kind === "combo" ? pickOf(m.combos, this.p.pick)!.id : pickOf(m.units, this.p.pick)!.id;
    const fresh: HoldRequest = {
      actor, key: `k${m.holdLog.length}`, kind, assignmentId, party: this.p.party,
      start: m.windowStart + this.p.slot * SLOT, durationMinutes: this.p.duration, enforceSchedule: this.p.enforce,
    };
    let h = fresh;
    if (old) h = this.p.same ? { ...old, enforceSchedule: this.p.enforce } : { ...fresh, key: old.key };
    const input: HoldInput = {
      venueId: m.venueId, actor: h.actor, traceId: "model", idempotencyKey: h.key, partySize: h.party, startsAt: iso(h.start),
      durationMinutes: h.durationMinutes, assignment: { kind: h.kind, id: h.assignmentId }, enforceSchedule: h.enforceSchedule,
    };
    const e = expectHold(m, h);
    count(e.kind === "stored" || e.kind === "throws" ? `hold ${e.kind} ${e.code}${e.kind === "throws" && e.member ? " via a member" : ""}` : `hold ${e.kind}`);
    if (e.kind === "stored" || e.kind === "held") count("hold overlap expired", e.expire.length);
    const out = await attempt(() => hold(r.app, input));
    const where = this.toString();
    let newId: string | null = null;
    switch (e.kind) {
      case "replay": expect(out, where).toEqual({ ok: true, value: { ...(e.outcome as object), replayed: true } }); break;
      case "mismatch": expect(out, where).toEqual({ ok: false, code: "idempotency_mismatch" }); break;
      case "throws": expect(out, where).toEqual({ ok: false, code: e.code }); break;
      case "stored": expect(out, where).toMatchObject({ ok: true, value: { ok: false, error: { code: e.code }, replayed: false } }); break;
      case "held": {
        expect(out, where).toMatchObject({ ok: true, value: { ok: true, receipt: { status: "held", version: 1 }, holdExpiresAt: iso(m.clock + m.ttlMs), replayed: false } });
        const v = (out as { value: { receipt: { reservationId: string } } }).value;
        newId = v.receipt.reservationId;
        break;
      }
    }
    applyHold(m, h, e, out.ok ? out.value : null, newId);
    await verify(m, r.owner, where);
  }
  toString(): string {
    const p = this.p;
    const key = p.reuse === null ? "fresh key" : `reused key ${p.reuse} (${p.same ? "same" : "other"} payload)`;
    return `hold(${ACTORS[p.actor % ACTORS.length]}, ${p.target} ${p.pick}, party ${p.party}, slot ${p.slot}, ${p.duration} min, ${key}${p.enforce ? ", schedule" : ""})`;
  }
}

// ---------------------------------------------------------------------------------------------------- lifecycle

type PickParams = { pick: number; version: VersionMode; actor: number };

abstract class OnReservation implements Cmd {
  constructor(readonly p: PickParams) {}
  check(m: Readonly<Model>): boolean { return m.reservations.length > 0; }
  /** Half the time one of the three newest reservations, so a reservation often moves through several steps. */
  protected target(m: Model): ModelReservation {
    const n = m.reservations.length;
    return this.p.pick % 2 === 0 ? m.reservations[n - 1 - ((this.p.pick >> 1) % Math.min(n, 3))]! : pickOf(m.reservations, this.p.pick >> 1)!;
  }
  protected actor(): string { return ACTORS[this.p.actor % ACTORS.length]!; }
  abstract run(m: Model, r: Real): Promise<void>;
  abstract toString(): string;
}

class Confirm extends OnReservation {
  constructor(p: PickParams, readonly mode: "key" | "token" | "wrong" | "stale") { super(p); }
  async run(m: Model, r: Real): Promise<void> {
    const res = this.target(m);
    const token = this.mode === "key" ? null
      : this.mode === "token" ? (res.token ?? "no token was minted")
        : this.mode === "stale" ? (res.staleToken ?? "no token was replaced") : "a wrong token";
    const v = versionOf(res, this.p.version);
    const e = expectConfirm(m, res, token, v);
    count(`confirm by ${this.mode} ${e.ok ? "ok" : e.code}`);
    const out = await attempt(() => confirm(r.app, {
      reservationId: res.id, actor: this.actor(), traceId: "model", venueId: m.venueId, ...withVersion(v), ...(token === null ? {} : { confirmToken: token }),
    }));
    expectReceipt(out, e, "confirmed", res.version + 1, this.toString());
    if (e.ok) applyConfirm(res, token === null ? this.actor() : `token:${res.id}`);
    await verify(m, r.owner, this.toString());
  }
  toString(): string { return `confirm(#${this.p.pick} by ${this.mode}, version ${this.p.version})`; }
}

class Mint extends OnReservation {
  async run(m: Model, r: Real): Promise<void> {
    const res = this.target(m);
    const v = versionOf(res, this.p.version);
    const e = expectMint(m, res, v);
    count(`mint ${e.ok ? "ok" : e.code}`);
    const out = await attempt(() => mintConfirmToken(r.app, { reservationId: res.id, actor: this.actor(), traceId: "model", venueId: m.venueId, ...withVersion(v) }));
    if (e.ok) {
      expect(out, this.toString()).toMatchObject({ ok: true, value: { version: res.version + 1 } });
      applyMint(res, this.actor(), (out as { value: { token: string } }).value.token);
    } else {
      expect(out, this.toString()).toEqual({ ok: false, code: e.code });
    }
    await verify(m, r.owner, this.toString());
  }
  toString(): string { return `mint(#${this.p.pick}, version ${this.p.version})`; }
}

class Cancel extends OnReservation {
  async run(m: Model, r: Real): Promise<void> {
    const res = this.target(m);
    const v = versionOf(res, this.p.version);
    const e = expectCancel(res, v);
    count(`cancel ${e.ok ? "ok" : e.code}`);
    const out = await attempt(() => cancel(r.app, { reservationId: res.id, actor: this.actor(), traceId: "model", venueId: m.venueId, reason: "model", ...withVersion(v) }));
    expectReceipt(out, e, "cancelled", res.version + 1, this.toString());
    if (e.ok) applyCancel(res, this.actor());
    await verify(m, r.owner, this.toString());
  }
  toString(): string { return `cancel(#${this.p.pick}, version ${this.p.version})`; }
}

class Advance extends OnReservation {
  constructor(p: PickParams, readonly to: "seated" | "completed") { super(p); }
  async run(m: Model, r: Real): Promise<void> {
    const res = this.target(m);
    const v = versionOf(res, this.p.version);
    const e = expectAdvance(res, this.to === "seated" ? "confirmed" : "seated", v);
    count(`${this.to === "seated" ? "seat" : "complete"} ${e.ok ? "ok" : e.code}`);
    const input = { reservationId: res.id, actor: this.actor(), traceId: "model", venueId: m.venueId, ...withVersion(v) };
    const out = await attempt(() => (this.to === "seated" ? seat(r.app, input) : complete(r.app, input)));
    expectReceipt(out, e, this.to, res.version + 1, this.toString());
    if (e.ok) applyAdvance(res, this.to, this.actor());
    await verify(m, r.owner, this.toString());
  }
  toString(): string { return `${this.to === "seated" ? "seat" : "complete"}(#${this.p.pick}, version ${this.p.version})`; }
}

class Read extends OnReservation {
  async run(m: Model, r: Real): Promise<void> {
    const res = this.target(m);
    const view = await getReservation(r.app, { reservationId: res.id, venueId: m.venueId });
    expect(view && {
      status: view.status, storedStatus: view.storedStatus, version: view.version, holdExpiresAt: view.holdExpiresAt,
      history: view.history.map((h) => ({ action: h.action, actor: h.actor })),
    }, this.toString()).toEqual({
      status: effective(res, m.clock), storedStatus: res.status, version: res.version, holdExpiresAt: iso(res.expiresAt), history: res.audit,
    });
  }
  toString(): string { return `get(#${this.p.pick})`; }
}

class ListHolds implements Cmd {
  constructor(readonly actor: number) {}
  check(): boolean { return true; }
  async run(m: Model, r: Real): Promise<void> {
    const actor = ACTORS[this.actor % ACTORS.length]!;
    const holds = await listHolds(r.app, { venueId: m.venueId, actor });
    expect(holds.map((h) => ({ id: h.id, version: h.version, holdExpiresAt: h.holdExpiresAt })), this.toString())
      .toEqual(expectListHolds(m, actor).map((h) => ({ id: h.id, version: h.version, holdExpiresAt: iso(h.expiresAt) })));
  }
  toString(): string { return `listHolds(${ACTORS[this.actor % ACTORS.length]})`; }
}

class Sweep implements Cmd {
  check(): boolean { return true; }
  async run(m: Model, r: Real): Promise<void> {
    const want = expectSweep(m);
    count("sweep expired", want.length);
    // the sweeper serves every venue and earlier runs' venues may have due rows too, so it runs until a batch comes back short
    const expired: string[] = [];
    let batch: string[];
    do {
      batch = (await expireDue(r.worker, { limit: 500 })).expired;
      expired.push(...batch);
    } while (batch.length === 500);
    expect(expired.filter((id) => m.reservations.some((x) => x.id === id)).sort(), this.toString()).toEqual(want);
    applySweep(m, want);
    await verify(m, r.owner, this.toString());
  }
  toString(): string { return "sweep()"; }
}

class Clock implements Cmd {
  constructor(readonly minutes: number) {}
  check(): boolean { return true; }
  async run(m: Model, r: Real): Promise<void> {
    m.clock += this.minutes * MINUTE;
    await setClocks(m, r);
    await verify(m, r.owner, this.toString());
  }
  toString(): string { return `clock(+${this.minutes} min)`; }
}

// ---------------------------------------------------------------------------------------------------- admin

/** An admin write refuses with the model's code and stranded ids, or applies and lists the ids it cancelled. */
function expectAdmin(out: Attempt<unknown>, e: AdminExpectation, what: string, where: string): void {
  count(`${what} ${e.ok ? (e.cancel.length > 0 ? "forced" : "applied") : e.code}`);
  if (e.ok) count(`${what} cancelled`, e.cancel.length);
  if (e.ok) expect(out, where).toMatchObject({ ok: true, value: { ok: true, cancelled: e.cancel } });
  else expect(out, where).toMatchObject({ ok: true, value: { ok: false, error: { code: e.code }, stranded: e.stranded } });
}

type UnitParams = { pick: number; change: "capacity" | "deactivate" | "reactivate" | "both"; min: number; extra: number; force: boolean };

class ChangeUnit implements Cmd {
  constructor(readonly p: UnitParams) {}
  check(): boolean { return true; }
  async run(m: Model, r: Real): Promise<void> {
    const cur = pickOf(m.units, this.p.pick)!;
    const capacity = this.p.change === "capacity" || this.p.change === "both";
    const c = {
      unitId: cur.id, min: capacity ? this.p.min : cur.min, max: capacity ? this.p.min + this.p.extra : cur.max,
      active: this.p.change === "deactivate" || this.p.change === "both" ? false : this.p.change === "reactivate" ? true : cur.active,
    };
    const e = expectUnitChange(m, c, this.p.force);
    const out = await attempt(() => updateUnit(r.app, ctxOf(m), {
      unitId: c.unitId, capacityMin: c.min, capacityMax: c.max, active: c.active, force: this.p.force, cancelReason: "model change",
    }));
    expectAdmin(out, e, "unit", this.toString());
    if (e.ok) applyUnitChange(m, c, e, ADMIN);
    await verify(m, r.owner, this.toString());
  }
  toString(): string {
    const p = this.p;
    return `unit(${p.pick}: ${p.change}${p.change === "capacity" || p.change === "both" ? ` ${p.min}-${p.min + p.extra}` : ""}${p.force ? ", force" : ""})`;
  }
}

class ChangeCombo implements Cmd {
  constructor(readonly pick: number, readonly active: boolean, readonly force: boolean) {}
  check(m: Readonly<Model>): boolean { return m.combos.length > 0; }
  async run(m: Model, r: Real): Promise<void> {
    const combo = pickOf(m.combos, this.pick)!;
    const e = expectComboChange(m, combo.id, this.active, this.force);
    const out = await attempt(() => updateCombo(r.app, ctxOf(m), { comboId: combo.id, active: this.active, force: this.force, cancelReason: "model change" }));
    expectAdmin(out, e, "combo", this.toString());
    if (e.ok) applyComboChange(m, combo.id, this.active, e, ADMIN);
    await verify(m, r.owner, this.toString());
  }
  toString(): string { return `combo(${this.pick}: ${this.active ? "activate" : "deactivate"}${this.force ? ", force" : ""})`; }
}

class CreateBlackout implements Cmd {
  constructor(readonly slot: number, readonly length: number, readonly active: boolean, readonly force: boolean) {}
  check(): boolean { return true; }
  async run(m: Model, r: Real): Promise<void> {
    const start = m.windowStart + this.slot * SLOT;
    const end = start + this.length * SLOT;
    const e = expectBlackout(m, start, end, this.active, this.force);
    const out = await attempt(() => createBlackout(r.app, ctxOf(m), {
      startsAt: iso(start), endsAt: iso(end), reason: "model", active: this.active, force: this.force, cancelReason: "model change",
    }));
    expectAdmin(out, e, "blackout", this.toString());
    if (e.ok) {
      applyCancellations(m, e, ADMIN);
      m.blackouts.push({ id: (out as { value: { value: { id: string } } }).value.value.id, start, end, active: this.active });
    }
    await verify(m, r.owner, this.toString());
  }
  toString(): string { return `blackout(slot ${this.slot}, ${this.length} slots${this.active ? "" : ", inactive"}${this.force ? ", force" : ""})`; }
}

class ToggleBlackout implements Cmd {
  constructor(readonly pick: number, readonly active: boolean, readonly force: boolean) {}
  check(m: Readonly<Model>): boolean { return m.blackouts.length > 0; }
  async run(m: Model, r: Real): Promise<void> {
    const b = pickOf(m.blackouts, this.pick)!;
    const e = expectBlackout(m, b.start, b.end, !b.active && this.active, this.force);
    const out = await attempt(() => updateBlackout(r.app, ctxOf(m), { blackoutId: b.id, active: this.active, force: this.force, cancelReason: "model change" }));
    expectAdmin(out, e, !b.active && this.active ? "reactivated blackout" : "toggled blackout", this.toString());
    if (e.ok) {
      applyCancellations(m, e, ADMIN);
      b.active = this.active;
    }
    await verify(m, r.owner, this.toString());
  }
  toString(): string { return `toggleBlackout(${this.pick}: ${this.active ? "activate" : "deactivate"}${this.force ? ", force" : ""})`; }
}

// ---------------------------------------------------------------------------------------------------- arbitraries

const pick = fc.nat({ max: 1000 });
const version = fc.constantFrom<VersionMode>("none", "none", "none", "right", "right", "wrong");
const actor = fc.nat({ max: 1 });
const pickParams = fc.record({ pick, version, actor });

const holdArb = fc.record({
  actor, target: fc.constantFrom<HoldParams["target"]>("unit", "unit", "unit", "combo", "combo", "missing"), pick,
  // mostly parties that fit somewhere, on eight slots, so holds meet each other often
  party: fc.oneof({ arbitrary: fc.integer({ min: 1, max: 4 }), weight: 4 }, { arbitrary: fc.integer({ min: 5, max: 8 }), weight: 1 }),
  slot: fc.integer({ min: 0, max: 7 }), duration: fc.constantFrom(30, 60, 90, 120),
  // a quarter of the holds reuse an earlier key of the same actor, with its payload or another
  reuse: fc.oneof({ arbitrary: fc.constant(null), weight: 3 }, { arbitrary: pick, weight: 1 }), same: fc.boolean(),
  enforce: fc.constantFrom(false, false, false, true),
}).map((p) => new Hold(p));

/** Every command, weighted by repetition: holds most often, then the lifecycle, the clock, the sweeper, and admin writes. */
export const COMMANDS: Arbitrary<Cmd>[] = [
  holdArb, holdArb, holdArb, holdArb, holdArb, holdArb, holdArb,
  fc.tuple(pickParams, fc.constantFrom<"key" | "token" | "wrong" | "stale">("key", "key", "token", "token", "wrong", "stale")).map(([p, mode]) => new Confirm(p, mode)),
  fc.tuple(pickParams, fc.constantFrom<"key" | "token" | "wrong">("key", "token")).map(([p, mode]) => new Confirm(p, mode)),
  pickParams.map((p) => new Mint(p)), pickParams.map((p) => new Mint(p)),
  pickParams.map((p) => new Cancel(p)), pickParams.map((p) => new Cancel(p)),
  pickParams.map((p) => new Advance(p, "seated")), pickParams.map((p) => new Advance(p, "seated")),
  pickParams.map((p) => new Advance(p, "completed")),
  pickParams.map((p) => new Read(p)),
  actor.map((a) => new ListHolds(a)),
  fc.constant(new Sweep()),
  fc.constantFrom(0, 1, 2, 5, 10, 15, 30, 60).map((n) => new Clock(n)),
  fc.constantFrom(1, 2, 5, 10, 30, 60).map((n) => new Clock(n)),
  fc.constantFrom(2, 10, 60).map((n) => new Clock(n)),
  fc.record({
    pick, change: fc.constantFrom<UnitParams["change"]>("capacity", "capacity", "deactivate", "reactivate", "both"),
    min: fc.integer({ min: 1, max: 3 }), extra: fc.integer({ min: 0, max: 4 }), force: fc.boolean(),
  }).map((p) => new ChangeUnit(p)),
  fc.record({
    pick, change: fc.constantFrom<UnitParams["change"]>("capacity", "capacity", "deactivate", "reactivate", "both"),
    min: fc.integer({ min: 1, max: 3 }), extra: fc.integer({ min: 0, max: 4 }), force: fc.boolean(),
  }).map((p) => new ChangeUnit(p)),
  fc.tuple(pick, fc.boolean(), fc.boolean()).map(([n, a, f]) => new ChangeCombo(n, a, f)),
  fc.tuple(fc.integer({ min: 0, max: 15 }), fc.integer({ min: 1, max: 8 }), fc.constantFrom(true, true, true, false), fc.boolean())
    .map(([s, l, a, f]) => new CreateBlackout(s, l, a, f)),
  fc.tuple(pick, fc.boolean(), fc.boolean()).map(([n, a, f]) => new ToggleBlackout(n, a, f)),
];


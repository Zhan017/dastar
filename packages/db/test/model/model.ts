// The reference model of one venue for the model-based test: plain data and the engine's rules, written from the
// commands and triggers, with no database. Every function here is pure except the apply* functions, which mutate the
// model after the test has compared the engine's outcome with the expectation.

export const MINUTE = 60_000;

export type Status = "held" | "confirmed" | "seated" | "completed" | "cancelled" | "expired";
export type Kind = "unit" | "combo";

export type ModelUnit = { id: string; min: number; max: number; active: boolean };
export type ModelCombo = { id: string; members: string[]; min: number; max: number; active: boolean };
export type ModelBlackout = { id: string; start: number; end: number; active: boolean };
export type Period = { start: number; end: number };
export type AuditEntry = { action: string; actor: string };
export type OutboxEvent = { topic: string; status: Status; version: number };

export type ModelReservation = {
  id: string; actor: string; kind: Kind; assignmentId: string; units: string[];
  party: number; start: number; end: number;
  status: Status; version: number; expiresAt: number; token: string | null;
  audit: AuditEntry[]; outbox: OutboxEvent[];
};

export type HoldRequest = {
  actor: string; key: string; kind: Kind; assignmentId: string; party: number; start: number; durationMinutes: number; enforceSchedule: boolean;
};

/** A stored hold outcome: the canonical payload it was stored under and the engine's first answer. */
export type StoredHold = { payload: string; outcome: unknown };

export type Model = {
  venueId: string;
  /** The first 15-minute slot holds and blackouts are placed on. */
  windowStart: number;
  clock: number;
  ttlMs: number;
  cap: number;
  units: ModelUnit[];
  combos: ModelCombo[];
  blackouts: ModelBlackout[];
  /** Whether the venue has an active schedule, and every service period near the booking window. */
  hasSchedule: boolean;
  periods: Period[];
  reservations: ModelReservation[];
  idempotency: Map<string, StoredHold>;
  /** Every hold request made so far, so a later one can reuse a key with the same or another payload. */
  holdLog: HoldRequest[];
};

const LIVE: ReadonlySet<Status> = new Set(["held", "confirmed", "seated"]);
const OCCUPYING: ReadonlySet<Status> = new Set(["held", "confirmed", "seated", "completed"]);

export const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1;
/** Stored held past its expiry reads as expired, whether or not anything has expired it yet. */
export const effective = (r: ModelReservation, clock: number): Status => (r.status === "held" && r.expiresAt <= clock ? "expired" : r.status);
export const isLive = (r: ModelReservation, clock: number): boolean => LIVE.has(effective(r, clock));
/** Unit rows stay active while the stored status occupies: held, confirmed, seated, and completed as history. */
export const occupies = (r: ModelReservation): boolean => OCCUPYING.has(r.status);
const isDead = (r: ModelReservation, clock: number): boolean => r.status === "held" && r.expiresAt <= clock;

const idemKey = (actor: string, key: string): string => `${actor}\u0000${key}`;
/** The fields the engine's canonical hold request covers: neither the actor (part of the key) nor enforceSchedule. */
export const canonicalPayload = (h: HoldRequest): string => JSON.stringify([h.kind, h.assignmentId, h.durationMinutes, h.party, h.start]);
export const holdEnd = (h: HoldRequest): number => h.start + h.durationMinutes * MINUTE;

export function find(m: Model, id: string): ModelReservation {
  const r = m.reservations.find((x) => x.id === id);
  if (!r) throw new Error(`model has no reservation ${id}`);
  return r;
}

/** The units a hold of the assignment would occupy, or null when the venue has no such assignment. */
function unitsOf(m: Model, kind: Kind, id: string): string[] | null {
  if (kind === "unit") return m.units.some((u) => u.id === id) ? [id] : null;
  const c = m.combos.find((x) => x.id === id);
  return c ? [...c.members].sort() : null;
}

function capacityOf(m: Model, kind: Kind, id: string): { min: number; max: number } {
  const a = kind === "unit" ? m.units.find((u) => u.id === id) : m.combos.find((c) => c.id === id);
  if (!a) throw new Error(`model has no ${kind} ${id}`);
  return { min: a.min, max: a.max };
}

/** The fit trigger's activity test: a unit is usable when active; a combination when it and every member are active. */
function usable(m: Model, kind: Kind, id: string): boolean {
  if (kind === "unit") return m.units.find((u) => u.id === id)?.active === true;
  const c = m.combos.find((x) => x.id === id);
  return c !== undefined && c.active && c.members.every((u) => m.units.find((x) => x.id === u)?.active === true);
}

const blackoutOver = (m: Model, start: number, end: number): boolean => m.blackouts.some((b) => b.active && overlaps(b.start, b.end, start, end));

// ---------------------------------------------------------------------------------------------------- hold

export type HoldExpectation =
  | { kind: "replay"; outcome: unknown }
  | { kind: "mismatch" }
  | { kind: "throws"; code: "outside_schedule" | "assignment_inactive" | "too_many_live_holds" }
  | { kind: "stored"; code: "party_does_not_fit" | "blackout" | "hold_conflict"; expire: string[] }
  | { kind: "held"; expire: string[]; units: string[] };

/** What the hold command does, in its own order: key, schedule, assignment, cap, overlap pass, then the booking's triggers. */
export function expectHold(m: Model, h: HoldRequest): HoldExpectation {
  const stored = m.idempotency.get(idemKey(h.actor, h.key));
  if (stored) return stored.payload === canonicalPayload(h) ? { kind: "replay", outcome: stored.outcome } : { kind: "mismatch" };
  const end = holdEnd(h);
  if (h.enforceSchedule && m.hasSchedule && !m.periods.some((p) => p.start <= h.start && end <= p.end)) return { kind: "throws", code: "outside_schedule" };
  const units = unitsOf(m, h.kind, h.assignmentId);
  if (units === null) return { kind: "stored", code: "party_does_not_fit", expire: [] };
  const own = h.kind === "unit" ? m.units.find((u) => u.id === h.assignmentId)!.active : m.combos.find((c) => c.id === h.assignmentId)!.active;
  if (!own) return { kind: "throws", code: "assignment_inactive" };
  const live = m.reservations.filter((r) => r.actor === h.actor && effective(r, m.clock) === "held").length;
  if (live >= m.cap) return { kind: "throws", code: "too_many_live_holds" };
  const overlapping = m.reservations.filter((r) => occupies(r) && r.units.some((u) => units.includes(u)) && overlaps(r.start, r.end, h.start, end));
  const expire = overlapping.filter((r) => isDead(r, m.clock)).map((r) => r.id).sort();
  if (blackoutOver(m, h.start, end)) return { kind: "stored", code: "blackout", expire };
  if (!usable(m, h.kind, h.assignmentId)) return { kind: "throws", code: "assignment_inactive" };
  const cap = capacityOf(m, h.kind, h.assignmentId);
  if (h.party < cap.min || h.party > cap.max) return { kind: "stored", code: "party_does_not_fit", expire };
  if (overlapping.some((r) => !expire.includes(r.id))) return { kind: "stored", code: "hold_conflict", expire };
  return { kind: "held", expire, units };
}

function transition(r: ModelReservation, to: Status, actor: string, topic: string | null): void {
  r.audit.push({ action: `update:${r.status}>${to}`, actor });
  if (r.status === "held") r.token = null;
  r.status = to;
  r.version += 1;
  if (topic) r.outbox.push({ topic, status: to, version: r.version });
}

/** Applies a hold the engine committed: the overlap pass's expiries, the new reservation, and the stored outcome. */
export function applyHold(m: Model, h: HoldRequest, e: HoldExpectation, outcome: unknown, newId: string | null): void {
  m.holdLog.push(h);
  if (e.kind !== "stored" && e.kind !== "held") return;
  for (const id of e.expire) transition(find(m, id), "expired", "system:conflict", "reservation.expired");
  if (e.kind === "held") {
    if (!newId) throw new Error("a granted hold needs the new reservation's id");
    m.reservations.push({
      id: newId, actor: h.actor, kind: h.kind, assignmentId: h.assignmentId, units: e.units,
      party: h.party, start: h.start, end: holdEnd(h),
      status: "held", version: 1, expiresAt: m.clock + m.ttlMs, token: null,
      audit: [{ action: "insert", actor: h.actor }], outbox: [{ topic: "reservation.held", status: "held", version: 1 }],
    });
  }
  m.idempotency.set(idemKey(h.actor, h.key), { payload: canonicalPayload(h), outcome });
}

// ---------------------------------------------------------------------------------------------------- lifecycle

export type Outcome = { ok: true } | { ok: false; code: string };
const refuse = (code: string): Outcome => ({ ok: false, code });

/** Confirm by key, or by token (`token` is the presented token, null for a key). Trigger order: transition, expiry, blackout, fit. */
export function expectConfirm(m: Model, r: ModelReservation, token: string | null, expectedVersion?: number): Outcome {
  if (token !== null && (r.token === null || r.token !== token)) return refuse("forbidden");
  if (expectedVersion !== undefined && expectedVersion !== r.version) return refuse("version_conflict");
  if (r.status !== "held") return refuse("invalid_transition");
  if (r.expiresAt <= m.clock) return refuse("hold_expired");
  if (blackoutOver(m, r.start, r.end)) return refuse("blackout");
  if (!usable(m, r.kind, r.assignmentId)) return refuse("assignment_inactive");
  const cap = capacityOf(m, r.kind, r.assignmentId);
  if (r.party < cap.min || r.party > cap.max) return refuse("party_does_not_fit");
  return { ok: true };
}
export const applyConfirm = (r: ModelReservation, actor: string): void => transition(r, "confirmed", actor, "reservation.confirmed");

export function expectMint(m: Model, r: ModelReservation, expectedVersion?: number): Outcome {
  if (expectedVersion !== undefined && expectedVersion !== r.version) return refuse("version_conflict");
  if (r.status !== "held" || r.expiresAt <= m.clock) return refuse("token_requires_held");
  return { ok: true };
}
export function applyMint(r: ModelReservation, actor: string, token: string): void {
  r.audit.push({ action: "update:metadata", actor });
  r.token = token;
  r.version += 1;
}

export function expectCancel(r: ModelReservation, expectedVersion?: number): Outcome {
  if (expectedVersion !== undefined && expectedVersion !== r.version) return refuse("version_conflict");
  if (!LIVE.has(r.status)) return refuse("invalid_transition");
  return { ok: true };
}
export const applyCancel = (r: ModelReservation, actor: string): void => transition(r, "cancelled", actor, "reservation.cancelled");

/** Seat (confirmed to seated) or complete (seated to completed). */
export function expectAdvance(r: ModelReservation, from: Status, expectedVersion?: number): Outcome {
  if (expectedVersion !== undefined && expectedVersion !== r.version) return refuse("version_conflict");
  if (r.status !== from) return refuse("invalid_transition");
  return { ok: true };
}
export const applyAdvance = (r: ModelReservation, to: "seated" | "completed", actor: string): void => transition(r, to, actor, `reservation.${to}`);

/** The sweeper's set: every stored held reservation past its expiry. */
export const expectSweep = (m: Model): string[] => m.reservations.filter((r) => isDead(r, m.clock)).map((r) => r.id).sort();
export function applySweep(m: Model, ids: string[]): void {
  for (const id of ids) transition(find(m, id), "expired", "system:sweeper", "reservation.expired");
}

// ---------------------------------------------------------------------------------------------------- admin

export type AdminExpectation = { ok: true; cancel: string[] } | { ok: false; code: string; stranded: string[] };

/** Reject or force over a stranded set: live by effective status, ordered by start then id. */
function settle(m: Model, stranded: ModelReservation[], code: string, force: boolean): AdminExpectation {
  const ordered = [...stranded].sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (ordered.length === 0) return { ok: true, cancel: [] };
  if (!force) return { ok: false, code, stranded: ordered.map((r) => r.id) };
  const started = ordered.filter((r) => r.status === "seated" || r.start <= m.clock);
  if (started.length > 0) return { ok: false, code: "reservation_in_progress", stranded: started.map((r) => r.id) };
  return { ok: true, cancel: ordered.map((r) => r.id).sort() };
}

export type UnitChange = { unitId: string; min: number; max: number; active: boolean };

export function expectUnitChange(m: Model, c: UnitChange, force: boolean): AdminExpectation {
  const cur = m.units.find((u) => u.id === c.unitId)!;
  const capacityChanged = c.min !== cur.min || c.max !== cur.max;
  const deactivating = cur.active && !c.active;
  const stranded = m.reservations.filter((r) => isLive(r, m.clock) && (
    (capacityChanged && r.kind === "unit" && r.assignmentId === c.unitId && (r.party < c.min || r.party > c.max))
    || (deactivating && occupies(r) && r.units.includes(c.unitId))));
  return settle(m, stranded, deactivating ? "assignment_in_use" : "capacity_conflict", force);
}
export function applyUnitChange(m: Model, c: UnitChange, e: AdminExpectation & { ok: true }, actor: string): void {
  for (const id of e.cancel) applyCancel(find(m, id), actor);
  const u = m.units.find((x) => x.id === c.unitId)!;
  u.min = c.min; u.max = c.max; u.active = c.active;
}

export function expectComboChange(m: Model, comboId: string, active: boolean, force: boolean): AdminExpectation {
  const cur = m.combos.find((x) => x.id === comboId)!;
  const deactivating = cur.active && !active;
  const stranded = !deactivating ? [] : m.reservations.filter((r) => isLive(r, m.clock) && r.kind === "combo" && r.assignmentId === comboId);
  return settle(m, stranded, "assignment_in_use", force);
}
export function applyComboChange(m: Model, comboId: string, active: boolean, e: AdminExpectation & { ok: true }, actor: string): void {
  for (const id of e.cancel) applyCancel(find(m, id), actor);
  m.combos.find((x) => x.id === comboId)!.active = active;
}

/** A blackout that is active after the write strands the live reservations with an active unit row over its range. */
export function expectBlackout(m: Model, start: number, end: number, judged: boolean, force: boolean): AdminExpectation {
  const stranded = !judged ? [] : m.reservations.filter((r) => isLive(r, m.clock) && occupies(r) && overlaps(r.start, r.end, start, end));
  return settle(m, stranded, "blackout_conflict", force);
}
export function applyCancellations(m: Model, e: AdminExpectation & { ok: true }, actor: string): void {
  for (const id of e.cancel) applyCancel(find(m, id), actor);
}

// ---------------------------------------------------------------------------------------------------- reads

/** listHolds: the actor's effectively held reservations, by expiry, then id. */
export const expectListHolds = (m: Model, actor: string): ModelReservation[] =>
  m.reservations.filter((r) => r.actor === actor && effective(r, m.clock) === "held")
    .sort((a, b) => a.expiresAt - b.expiresAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

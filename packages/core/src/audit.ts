// The claim matcher: what an assistant said about reservations, set against what the session's own calls observed.

export const CLAIM_STATUSES = ["held", "confirmed", "seated", "completed", "cancelled", "expired"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export type Claim = { reservation_id: string; status: ClaimStatus; starts_at?: string; party_size?: number; quote?: string };
export type AuditTurn = { role: "user" | "assistant"; text: string; at?: string; claims?: Claim[] };
/** One recorded call as the session log holds it; every field but id, tool, and completedAt may be anything. */
export type LoggedCall = {
  id: number; tool: string; input: unknown; status: number | null; output: unknown; receipt: unknown;
  receiptVerified: boolean | null; completedAt: string | null;
};
export type AuditReceipt = { reservation_id: string; status: string; version: number; audit_id: number; trace_id: string };
export type Observed = {
  call: number; tool: string; at: string; status: string; effective_status: string;
  starts_at?: string; party_size?: number; hold_expires_at?: string; replayed?: true;
};
export type UnbackedReason = "no_observation" | "observed_later" | "status_mismatch" | "starts_at_mismatch" | "party_size_mismatch";
export type ClaimResult = {
  turn: number; claim: Claim; verdict: "backed" | "unbacked"; reason?: UnbackedReason; observed?: Observed;
  /** The latest receipts of the reservation up to the claim, at most MAX_CLAIM_RECEIPTS, in completion order. */
  receipts: AuditReceipt[];
  /** How many earlier receipts are left out of `receipts`. */
  receipts_omitted: number;
  current_status: string; current_differs: boolean;
};
export type AuditResult = {
  session_id: string; audited_at: string; mode: "timed" | "coarse";
  claims: { total: number; backed: number; unbacked: number };
  results: ClaimResult[];
  receipts: { recorded: number; verified: number; unverified: { call: number; receipt: unknown }[] };
  unknown_outcomes: number; confirmations: number; undeclared: "not checked";
};
export type AuditInput = { sessionId: string; auditedAt: string; calls: LoggedCall[]; turns: AuditTurn[]; current: Record<string, string> };

/** The most receipts one claim's result lists. */
export const MAX_CLAIM_RECEIPTS = 10;

type Recorded = { receipt: AuditReceipt; ms: number; call: number };
type Attrs = { starts_at?: string; party_size?: number; hold_expires_at?: string };
/** A reservation's state as one completed call showed it. */
type Obs = Attrs & { call: number; tool: string; at: string; ms: number; status: string; replayed?: true };
type Seen = { id: string; status: string; attrs: Attrs; replayed: boolean };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function field(source: unknown, key: string): unknown {
  return isRecord(source) ? source[key] : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
/** Only the fields that have the right type; a value of the wrong type is absent. */
function attrs(startsAt: unknown, partySize: unknown, holdExpiresAt: unknown): Attrs {
  const out: Attrs = {};
  if (typeof startsAt === "string") out.starts_at = startsAt;
  if (typeof partySize === "number" && Number.isFinite(partySize)) out.party_size = partySize;
  if (typeof holdExpiresAt === "string") out.hold_expires_at = holdExpiresAt;
  return out;
}
function fromRecord(source: unknown): Attrs {
  return attrs(field(source, "starts_at"), field(source, "party_size"), field(source, "hold_expires_at"));
}

function asReceipt(v: unknown): AuditReceipt | undefined {
  if (!isRecord(v)) return undefined;
  const { reservation_id, status, version, audit_id, trace_id } = v;
  if (typeof reservation_id !== "string" || typeof status !== "string" || typeof version !== "number"
    || typeof audit_id !== "number" || typeof trace_id !== "string") return undefined;
  return { reservation_id, status, version, audit_id, trace_id };
}

/** What one completed call shows about reservations. A call whose recorded fields lack what a row needs shows nothing. */
function seen(c: LoggedCall, previous: ReadonlyMap<string, Obs>): Seen[] {
  switch (c.tool) {
    case "hold": {
      if (c.status !== 201) return [];
      const id = str(field(c.receipt, "reservation_id"));
      const status = str(field(c.receipt, "status"));
      if (id === undefined || status === undefined) return [];
      const a = attrs(field(c.input, "starts_at"), field(c.input, "party_size"), field(c.output, "hold_expires_at"));
      return [{ id: id.toLowerCase(), status, attrs: a, replayed: field(c.output, "replayed") === true }];
    }
    case "get_reservation": {
      if (c.status !== 200) return [];
      const id = str(field(c.output, "id"));
      const status = str(field(c.output, "status"));
      if (id === undefined || status === undefined) return [];
      return [{ id: id.toLowerCase(), status, attrs: fromRecord(c.output), replayed: false }];
    }
    case "list_holds": {
      const holds = field(c.output, "holds");
      if (c.status !== 200 || !Array.isArray(holds)) return [];
      const out: Seen[] = [];
      for (const hold of holds as unknown[]) {
        const id = str(field(hold, "id"));
        if (id !== undefined) out.push({ id: id.toLowerCase(), status: "held", attrs: fromRecord(hold), replayed: false });
      }
      return out;
    }
    case "cancel": case "seat": case "complete": case "confirm": {
      if (c.status !== 200) return [];
      const id = str(field(c.receipt, "reservation_id"));
      const status = str(field(c.receipt, "status"));
      if (id === undefined || status === undefined) return [];
      const key = id.toLowerCase();
      const before = previous.get(key);
      const carried = before === undefined ? {} : attrs(before.starts_at, before.party_size, before.hold_expires_at);
      return [{ id: key, status, attrs: carried, replayed: false }];
    }
    default:
      return [];
  }
}

export type ObservedReservation = { id: string; starts_at?: string; party_size?: number };

/** Each reservation the completed calls showed, read as auditSession reads them, in the order first seen; start and party size from the latest observation that has each. */
export function observedReservations(calls: readonly LoggedCall[]): ObservedReservation[] {
  const completed: { c: LoggedCall; ms: number }[] = [];
  for (const c of [...calls].sort((a, b) => a.id - b.id)) {
    const ms = typeof c.completedAt === "string" ? Date.parse(c.completedAt) : NaN;
    if (!Number.isNaN(ms)) completed.push({ c, ms });
  }
  completed.sort((a, b) => a.ms - b.ms || a.c.id - b.c.id);

  const latest = new Map<string, Obs>();
  const out = new Map<string, ObservedReservation>();
  for (const { c, ms } of completed) {
    for (const s of seen(c, latest)) {
      latest.set(s.id, { call: c.id, tool: c.tool, at: c.completedAt as string, ms, status: s.status, ...s.attrs });
      const entry = out.get(s.id) ?? { id: s.id };
      if (s.attrs.starts_at !== undefined) entry.starts_at = s.attrs.starts_at;
      if (s.attrs.party_size !== undefined) entry.party_size = s.attrs.party_size;
      out.set(s.id, entry);
    }
  }
  return [...out.values()];
}

/** A held reservation whose hold ran out at or before the given instant has expired, whether or not anything wrote that down. */
function effectiveStatus(o: Obs, atMs: number): string {
  return o.status === "held" && o.hold_expires_at !== undefined && Date.parse(o.hold_expires_at) <= atMs ? "expired" : o.status;
}

function show(o: Obs, atMs: number): Observed {
  const out: Observed = { call: o.call, tool: o.tool, at: o.at, status: o.status, effective_status: effectiveStatus(o, atMs) };
  if (o.starts_at !== undefined) out.starts_at = o.starts_at;
  if (o.party_size !== undefined) out.party_size = o.party_size;
  if (o.hold_expires_at !== undefined) out.hold_expires_at = o.hold_expires_at;
  if (o.replayed === true) out.replayed = true;
  return out;
}

/** The index of the first element whose time is after `at`, in a list ascending by that time. */
function firstAfter<T>(xs: readonly T[], time: (x: T) => number, at: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (time(xs[mid]!) <= at) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * The latest receipts of one reservation completed at or before the claim's time, at most MAX_CLAIM_RECEIPTS, in
 * completion order, and how many earlier ones are left out. The list is sorted by completion, so a binary search
 * finds where the claim's receipts end, and a claim costs O(log r) plus the receipts it lists.
 */
function latestReceipts(list: readonly Recorded[], atMs: number): { receipts: AuditReceipt[]; omitted: number } {
  const end = firstAfter(list, (r) => r.ms, atMs);
  const from = Math.max(0, end - MAX_CLAIM_RECEIPTS);
  return { receipts: list.slice(from, end).map((r) => r.receipt), omitted: from };
}

export function sameInstant(a: string, b: string): boolean {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isNaN(x) || Number.isNaN(y) ? a === b : x === y;
}

function judge(claim: Claim, o: Obs, effective: string): UnbackedReason | undefined {
  if (effective !== claim.status) return "status_mismatch";
  if (claim.starts_at !== undefined && (o.starts_at === undefined || !sameInstant(claim.starts_at, o.starts_at))) return "starts_at_mismatch";
  if (claim.party_size !== undefined && claim.party_size !== o.party_size) return "party_size_mismatch";
  return undefined;
}

/**
 * Sets each claim an assistant turn made against what the session's own completed calls showed. With a time on every
 * turn, a claim is read against the latest observation completed at or before its turn ("timed"); without, against
 * the latest in the whole log, at the last call's completion ("coarse"). Status outranks the start time, which
 * outranks the party size. Reads the log as data: a call whose recorded fields have the wrong shape shows nothing.
 */
export function auditSession(input: AuditInput): AuditResult {
  const { calls, turns } = input;
  const timed = turns.length > 0 && turns.every((t) => t.at !== undefined && Number.isFinite(Date.parse(t.at)));
  const current = new Map(Object.entries(input.current).map(([id, status]): [string, string] => [id.toLowerCase(), status]));

  const byId = [...calls].sort((a, b) => a.id - b.id);
  const completed: { c: LoggedCall; ms: number }[] = [];
  for (const c of byId) {
    const ms = typeof c.completedAt === "string" ? Date.parse(c.completedAt) : NaN;
    if (!Number.isNaN(ms)) completed.push({ c, ms });
  }
  completed.sort((a, b) => a.ms - b.ms || a.c.id - b.c.id);
  const lastMs = completed.length === 0 ? NaN : completed[completed.length - 1]!.ms;

  const observations = new Map<string, Obs[]>();
  const latest = new Map<string, Obs>();
  for (const { c, ms } of completed) {
    for (const s of seen(c, latest)) {
      const o: Obs = { call: c.id, tool: c.tool, at: c.completedAt as string, ms, status: s.status, ...s.attrs, ...(s.replayed ? { replayed: true as const } : {}) };
      const list = observations.get(s.id);
      if (list === undefined) observations.set(s.id, [o]); else list.push(o);
      latest.set(s.id, o);
    }
  }

  // Each reservation's receipts that have a completion time, in completion order (then call id), the order observations use.
  const recorded = new Map<string, Recorded[]>();
  const unverified: { call: number; receipt: unknown }[] = [];
  let receiptCount = 0;
  let verified = 0;
  let unknownOutcomes = 0;
  let confirmations = 0;
  for (const c of byId) {
    if (typeof c.completedAt !== "string") unknownOutcomes++;
    if (c.tool === "confirm" && c.status === 200) confirmations++;
    if (c.receipt === null || c.receipt === undefined) continue;
    receiptCount++;
    if (c.receiptVerified === true) verified++; else unverified.push({ call: c.id, receipt: c.receipt });
    const receipt = asReceipt(c.receipt);
    const ms = typeof c.completedAt === "string" ? Date.parse(c.completedAt) : NaN;
    if (receipt !== undefined && !Number.isNaN(ms)) {
      const id = receipt.reservation_id.toLowerCase();
      const entry: Recorded = { receipt, ms, call: c.id };
      const list = recorded.get(id);
      if (list === undefined) recorded.set(id, [entry]); else list.push(entry);
    }
  }
  for (const list of recorded.values()) list.sort((a, b) => a.ms - b.ms || a.call - b.call);

  const results: ClaimResult[] = [];
  turns.forEach((turn, index) => {
    if (turn.role !== "assistant" || turn.claims === undefined) return;
    const atMs = timed ? Date.parse(turn.at as string) : lastMs;
    for (const claim of turn.claims) {
      const id = claim.reservation_id.toLowerCase();
      const list = observations.get(id) ?? [];
      let matched: Obs | undefined;
      let later: Obs | undefined;
      if (timed) {
        const after = firstAfter(list, (o) => o.ms, atMs);
        matched = list[after - 1];
        later = list[after];
      } else {
        matched = list[list.length - 1];
      }

      const currentStatus = current.get(id) ?? "unknown";
      const { receipts, omitted } = latestReceipts(recorded.get(id) ?? [], atMs);
      const result: ClaimResult = {
        turn: index, claim, verdict: "backed", receipts, receipts_omitted: omitted, current_status: currentStatus, current_differs: false,
      };
      if (matched !== undefined) {
        const effective = effectiveStatus(matched, atMs);
        const reason = judge(claim, matched, effective);
        result.observed = show(matched, atMs);
        result.current_differs = effective !== currentStatus;
        if (reason !== undefined) { result.verdict = "unbacked"; result.reason = reason; }
      } else if (later !== undefined) {
        result.verdict = "unbacked";
        result.reason = "observed_later";
        result.observed = show(later, atMs);
      } else {
        result.verdict = "unbacked";
        result.reason = "no_observation";
      }
      results.push(result);
    }
  });

  const backed = results.filter((r) => r.verdict === "backed").length;
  return {
    session_id: input.sessionId, audited_at: input.auditedAt, mode: timed ? "timed" : "coarse",
    claims: { total: results.length, backed, unbacked: results.length - backed },
    results,
    receipts: { recorded: receiptCount, verified, unverified },
    unknown_outcomes: unknownOutcomes, confirmations, undeclared: "not checked",
  };
}

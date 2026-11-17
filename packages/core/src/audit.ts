// Text scrubbing for the transcripts an audit reads. Emails are masked first, over the whole text, since an address
// can hold what would otherwise be kept (a date or an id before the @); then ids, dates, and times are kept by
// position and the text between them is masked for numbers. Every pattern here runs in linear time on any input:
// a lookbehind keeps a scan from starting inside a run it would only scan again, and no two adjacent
// pieces of a pattern can match the same character, so no position can be matched in two ways.

const HEX = "[0-9a-fA-F]";
const HOUR = String.raw`(?:[01]\d|2[0-3])`;
const MINSEC = String.raw`[0-5]\d`;
const MONTH = String.raw`(?:0[1-9]|1[0-2])`;
const DAY = String.raw`(?:0[1-9]|[12]\d|3[01])`;
const CLOCK = `${HOUR}:${MINSEC}`;

const UUID = `${HEX}{8}-${HEX}{4}-${HEX}{4}-${HEX}{4}-${HEX}{12}`;
/** A date, with an optional time and zone: 2030-06-07, 2030-06-07T19:00:00.000+02:00. A day past 31 is not a date. */
const DATE = String.raw`\d{4}-${MONTH}-${DAY}(?:[T ]${CLOCK}(?::${MINSEC}(?:\.\d{1,9})?)?(?:Z|[+-]${CLOCK})?)?`;
const TIME = `${CLOCK}(?::${MINSEC})?`;

/** The spans kept as written: a uuid, an ISO date or date-time, a bare time. Each stands alone, not inside a longer word. */
const PROTECTED = new RegExp(String.raw`(?<!\w)(?:${UUID}|${DATE}|${TIME})(?!\w)`, "g");

/** The local part may only begin where a run of its characters begins, so one run is scanned once. */
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/**
 * Digit groups read as one number: an optional plus, then groups joined by at most one space, dot, or hyphen;
 * a group may be parenthesized. A separator is required between plain groups, so a run of digits is one group.
 */
const DIGIT_GROUPS = /\+?(?:\(\d+\)|\d+)(?:[ .-]?\(\d+\)|[ .-]\d+|(?<=\))\d+)*/g;

function maskNumber(run: string): string {
  const digits = run.replace(/\D/g, "").length;
  if (digits >= 16) return "[number]";
  if (digits >= 7) return "[phone]";
  return run;
}

function maskGap(gap: string): string {
  return gap === "" ? gap : gap.replace(DIGIT_GROUPS, maskNumber);
}

/**
 * Masks what a transcript should not keep: an email as `[email]`, a number of 7 to 15 digits as `[phone]`, one of
 * 16 or more as `[number]`. A uuid, an ISO date or date-time, and a time of day stay as written. Emails go first,
 * over the whole text, because an address can contain what would otherwise be kept (a date or an id in its local
 * part) and is masked as one. The protected spans are then found and kept by position, and only the text between
 * them is masked for digit groups, so no input can pass for a placeholder. Never throws, and scrubbing twice gives
 * what scrubbing once does.
 */
export function scrubText(text: string): string {
  const mailed = text.includes("@") ? text.replace(EMAIL, "[email]") : text;
  let out = "";
  let last = 0;
  PROTECTED.lastIndex = 0;
  for (let m = PROTECTED.exec(mailed); m !== null; m = PROTECTED.exec(mailed)) {
    out += maskGap(mailed.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + maskGap(mailed.slice(last));
}

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
  receipts: AuditReceipt[]; current_status: string; current_differs: boolean;
};
export type AuditResult = {
  session_id: string; audited_at: string; mode: "timed" | "coarse";
  claims: { total: number; backed: number; unbacked: number };
  results: ClaimResult[];
  receipts: { recorded: number; verified: number; unverified: { call: number; receipt: unknown }[] };
  unknown_outcomes: number; confirmations: number; undeclared: "not checked";
};
export type AuditInput = { sessionId: string; auditedAt: string; calls: LoggedCall[]; turns: AuditTurn[]; current: Record<string, string> };

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

function sameInstant(a: string, b: string): boolean {
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

  const recorded: { id: string; receipt: AuditReceipt; ms: number }[] = [];
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
    if (receipt !== undefined) {
      recorded.push({ id: receipt.reservation_id.toLowerCase(), receipt, ms: typeof c.completedAt === "string" ? Date.parse(c.completedAt) : NaN });
    }
  }

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
        for (const o of list) {
          if (o.ms <= atMs) matched = o;
          else { later = o; break; }
        }
      } else {
        matched = list[list.length - 1];
      }

      const currentStatus = current.get(id) ?? "unknown";
      const receipts = recorded.filter((r) => r.id === id && (!timed || r.ms <= atMs)).map((r) => r.receipt);
      const result: ClaimResult = { turn: index, claim, verdict: "backed", receipts, current_status: currentStatus, current_differs: false };
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

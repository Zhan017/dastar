import type { ClientBase } from "pg";
import { BOUNDS } from "@dastar/core";
import { DastarError, asDastarError } from "../errors.js";
import { setContext, bindVenue } from "../context.js";
import { enqueue, reservationPayload } from "../outbox.js";
import { LOCK_VENUE_EXCLUSIVE_SQL } from "../units.js";

export type AdminContext = { venueId: string; actor: string; traceId: string };
/** For a write that can strand live reservations: cancel them instead of refusing, with this reason. */
export type ForceOption = { force?: boolean; cancelReason?: string };
export type StrandedCode = "capacity_conflict" | "assignment_in_use" | "blackout_conflict" | "reservation_in_progress" | "force_too_large";
export type AdminOutcome<T> =
  | { ok: true; value: T; cancelled: string[] }
  | { ok: false; error: { code: StrandedCode; message: string }; stranded: string[] };
/** A stranded reservation: live by effective status, and whether it is seated or its range has started by database time. */
export type Stranded = { id: string; started: boolean };

/** The columns a stranded query selects; every one orders by start and reads at most BOUNDS.forceCancellations + 1 rows. */
export const STRANDED_COLUMNS = "r.id, (r.status = 'seated' or lower(r.during) <= dastar.dastar_now()) as started";
export const STRANDED_TAIL = `order by lower(r.during), r.id limit ${BOUNDS.forceCancellations + 1}`;
export const LIVE = "dastar.effective_status(r.status, r.hold_expires_at) in ('held', 'confirmed', 'seated')";

// Escaped backslashes and well-formed surrogate pairs are consumed first, so what remains of a `\u` escape is a NUL or a
// surrogate with no partner, which jsonb refuses.
const JSON_VALID_ESCAPES = /\\\\|\\u[dD][89abAB][0-9a-fA-F]{2}\\u[dD][c-fC-F][0-9a-fA-F]{2}/g;
const JSON_REFUSED_ESCAPE = /\\u(?:0000|[dD][89a-fA-F][0-9a-fA-F]{2})/;

/**
 * A plain JSON object as text for a jsonb parameter. Anything else is `invalid_input`: an array, null, a value
 * JSON.stringify refuses (a cycle, a bigint), and a NUL character or an unpaired surrogate in any string or key.
 * `message` replaces the default sentence.
 */
export function jsonText(name: string, value: unknown, message = `${name} must be a JSON object without NUL characters or unpaired surrogates`): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DastarError("invalid_input", message);
  let json: string | undefined;
  try { json = JSON.stringify(value); } catch { json = undefined; }
  if (json === undefined || JSON_REFUSED_ESCAPE.test(json.replace(JSON_VALID_ESCAPES, ""))) throw new DastarError("invalid_input", message);
  return json;
}

/**
 * One admin write in its own transaction: the context set, the venue lock taken exclusively before anything else.
 * Under it no reservation of the venue is inserted or confirmed (the blackout guard takes the lock shared on both),
 * so stranded reservations cannot appear while the write decides; the write's own triggers take unit locks after its
 * row lock. An outcome that refuses rolls back.
 */
export async function adminWrite<T>(client: ClientBase, ctx: AdminContext, fn: () => Promise<AdminOutcome<T>>): Promise<AdminOutcome<T>> {
  await client.query("begin");
  try {
    await setContext(client, ctx);
    await client.query(LOCK_VENUE_EXCLUSIVE_SQL, [ctx.venueId]);
    const out = await fn();
    await client.query(out.ok ? "commit" : "rollback");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw asDastarError(e);
  }
}

/** An admin write that cannot strand a reservation: the same transaction as adminWrite, committed when `fn` returns. */
export async function adminTx<T>(client: ClientBase, ctx: AdminContext, fn: () => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    await setContext(client, ctx);
    await client.query(LOCK_VENUE_EXCLUSIVE_SQL, [ctx.venueId]);
    const out = await fn();
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw asDastarError(e);
  }
}

/** An admin read: read only, repeatable read, bound to the venue. */
export async function adminRead<T>(client: ClientBase, venueId: string, fn: () => Promise<T>): Promise<T> {
  await client.query("begin isolation level repeatable read read only");
  try {
    await bindVenue(client, venueId);
    const out = await fn();
    await client.query("commit");
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw asDastarError(e);
  }
}

/**
 * Without force, stranded reservations refuse the write with `code`. With force, a started one refuses it as
 * reservation_in_progress, more than BOUNDS.forceCancellations refuse it as force_too_large, and otherwise they are
 * cancelled, in id order, with the reason and an outbox event each; one another transaction completed, cancelled,
 * or expired meanwhile is skipped. Returns the ids cancelled, or the refusal.
 */
export async function settleStranded(
  client: ClientBase, ctx: AdminContext, stranded: Stranded[], code: "capacity_conflict" | "assignment_in_use" | "blackout_conflict",
  what: string, opts: ForceOption,
): Promise<{ ok: true; cancelled: string[] } | { ok: false; error: { code: StrandedCode; message: string }; stranded: string[] }> {
  if (stranded.length === 0) return { ok: true, cancelled: [] };
  const ids = stranded.map((s) => s.id);
  const count = stranded.length > BOUNDS.forceCancellations ? `more than ${BOUNDS.forceCancellations}` : String(stranded.length);
  if (!opts.force) {
    return { ok: false, error: { code, message: `${what} would strand ${count} live reservation${stranded.length === 1 ? "" : "s"}; cancel them or retry with force` }, stranded: ids };
  }
  const started = stranded.filter((s) => s.started).map((s) => s.id);
  if (started.length > 0) {
    return { ok: false, error: { code: "reservation_in_progress", message: `${started.length} stranded reservation${started.length === 1 ? " has" : "s have"} already started; close ${started.length === 1 ? "it" : "them"} first` }, stranded: started };
  }
  if (stranded.length > BOUNDS.forceCancellations) {
    return { ok: false, error: { code: "force_too_large", message: `force cancels at most ${BOUNDS.forceCancellations} reservations; ${what} would strand ${count}` }, stranded: ids };
  }
  const sorted = [...ids].sort();
  await client.query("select id from dastar.reservation where id = any ($1::uuid[]) order by id for update", [sorted]);
  const upd = await client.query(
    `update dastar.reservation r set status = 'cancelled', cancel_reason = $2
      where r.id = any ($1::uuid[]) and ${LIVE}
      returning r.id, r.venue_id, r.status, r.version, r.party_size, r.during, r.assignment_kind, r.assignment_id`,
    [sorted, opts.cancelReason ?? "venue change"],
  );
  for (const row of upd.rows) await enqueue(client, ctx.venueId, "reservation.cancelled", reservationPayload(row));
  return { ok: true, cancelled: (upd.rows.map((r) => r.id as string)).sort() };
}

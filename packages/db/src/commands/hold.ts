import type { ClientBase } from "pg";
import { createHash } from "node:crypto";
import { DastarError, STORED_OUTCOMES, mapPgError, asDastarError, type DastarErrorCode } from "../errors.js";
import { setContext, setActor } from "../context.js";
import { sortUnitIds, LOCK_UNIT_SQL } from "../units.js";
import { enqueue, reservationPayload } from "../outbox.js";

export type Assignment = { kind: "unit" | "combo"; id: string };

export type HoldInput = {
  venueId: string;
  actor: string;
  traceId: string;
  idempotencyKey: string;
  partySize: number;
  startsAt: string;
  durationMinutes: number;
  assignment: Assignment;
  externalRef?: string;
};

export type Receipt = { reservationId: string; status: string; version: number; auditId: number; traceId: string };

export type HoldOutcome =
  | { ok: true; receipt: Receipt; holdExpiresAt: string; replayed: boolean }
  | { ok: false; error: { code: DastarErrorCode; message: string }; replayed: boolean };

export type HoldHooks = {
  afterClaim?: () => Promise<void>;
  afterUnitLocks?: () => Promise<void>;
  afterOverlapLocks?: () => Promise<void>;
  beforeCommit?: () => Promise<void>;
  /**
   * Called before the single whole-transaction retry on 40P01 or 40001. `sqlstate` is `""` for the two
   * retryable failures the command raises itself (an idempotency row that vanished or has no stored
   * outcome yet); Postgres errors carry their SQLSTATE.
   */
  onRetry?: (info: { attempt: number; sqlstate: string; error: DastarError }) => void;
};

const MAX_OVERLAP_SET = 64;

export function canonicalHoldRequest(i: HoldInput): string {
  const startsAt = new Date(i.startsAt).toISOString();
  return JSON.stringify({
    assignment: { id: i.assignment.id.toLowerCase(), kind: i.assignment.kind },
    durationMinutes: i.durationMinutes,
    externalRef: i.externalRef ?? null,
    partySize: i.partySize,
    startsAt,
    venueId: i.venueId.toLowerCase(),
  });
}

export function rangeLiteral(startsAt: string, durationMinutes: number): string {
  const s = new Date(startsAt);
  const e = new Date(s.getTime() + durationMinutes * 60_000);
  return `[${s.toISOString()},${e.toISOString()})`;
}

export async function hold(client: ClientBase, input: HoldInput, hooks: HoldHooks = {}): Promise<HoldOutcome> {
  const hash = createHash("sha256").update(canonicalHoldRequest(input)).digest();
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptHold(client, input, hash, hooks);
    } catch (e) {
      const mapped = e instanceof DastarError ? e : mapPgError(e);
      // step 9: whole-transaction retry once on deadlock or serialization failure
      if (mapped?.retryable && mapped.code === "serialization_conflict" && attempt === 1) {
        hooks.onRetry?.({ attempt, sqlstate: mapped.sqlstate ?? "", error: mapped });
        continue;
      }
      throw mapped ?? asDastarError(e);
    }
  }
}

async function attemptHold(client: ClientBase, input: HoldInput, hash: Buffer, hooks: HoldHooks): Promise<HoldOutcome> {
  const during = rangeLiteral(input.startsAt, input.durationMinutes);
  await client.query("begin");
  try {
    // step 2: transaction-local context
    await setContext(client, { actor: input.actor, traceId: input.traceId, venueId: input.venueId });

    // step 3: claim the idempotency key; the insert waits on an in-flight claim of the same key
    const claim = await client.query(
      `insert into dastar.idempotency (venue_id, actor, key, request_hash, purge_at)
       values ($1, $2, $3, $4, now() + interval '24 hours')
       on conflict do nothing returning key`,
      [input.venueId, input.actor, input.idempotencyKey, hash],
    );
    if (claim.rowCount === 0) {
      const existing = await client.query(
        "select request_hash, response from dastar.idempotency where venue_id = $1 and actor = $2 and key = $3",
        [input.venueId, input.actor, input.idempotencyKey],
      );
      await client.query("commit");
      const row = existing.rows[0] as { request_hash: Buffer; response: HoldOutcome | null } | undefined;
      if (!row) throw new DastarError("serialization_conflict", "idempotency row vanished between claim and read", undefined, true);
      if (!row.request_hash.equals(hash)) throw new DastarError("idempotency_mismatch", "same idempotency key, different payload");
      if (row.response == null) throw new DastarError("serialization_conflict", "idempotency outcome not stored yet", undefined, true);
      return { ...row.response, replayed: true };
    }
    await hooks.afterClaim?.();

    // step 4: resolve and sort units, take the unit locks in order, check the live-holds cap
    const resolved = await resolveAssignment(client, input);
    if (resolved.kind === "missing") {
      return await storeOutcome(client, input, hooks, { ok: false, error: { code: "party_does_not_fit", message: "assignment not found in venue" }, replayed: false });
    }
    if (!resolved.active) throw new DastarError("assignment_inactive", "assignment is deactivated");
    const units = resolved.units;
    for (const u of units) await client.query(LOCK_UNIT_SQL, [u]);
    await hooks.afterUnitLocks?.();

    const cap = await client.query("select max_live_holds_per_actor as cap, hold_ttl_seconds as ttl from dastar.venue where id = $1", [input.venueId]);
    const live = await client.query(
      "select count(*)::int as n from dastar.reservation where venue_id = $1 and created_by = $2 and status = 'held' and hold_expires_at > dastar.dastar_now()",
      [input.venueId, input.actor],
    );
    if (live.rows[0].n >= cap.rows[0].cap) throw new DastarError("too_many_live_holds", `actor has ${live.rows[0].n} live holds`);
    const ttlSeconds: number = cap.rows[0].ttl;

    // step 5: overlap lock set in reservation-id order, then expire the dead ones
    const overlap = await client.query(
      `select distinct ru.reservation_id as id
         from dastar.reservation_unit ru
        where ru.unit_id = any ($1::uuid[]) and ru.active and ru.during && $2::tstzrange`,
      [units, during],
    );
    if (overlap.rowCount! > MAX_OVERLAP_SET) {
      throw new DastarError("overlap_set_too_large", `${overlap.rowCount} overlapping reservations; the sweeper is behind`, undefined, true);
    }
    if (overlap.rowCount! > 0) {
      const locked = await client.query(
        `select id, (status = 'held' and hold_expires_at <= dastar.dastar_now()) as dead
           from dastar.reservation where id = any ($1::uuid[]) order by id for update`,
        [overlap.rows.map((r) => r.id)],
      );
      const dead = locked.rows.filter((r) => r.dead === true).map((r) => r.id as string);
      if (dead.length > 0) {
        await setActor(client, "system:conflict");
        for (const id of dead) {
          const r = await client.query(
            `update dastar.reservation set status = 'expired'
              where id = $1 and status = 'held' and hold_expires_at <= dastar.dastar_now()
              returning id, venue_id, status, version, party_size, during, assignment_kind, assignment_id`,
            [id],
          );
          if (r.rowCount === 1) await enqueue(client, r.rows[0].venue_id, "reservation.expired", reservationPayload(r.rows[0]));
        }
        await setActor(client, input.actor);
      }
    }
    await hooks.afterOverlapLocks?.();

    // step 6: single booking attempt under a savepoint
    await client.query("savepoint booking");
    let row: { id: string; venue_id: string; status: string; version: number; party_size: number; during: string; assignment_kind: string; assignment_id: string; hold_expires_at: Date };
    try {
      const ins = await client.query(
        `insert into dastar.reservation
           (venue_id, party_size, during, status, assignment_kind, assignment_id, hold_expires_at, external_ref, created_by)
         values ($1, $2, $3::tstzrange, 'held', $4, $5, dastar.dastar_now() + make_interval(secs => $6), $7, $8)
         returning id, venue_id, status, version, party_size, during, assignment_kind, assignment_id, hold_expires_at`,
        [input.venueId, input.partySize, during, input.assignment.kind, input.assignment.id, ttlSeconds, input.externalRef ?? null, input.actor],
      );
      row = ins.rows[0];
      for (const u of units) {
        await client.query(
          "insert into dastar.reservation_unit (venue_id, reservation_id, unit_id, during) values ($1, $2, $3, $4::tstzrange)",
          [input.venueId, row.id, u, during],
        );
      }
      await client.query("release savepoint booking");
    } catch (e) {
      // step 8: a domain outcome is stored under the still-owned key
      await client.query("rollback to savepoint booking");
      const mapped = mapPgError(e);
      if (mapped && STORED_OUTCOMES.has(mapped.code)) {
        return await storeOutcome(client, input, hooks, { ok: false, error: { code: mapped.code, message: mapped.message }, replayed: false });
      }
      throw e;
    }

    // step 7: outbox, receipt, stored response, commit (deferred membership trigger runs at commit)
    await enqueue(client, input.venueId, "reservation.held", reservationPayload(row));
    const audit = await client.query("select max(id) as id from dastar.audit_log where entity_id = $1", [row.id]);
    const outcome: HoldOutcome = {
      ok: true,
      receipt: { reservationId: row.id, status: row.status, version: row.version, auditId: Number(audit.rows[0].id), traceId: input.traceId },
      holdExpiresAt: new Date(row.hold_expires_at).toISOString(),
      replayed: false,
    };
    return await storeOutcome(client, input, hooks, outcome);
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  }
}

async function storeOutcome(client: ClientBase, input: HoldInput, hooks: HoldHooks, outcome: HoldOutcome): Promise<HoldOutcome> {
  await client.query(
    "update dastar.idempotency set response = $4::jsonb where venue_id = $1 and actor = $2 and key = $3",
    [input.venueId, input.actor, input.idempotencyKey, JSON.stringify(outcome)],
  );
  await hooks.beforeCommit?.();
  await client.query("commit");
  return outcome;
}

async function resolveAssignment(client: ClientBase, input: HoldInput): Promise<{ kind: "missing" } | { kind: "found"; units: string[]; active: boolean }> {
  if (input.assignment.kind === "unit") {
    const r = await client.query("select id, active from dastar.unit where id = $1 and venue_id = $2", [input.assignment.id, input.venueId]);
    if (r.rowCount === 0) return { kind: "missing" };
    return { kind: "found", units: sortUnitIds([r.rows[0].id]), active: r.rows[0].active };
  }
  const r = await client.query("select unit_ids, active from dastar.unit_combo where id = $1 and venue_id = $2", [input.assignment.id, input.venueId]);
  if (r.rowCount === 0) return { kind: "missing" };
  return { kind: "found", units: sortUnitIds(r.rows[0].unit_ids as string[]), active: r.rows[0].active };
}

import { expect } from "vitest";
import type { Client } from "pg";
import { effective, occupies, type Model } from "./model.js";

const LIVE_SQL = "dastar.effective_status(r.status, r.hold_expires_at) in ('held', 'confirmed', 'seated')";

/**
 * Each query returns the rows that break one invariant, for the run's venue, read by the owner apart from the model:
 * 1 overlapping active unit rows; 4 a live party outside its assignment's capacity; 8 a unit row active while its
 * reservation does not occupy, or inactive while it does; 9 unit rows other than the assignment's members; 11 a live
 * reservation's active row over an active blackout; 12 a live reservation on an inactive unit, combination, or member.
 */
const INVARIANTS: Record<string, string> = {
  "1": `select a.reservation_id, b.reservation_id as other from dastar.reservation_unit a
          join dastar.reservation_unit b on b.unit_id = a.unit_id and b.reservation_id > a.reservation_id and b.active and b.during && a.during
         where a.venue_id = $1 and a.active`,
  "4": `select r.id from dastar.reservation r
          left join dastar.unit u on r.assignment_kind = 'unit' and u.id = r.assignment_id
          left join dastar.unit_combo c on r.assignment_kind = 'combo' and c.id = r.assignment_id
         where r.venue_id = $1 and ${LIVE_SQL}
           and r.party_size not between coalesce(u.capacity_min, c.capacity_min) and coalesce(u.capacity_max, c.capacity_max)`,
  "8": `select ru.reservation_id, ru.unit_id from dastar.reservation_unit ru join dastar.reservation r on r.id = ru.reservation_id
         where r.venue_id = $1 and ru.active <> (r.status in ('held', 'confirmed', 'seated', 'completed'))`,
  "9": `select r.id from dastar.reservation r
         where r.venue_id = $1
           and (select array_agg(ru.unit_id order by ru.unit_id) from dastar.reservation_unit ru where ru.reservation_id = r.id)
               is distinct from
               (case when r.assignment_kind = 'unit' then array[r.assignment_id]
                     else (select array_agg(m order by m) from dastar.unit_combo c, unnest(c.unit_ids) m where c.id = r.assignment_id) end)`,
  "11": `select r.id from dastar.reservation r
          join dastar.reservation_unit ru on ru.reservation_id = r.id and ru.active
          join dastar.blackout b on b.venue_id = r.venue_id and b.active and b.during && ru.during
         where r.venue_id = $1 and ${LIVE_SQL}`,
  "12": `select r.id from dastar.reservation r
         where r.venue_id = $1 and ${LIVE_SQL}
           and case when r.assignment_kind = 'unit' then not (select u.active from dastar.unit u where u.id = r.assignment_id)
                    else not (select c.active and not exists (select 1 from unnest(c.unit_ids) m join dastar.unit x on x.id = m where not x.active)
                                from dastar.unit_combo c where c.id = r.assignment_id) end`,
};

const ms = (v: unknown): number => new Date(v as string).getTime();

/** After every command: the database equals the model for the venue, the trails match, and the invariants hold. */
export async function verify(m: Model, owner: Client, where: string): Promise<void> {
  const v = m.venueId;

  const res = await owner.query(
    `select id, created_by, assignment_kind, assignment_id, party_size, lower(during) as s, upper(during) as e, status, version,
            hold_expires_at, dastar.effective_status(status, hold_expires_at) as effective, confirm_token_hash is not null as has_token
       from dastar.reservation where venue_id = $1 order by id`, [v]);
  const want = [...m.reservations].sort((a, b) => (a.id < b.id ? -1 : 1));
  expect(res.rows.map((r) => ({
    id: r.id, actor: r.created_by, kind: r.assignment_kind, assignmentId: r.assignment_id, party: r.party_size, start: ms(r.s), end: ms(r.e),
    status: r.status, effective: r.effective, version: r.version, expiresAt: ms(r.hold_expires_at), token: r.has_token,
  })), `${where}: reservations`).toEqual(want.map((r) => ({
    id: r.id, actor: r.actor, kind: r.kind, assignmentId: r.assignmentId, party: r.party, start: r.start, end: r.end,
    status: r.status, effective: effective(r, m.clock), version: r.version, expiresAt: r.expiresAt, token: r.token !== null,
  })));

  const rows = await owner.query(
    "select reservation_id, unit_id, active, lower(during) as s, upper(during) as e from dastar.reservation_unit where venue_id = $1 order by reservation_id, unit_id", [v]);
  expect(rows.rows.map((r) => ({ id: r.reservation_id, unit: r.unit_id, active: r.active, start: ms(r.s), end: ms(r.e) })), `${where}: unit rows`)
    .toEqual(want.flatMap((r) => [...r.units].sort().map((u) => ({ id: r.id, unit: u, active: occupies(r), start: r.start, end: r.end }))));

  const config = await owner.query("select id, capacity_min, capacity_max, active from dastar.unit where venue_id = $1 order by id", [v]);
  expect(config.rows.map((u) => ({ id: u.id, min: u.capacity_min, max: u.capacity_max, active: u.active })), `${where}: units`)
    .toEqual([...m.units].sort((a, b) => (a.id < b.id ? -1 : 1)).map((u) => ({ id: u.id, min: u.min, max: u.max, active: u.active })));
  const combos = await owner.query("select id, unit_ids, capacity_min, capacity_max, active from dastar.unit_combo where venue_id = $1 order by id", [v]);
  expect(combos.rows.map((c) => ({ id: c.id, members: [...(c.unit_ids as string[])].sort(), min: c.capacity_min, max: c.capacity_max, active: c.active })), `${where}: combinations`)
    .toEqual([...m.combos].sort((a, b) => (a.id < b.id ? -1 : 1)).map((c) => ({ id: c.id, members: [...c.members].sort(), min: c.min, max: c.max, active: c.active })));
  const blackouts = await owner.query("select id, lower(during) as s, upper(during) as e, active from dastar.blackout where venue_id = $1 order by id", [v]);
  expect(blackouts.rows.map((b) => ({ id: b.id, start: ms(b.s), end: ms(b.e), active: b.active })), `${where}: blackouts`)
    .toEqual([...m.blackouts].sort((a, b) => (a.id < b.id ? -1 : 1)).map((b) => ({ id: b.id, start: b.start, end: b.end, active: b.active })));

  // every insert and update of a reservation writes one audit row by the actor in effect (invariant 6)
  const audit = await owner.query("select entity_id, action, actor from dastar.audit_log where venue_id = $1 and entity = 'reservation' order by id", [v]);
  const trails = new Map<string, { action: string; actor: string }[]>();
  for (const a of audit.rows) trails.set(a.entity_id, [...(trails.get(a.entity_id) ?? []), { action: a.action, actor: a.actor }]);
  expect(Object.fromEntries(want.map((r) => [r.id, trails.get(r.id) ?? []])), `${where}: audit trails`)
    .toEqual(Object.fromEntries(want.map((r) => [r.id, r.audit])));
  expect([...trails.keys()].filter((id) => !want.some((r) => r.id === id)), `${where}: audit rows of unknown reservations`).toEqual([]);

  // every transition writes one outbox event, and nothing else writes one (outbox completeness)
  const outbox = await owner.query(
    `select o.payload->>'reservation_id' as reservation_id, o.topic, o.payload->>'status' as status, (o.payload->>'version')::int as version
       from dastar.outbox o where o.venue_id = $1 order by o.id`, [v]);
  const events = new Map<string, { topic: string; status: string; version: number }[]>();
  for (const o of outbox.rows) events.set(o.reservation_id, [...(events.get(o.reservation_id) ?? []), { topic: o.topic, status: o.status, version: o.version }]);
  expect(Object.fromEntries(want.map((r) => [r.id, events.get(r.id) ?? []])), `${where}: outbox events`)
    .toEqual(Object.fromEntries(want.map((r) => [r.id, r.outbox])));
  expect([...events.keys()].filter((id) => !want.some((r) => r.id === id)), `${where}: outbox rows of unknown reservations`).toEqual([]);

  for (const [n, sql] of Object.entries(INVARIANTS)) {
    expect((await owner.query(sql, [v])).rows, `${where}: invariant ${n}`).toEqual([]);
  }
}

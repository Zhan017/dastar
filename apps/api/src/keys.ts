import type { Deps } from "./env.js";
import { createKey } from "./auth.js";
import { readLimits, withClient } from "./db.js";
import { ApiProblem } from "./problem.js";

/** A key as the routes show it. The hash and the presented key are never part of it. */
export type KeyView = { id: string; label: string; capabilities: string[]; venueIds: string[]; createdAt: string; revokedAt: string | null };

const COLUMNS = "id, label, capabilities, venue_ids, created_at, revoked_at";

type KeyRow = { id: string; label: string; capabilities: string[]; venue_ids: string[]; created_at: Date; revoked_at: Date | null };

const toView = (r: KeyRow): KeyView => ({
  id: r.id, label: r.label, capabilities: r.capabilities, venueIds: r.venue_ids,
  createdAt: r.created_at.toISOString(), revokedAt: r.revoked_at === null ? null : r.revoked_at.toISOString(),
});

/**
 * A venue's routes see the keys scoped to that venue alone: `venue_ids` equal to `[venue]`. A key of several
 * venues, of all venues, or of another venue is invisible to them and cannot be changed through them.
 */
export async function listVenueKeys(deps: Deps, venueId: string): Promise<KeyView[]> {
  return withClient(deps.pool, readLimits(deps), async (c) => {
    const r = await c.query(`select ${COLUMNS} from dastar.api_key where venue_ids = array[$1::uuid] order by created_at, id`, [venueId]);
    return (r.rows as KeyRow[]).map(toView);
  });
}

/**
 * Creates a key for the venue alone and returns it with the presented secret, which is not stored. Venue rows
 * are under row-level security, so the existence check runs in a transaction bound to the venue.
 */
export async function createVenueKey(deps: Deps, venueId: string, opts: { label: string; capabilities: string[] }): Promise<{ key: KeyView; secret: string }> {
  const out = await withClient(deps.pool, readLimits(deps), async (c) => {
    await c.query("begin");
    try {
      await c.query("select set_config('dastar.venue_id', $1, true)", [venueId]);
      if ((await c.query("select 1 from dastar.venue where id = $1", [venueId])).rowCount === 0) {
        await c.query("rollback");
        return null;
      }
      const created = await createKey(c, { label: opts.label, capabilities: opts.capabilities, venueIds: [venueId] });
      const row = (await c.query(`select ${COLUMNS} from dastar.api_key where id = $1`, [created.id])).rows[0] as KeyRow;
      await c.query("commit");
      return { key: toView(row), secret: created.key };
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      throw e;
    }
  });
  if (out === null) throw new ApiProblem(404, "not_found", "no such venue");
  return out;
}

/** Sets `revoked_at` once; a second revocation keeps the first time. A key that is not scoped to the venue alone is absent. */
export async function revokeVenueKey(deps: Deps, venueId: string, keyId: string): Promise<KeyView> {
  const row = await withClient(deps.pool, readLimits(deps), async (c) => {
    const r = await c.query(
      `update dastar.api_key set revoked_at = coalesce(revoked_at, now()) where id = $1 and venue_ids = array[$2::uuid] returning ${COLUMNS}`,
      [keyId, venueId],
    );
    return r.rowCount === 0 ? null : r.rows[0] as KeyRow;
  });
  if (row === null) throw new ApiProblem(404, "not_found", "no such key");
  return toView(row);
}

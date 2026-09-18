import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { Pool } from "pg";
import type { ApiKey, Deps, Env } from "./env.js";
import { ApiProblem } from "./problem.js";
import { withClient } from "./db.js";

export type Capability = "hold" | "confirm" | "cancel" | "read";

const KEY_RE = /^dsk_[A-Za-z0-9_-]{43}$/;
const BEARER_RE = /^Bearer (\S+)$/;

export function hashKey(presented: string): Buffer {
  return createHash("sha256").update(presented).digest();
}

/** The presented key is returned once and never stored; the table holds its SHA-256. */
export async function createKey(pool: Pool, opts: { label: string; capabilities: string[]; venueIds?: string[] | null }): Promise<{ id: string; key: string }> {
  const key = `dsk_${randomBytes(32).toString("base64url")}`;
  const r = await pool.query(
    "insert into dastar.api_key (label, key_hash, capabilities, venue_ids) values ($1, $2, $3::text[], $4::uuid[]) returning id",
    [opts.label, hashKey(key), opts.capabilities, opts.venueIds ?? null],
  );
  return { id: r.rows[0].id as string, key };
}

export async function findKey(deps: Deps, presented: string): Promise<ApiKey | null> {
  if (!KEY_RE.test(presented)) return null;
  return withClient(deps.pool, deps.acquireTimeoutMs ?? 5_000, async (c) => {
    const r = await c.query("select id, capabilities, venue_ids from dastar.api_key where key_hash = $1 and revoked_at is null", [hashKey(presented)]);
    if (r.rowCount === 0) return null;
    return { id: r.rows[0].id as string, capabilities: r.rows[0].capabilities as string[], venueIds: (r.rows[0].venue_ids as string[] | null) ?? null };
  });
}

/**
 * Route-scoped, never blanket. With `orToken`, a request without a key passes through (the handler then
 * requires a confirm token), and a presented key is validated but its capabilities are not consulted here.
 */
export function requireCapability(deps: Deps, capability: Capability, opts: { orToken?: boolean } = {}) {
  return createMiddleware<Env>(async (c, next) => {
    const header = c.req.header("authorization");
    if (header === undefined) {
      if (opts.orToken) return next();
      throw new ApiProblem(401, "unauthorized", "a bearer key is required");
    }
    const presented = BEARER_RE.exec(header)?.[1];
    const key = presented === undefined ? null : await findKey(deps, presented);
    if (!key) throw new ApiProblem(401, "unauthorized", "unknown or revoked key");
    if (!opts.orToken && !key.capabilities.includes(capability)) throw new ApiProblem(403, "forbidden", `the key lacks the ${capability} capability`);
    c.set("key", key);
    return next();
  });
}

export function requireKey(c: Context<Env>): ApiKey {
  const key = c.get("key");
  if (!key) throw new ApiProblem(401, "unauthorized", "a bearer key is required");
  return key;
}

/** Outside the key's venues reads as absent, so scope is not leaked. */
export function assertVenueInScope(key: ApiKey, venueId: string): void {
  if (key.venueIds !== null && !key.venueIds.includes(venueId.toLowerCase())) throw new ApiProblem(404, "not_found", "no such venue");
}

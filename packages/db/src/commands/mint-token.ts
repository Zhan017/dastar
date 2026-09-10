import type { ClientBase } from "pg";
import { createHash, randomBytes } from "node:crypto";
import { DastarError, mapPgError } from "../errors.js";
import { setContext } from "../context.js";

export type MintInput = { reservationId: string; actor: string; traceId: string; venueId: string; expectedVersion?: number };

/** Requires the caller to hold confirm authority (checked by the API layer, spec D6). */
export async function mintConfirmToken(client: ClientBase, input: MintInput): Promise<{ token: string; version: number }> {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest();
  await client.query("begin");
  try {
    await setContext(client, { actor: input.actor, traceId: input.traceId, venueId: input.venueId });
    const upd = await client.query(
      `update dastar.reservation set confirm_token_hash = $3
        where id = $1 and venue_id = $4 and ($2::int is null or version = $2)
        returning version`,
      [input.reservationId, input.expectedVersion ?? null, hash, input.venueId],
    );
    if (upd.rowCount === 0) {
      const exists = await client.query("select 1 from dastar.reservation where id = $1 and venue_id = $2", [input.reservationId, input.venueId]);
      throw new DastarError(exists.rowCount === 0 ? "not_found" : "version_conflict", "mint failed");
    }
    await client.query("commit");
    return { token, version: upd.rows[0].version as number };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e instanceof DastarError ? e : (mapPgError(e) ?? e);
  }
}

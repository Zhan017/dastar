import type { ClientBase } from "pg";

export type Context = { actor: string; traceId: string; venueId: string };

/** Transaction-local; call after BEGIN. */
export async function setContext(client: ClientBase, ctx: Context): Promise<void> {
  await client.query(
    "select set_config('dastar.actor', $1, true), set_config('dastar.trace_id', $2, true), set_config('dastar.venue_id', $3, true)",
    [ctx.actor, ctx.traceId, ctx.venueId],
  );
}

export async function setActor(client: ClientBase, actor: string): Promise<void> {
  await client.query("select set_config('dastar.actor', $1, true)", [actor]);
}

import type { ClientBase } from "pg";
import { inVenue, toView, SESSION_COLUMNS, type OpenSessionInput, type SessionHooks, type SessionRef, type SessionView, type StoredTurn } from "./sessions.js";

export type ClaimTurnInput = SessionRef & { apiKeyId: string; content: string; maxUserTurns: number; staleAfterMs: number };
export type ClaimTurnOutcome =
  | { kind: "claimed"; seq: number; at: string }
  | { kind: "missing" }
  | { kind: "busy" }
  | { kind: "stale"; seq: number; at: string }
  | { kind: "full" };
/** What the agent records of a turn it answered: the model, the hash of the prompt, its calls and tokens, and how long it took. */
export type TurnRecord = {
  model: string; promptHash: string; providerCalls: number; regenerations: number; fellBack: boolean;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; latencyMs: number;
};
export type StoreReplyInput = SessionRef & { seq: number; content: string; claims: unknown[]; guardrailFired: boolean; at: string | null; record: TurnRecord };
export type SessionHoldRow = { reservationId: string; tokenEnc: Buffer };
export type PutSessionHoldInput = SessionRef & { reservationId: string; tokenEnc: Buffer };
export type VenueProfile = { id: string; name: string; timezone: string };

/** A new reference session for the key in the venue. `not_found` when the venue does not exist. */
export async function openReferenceSession(client: ClientBase, input: OpenSessionInput): Promise<SessionView> {
  return await inVenue(client, input.venueId, "write", async () => {
    const r = await client.query(
      `insert into dastar_agent.session (venue_id, api_key_id, kind) values ($1, $2, 'reference') returning ${SESSION_COLUMNS}`,
      [input.venueId, input.apiKeyId],
    );
    return toView(r.rows[0]);
  });
}

/**
 * Takes the session's next user turn. The statement that touches the session takes its row lock first, so claims made
 * at once are judged one after the other and the second reads the first's turn. A session that is not the key's
 * reference session in the venue is `missing`; a last turn that is a user turn is `busy` until it is `staleAfterMs` old
 * and `stale` after, with nothing inserted either way; `maxUserTurns` user turns make it `full`; otherwise the turn is
 * inserted at the next seq, stamped with the database's time.
 */
export async function claimTurn(client: ClientBase, input: ClaimTurnInput, hooks: SessionHooks = {}): Promise<ClaimTurnOutcome> {
  return await inVenue(client, input.venueId, "write", async () => {
    const s = await client.query(
      `update dastar_agent.session set last_seen_at = dastar.dastar_now()
        where id = $1 and venue_id = $2 and api_key_id = $3 and kind = 'reference'
        returning id`,
      [input.sessionId, input.venueId, input.apiKeyId],
    );
    let out: ClaimTurnOutcome;
    if (s.rowCount === 0) {
      out = { kind: "missing" };
    } else {
      const last = await client.query(
        `select seq, role, at, at <= dastar.dastar_now() - make_interval(secs => $3::float8 / 1000) as stale
           from dastar_agent.turn where session_id = $1 and venue_id = $2 order by seq desc limit 1`,
        [input.sessionId, input.venueId, input.staleAfterMs],
      );
      const users = await client.query(
        "select count(*)::int as n from dastar_agent.turn where session_id = $1 and venue_id = $2 and role = 'user'",
        [input.sessionId, input.venueId],
      );
      // a user turn of a reference session is always written with its time
      const tail = last.rows[0] as { seq: number; role: string; at: Date; stale: boolean } | undefined;
      if (tail !== undefined && tail.role === "user") {
        out = tail.stale ? { kind: "stale", seq: tail.seq, at: new Date(tail.at).toISOString() } : { kind: "busy" };
      } else if ((users.rows[0].n as number) >= input.maxUserTurns) {
        out = { kind: "full" };
      } else {
        const ins = await client.query(
          `insert into dastar_agent.turn (session_id, venue_id, seq, role, content, at)
           values ($1, $2, $3, 'user', $4, dastar.dastar_now())
           returning seq, at`,
          [input.sessionId, input.venueId, tail === undefined ? 0 : tail.seq + 1, input.content],
        );
        out = { kind: "claimed", seq: ins.rows[0].seq as number, at: new Date(ins.rows[0].at).toISOString() };
      }
    }
    await hooks.beforeCommit?.();
    return out;
  });
}

/**
 * Stores the assistant turn answering the user turn before it, with the turn's record, once. False when the seq is
 * already taken or the turn before it is not a user turn; nothing is then written. A null time is the database's.
 */
export async function storeReply(client: ClientBase, input: StoreReplyInput): Promise<boolean> {
  return await inVenue(client, input.venueId, "write", async () => {
    const r = await client.query(
      `insert into dastar_agent.turn (session_id, venue_id, seq, role, content, claims, guardrail_fired, at, model, prompt_hash,
                                      provider_calls, regenerations, fell_back, input_tokens, output_tokens, cache_read_tokens,
                                      cache_write_tokens, latency_ms)
       select $1::uuid, $2::uuid, $3::int, 'assistant', $4::text, $5::jsonb, $6::boolean, coalesce($7::timestamptz, dastar.dastar_now()),
              $8::text, $9::text, $10::smallint, $11::smallint, $12::boolean, $13::int, $14::int, $15::int, $16::int, $17::int
        where exists (select 1 from dastar_agent.turn where session_id = $1::uuid and venue_id = $2::uuid and seq = $3::int - 1 and role = 'user')
       on conflict (session_id, seq) do nothing
       returning id`,
      [
        input.sessionId, input.venueId, input.seq, input.content, JSON.stringify(input.claims), input.guardrailFired, input.at,
        input.record.model, input.record.promptHash, input.record.providerCalls, input.record.regenerations, input.record.fellBack,
        input.record.inputTokens, input.record.outputTokens, input.record.cacheReadTokens, input.record.cacheWriteTokens, input.record.latencyMs,
      ],
    );
    return r.rowCount === 1;
  });
}

/** The session's turns in seq order; empty for a session of another venue or one that is gone. */
export async function readTurns(client: ClientBase, input: SessionRef): Promise<StoredTurn[]> {
  return await inVenue(client, input.venueId, "read", async () => {
    const r = await client.query(
      "select seq, role, content, claims, at from dastar_agent.turn where session_id = $1 and venue_id = $2 order by seq",
      [input.sessionId, input.venueId],
    );
    return r.rows.map((row): StoredTurn => ({
      seq: row.seq, role: row.role, content: row.content, claims: (row.claims as unknown[] | null) ?? null,
      at: row.at === null ? null : new Date(row.at).toISOString(),
    }));
  });
}

/** The encrypted confirm token of each reservation the session holds; empty for a session of another venue or one that is gone. */
export async function listSessionHolds(client: ClientBase, input: SessionRef): Promise<SessionHoldRow[]> {
  return await inVenue(client, input.venueId, "read", async () => {
    const r = await client.query(
      "select reservation_id, confirm_token_enc from dastar_agent.session_hold where session_id = $1 and venue_id = $2 order by created_at, reservation_id",
      [input.sessionId, input.venueId],
    );
    return r.rows.map((row): SessionHoldRow => ({ reservationId: row.reservation_id, tokenEnc: row.confirm_token_enc }));
  });
}

/** Keeps the encrypted confirm token of a reservation the session holds, replacing the token already kept for that pair. */
export async function putSessionHold(client: ClientBase, input: PutSessionHoldInput): Promise<void> {
  await inVenue(client, input.venueId, "write", async () => {
    await client.query(
      `insert into dastar_agent.session_hold (session_id, venue_id, reservation_id, confirm_token_enc) values ($1, $2, $3, $4)
       on conflict (session_id, reservation_id) do update set confirm_token_enc = excluded.confirm_token_enc`,
      [input.sessionId, input.venueId, input.reservationId, input.tokenEnc],
    );
  });
}

/** The venue's name and time zone; null when there is no such venue. */
export async function venueProfile(client: ClientBase, venueId: string): Promise<VenueProfile | null> {
  return await inVenue(client, venueId, "read", async () => {
    const r = await client.query("select id, name, timezone from dastar.venue where id = $1", [venueId]);
    return r.rowCount === 0 ? null : { id: r.rows[0].id, name: r.rows[0].name, timezone: r.rows[0].timezone };
  });
}

# ADR 5: Agents hold, humans confirm

Status: accepted. Design decision D6.

## Context

Dastar is meant to sit behind booking agents as well as ordinary applications. An agent should be able to hold a table on someone's behalf, but a booking becomes binding only when a person agrees to it. If the credential to confirm travels with every hold, any agent that can hold can also confirm, and the distinction is decorative.

## Decision

- A hold response carries a receipt and `hold_expires_at`, and never a confirm token.
- Confirmation requires either a key with the `confirm` capability, or a single-use confirm token. A token is minted only through a key with `confirm`, at `POST /v1/reservations/{id}/confirm-token`, and is meant to be handed to a human channel: a link, a button, a message.
- The token is stored hashed, is bound to one held reservation, is consumed by confirmation and discarded by cancellation or expiry (`DA013`, `token_requires_held`), and is compared in constant time. An absent reservation and a wrong, replaced, used, or cleared token get the same refusal and do the same work.

## Alternatives considered

- **A token in the hold response.** Convenient for one-step flows, but it hands every hold-only key a confirm credential.
- **Keys only.** Every confirming party would need an API key, which a guest following a link does not have.

## Consequences

- "Agents hold, humans confirm" holds for any hold-only key, not only for the reference agent: an agent's key without `confirm` cannot obtain a token by any route.
- Idempotency rows hold no secrets, because hold outcomes contain no token, so they purge uniformly after 24 hours.
- A host that wants one-step booking gives the caller a key with `confirm` and accepts what that means.
- The agent layer (M3) builds on these primitives; it is not part of the engine. The API tests cover token minting, use, and refusal (`apps/api/test/reservations.test.ts`); `SECURITY.md` states the one exception to the uniform refusal: a valid token for a hold that expired but has not yet been swept receives `hold_expired`.

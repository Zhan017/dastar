# ADR 8: The reference agent is an API client

Status: accepted. Design sections 5 and 10.6.

## Context

Dastar's claim about agents is that an agent holds and a person confirms, and that what an agent says about a reservation can be checked against what its own calls returned. A reference agent that reached the engine by a path no other agent has, calling its commands in process, holding a confirm credential, or keeping a record of its own calls, would show only that its authors' code could be trusted. It would prove nothing about the agents of builders who have to use the API.

The agent also needs state of its own, a conversation's turns and the confirm tokens it hands to people, and it needs a model provider's key, which the API has no use for.

## Decision

- **A separate app.** `apps/agent` is its own process with its own port. It serves `POST /demo/chat`, and the API gains no model code and no provider key.
- **Over HTTP, like any outside agent.** Its tools call the API through `@dastar/client` and `@dastar/agent-tools` with a key that has `read`, `hold`, and `cancel` and is scoped to its venue, and send its reference session's id in `Dastar-Session`. The API records those calls as it records an outside agent's, under the key's actor, with the same fields and receipts, and the matcher that audits outside agents checks every reply before the person sees it.
- **A second key, kept apart.** A key with `read` and `confirm` reads each hold and mints its confirm token. The token is sealed with a key of its own and kept in the agent's table, appears in the response to the person alone, and never enters the model's context, a log line, a stored turn, or a recorded call. The agent's tools have no way to confirm.
- **Its tables are written through the engine.** The agent writes its sessions, turns, and token rows through `@dastar/db` as `dastar_app`, the API's role, and the API's audit post refuses a reference session, so no key can replace the transcript the agent wrote.
- **Two boundary rules.** dependency-cruiser fails the build when `apps/agent` imports the API, the worker, the harness, or the MCP server (`agent-on-the-contract-and-engine`), and when anything outside it imports `apps/agent` (`nothing-imports-the-agent`).

## Alternatives considered

- **The agent inside the API process.** It would call the engine's commands directly, carry model code and a provider key in the process that serves every venue's keys, and need a recording path of its own for its calls, which is a path no outside agent has.
- **The agent in `@dastar/agent-tools`.** That package imports only the typed client, and a loop that writes its own tables through the engine would end that.
- **A narrower database role for the agent.** It would need policies on every table the audit reads, the session's calls and the reservations' statuses, and it would buy little: the process holds a confirm key anyway, and the invariants are in the database.

## Consequences

- One more process and port to run, and a start-up check of two keys; each start opens one empty audit session to confirm the key's id.
- The API has no model code. A change of provider or model is a change to the agent, and the provider's key is never in the API's environment.
- The agent's database role is the API's. A bug in the agent is contained to the venue it declares by row-level security, which is boundary B: the agent declares the one venue it is configured for, and the database cannot tell that from a lie.
- Every conversation shares the agent key's cap of live holds, because the actor is the key.
- The boundary rules are tested in `apps/agent/test/boundaries.test.ts`, and the turn, the guardrail, and the token handling in `apps/agent/test/turn.test.ts`, `guardrail.test.ts`, and `holds.test.ts`.

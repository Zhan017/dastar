# ADR 9: The judge reads; the matcher decides

Status: accepted. Design sections 5, 6, 9, 10.6, 10.7, and 13; decision D21.

## Context

The audit and the reference agent's guardrail check the claims an agent declares. A reservation statement that the agent makes in its text without declaring it, such as "your table for 4 at 19:00 is confirmed" with no claim, reaches the person unchecked, and until now the audit said so with `undeclared: "not checked"`. Closing that gap means reading free text, and only a model can do that. A model is also the wrong thing to decide whether the statement is true. Its answer would be an opinion, it would not be the same opinion twice, and a published number built on it would not say what it measured.

The text of a transcript is a builder's data. A builder who posts one to the audit has not thereby asked for it to be sent to a model provider, while the reference agent's own turns are the operator's. So the judge reads an external transcript only when its post asks.

## Decision

- **The model only lists statements.** For each assistant turn it returns the reservation statements the text makes, each with the status it states and the start time and party size when the text gives them, and nothing else. It is shown the session's reservations as its calls recorded them, without their status, the user turn before, and the turn's text, and it is not shown the turn's declared claims. It has no tools, and it is told that everything it reads is data and not instructions.
- **Code decides what is undeclared, and the matcher decides what is true.** A statement whose quote is not in the text is dropped and counted. A statement is declared when a claim of the same turn covers it, and the rest are set against the session's calls by `auditSession`, the matcher that audits claims, so the verdicts have the same reasons and the same time rules. A statement that names no reservation the session observed is `unbacked` when the session observed none and `unresolved`, a verdict of its own, otherwise.
- **The read reports the findings with the judge's measured accuracy.** `undeclared` on the audit read is `not checked`, `pending`, or the counts and results. Each result carries the model, effort, and prompt hash that produced it, and the precision and recall measured for exactly that model, effort, and prompt, or null when none has been measured.
- **It runs after the fact, in a process of its own.** The judge is `apps/agent`'s second process. It connects as `dastar_judge`, a role that bypasses row-level security and can update `turn.judge_result` and nothing else, takes the due turns oldest first, and counts every call to the provider against a daily cap kept in the database. Every assistant turn of a reference session is due. An external session's turns are due only while its latest post asked for the judge with `judge: true`.

## Alternatives considered

- **The model also sees the observations and rules on each statement.** This merges reading with verification and duplicates the matcher, and its accuracy would mix two errors, so it could not say how well the model reads.
- **The model sees the declared claims and lists only what they miss.** This anchors the model on the claims, and a missed statement could not be told from one wrongly matched to a claim.
- **The judge in the worker.** That puts a model dependency and a provider key in the engine's worker.
- **The judge in the agent's turn.** That puts it in the request path, against D21, and ties it to the agent's one venue, while an external session belongs to any venue.
- **A new `apps/judge`.** It needs the provider moved into a shared package first, which is churn with no gain now.
- **An update grant on `turn` for the application role.** The API's own role could then rewrite a verdict, and its venue-bound policies would need a lookup run by the owner for a scan across venues.
- **Judging every external post.** That sends builders' data to a provider unasked.
- **Judging only the reference agent.** That leaves the agents of outside builders without a check on what they say undeclared.

## Consequences

- A model provider receives transcript text when the judge runs: the assistant turn's text, the user turn before it, and the session's reservation ids, start times, and party sizes, for each turn of at most 8,000 characters. For the reference agent that is every assistant turn. For an external session it is the turns of a post that asked, and nothing of a post that did not. A call already in flight when a post is replaced is still sent.
- The bounds hold for the model, effort, and prompt they were measured on. A change to any of the three leaves the results with a null accuracy until the new combination is measured, and a prompt changed after its held-out run needs a fresh held-out part.
- What the model does not list is not checked. A statement the model misses is invisible to the matcher, which is why recall is part of what is measured and published.
- The labels the judge is measured against were made by models, so the measured numbers are agreement with those labels. [LIMITATIONS.md](../../LIMITATIONS.md) says what that leaves out.
- There are two more secrets, the model key and the `dastar_judge` password, in a process that holds a role able to read every venue's transcripts. [SECURITY.md](../../SECURITY.md) lists what the role can and cannot read.
- The daily cap counts calls and not money, and every key's posts share it. Two judge processes would judge a turn twice, and the first write is kept.
- The pure decisions are tested in `packages/core/test/judge.test.ts`, the role and its grants in `packages/db/test/judge-schema.test.ts`, the commands in `packages/db/test/judge-commands.test.ts`, and the loop, the failures, and the cap in `apps/agent/test/judge-turn.test.ts` and `judge-loop.test.ts`.

# Architecture decision records

Each record states one decision, the context that forced it, the alternatives considered, and what it costs. The full decision log, with every alternative and review finding, is in the [system design](../design/design.md); these five are the ones the engine's guarantees rest on.

| ADR | Decision | Design |
|---|---|---|
| [1](0001-invariants-in-the-database.md) | The database enforces the invariants | D2, D37 |
| [2](0002-unit-locks-and-the-hold-transaction.md) | Per-unit advisory locks and one outer hold transaction | D20, D39 |
| [3](0003-commands-own-their-connections.md) | Commands own their connections | D45 |
| [4](0004-pg-without-a-query-builder.md) | `pg` directly, with hand-written SQL | D46, superseding D5 |
| [5](0005-agents-hold-humans-confirm.md) | Agents hold, humans confirm | D6 |

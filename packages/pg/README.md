# @affordance/pg

Postgres implementation of Affordance's domain storage and atomic execution
interfaces. The application owns business tables; this package stores case
references, metadata, journal evidence, correlations, and delivery bookkeeping.

```ts
import { createEngine } from '@affordance/core'
import { bootstrap, createPgStorage } from '@affordance/pg'

await bootstrap(pool)
const storage = createPgStorage({ db: { pool } })
const bound = storage.bindCase(purchase, {
  load: (q, id) => purchases(q).loadCaseState(id),
  protect: (tx, id) => purchases(tx).lock(id),
  repositories: (tx, id) => purchaseRepositories(tx, id),
})
const engine = createEngine({ storage, caseTypes: [bound] })
const current = await engine.attachCase('house-purchase', { reference: purchaseId })
```

`bindCase` checks repository types against the definition. Its loader runs inside
a consistent read transaction or the active execution transaction. Every domain
writer must follow the same protection rule, including writes to related rows.
Case executions serialize across scope keys and commit all writes and evidence
atomically. Network work belongs outside handlers.

The app owns connection lifetime. Supply `{ pool }` or a dedicated `{ client }`.
`withTransaction` binds application writes to one connection and rejects use of
the transaction after its callback. To create and attach together, call
`storage.attachCase(tx, bound, reference)` inside that callback.

A lost commit acknowledgment raises `ExecutionIndeterminateError` during execution.
`storage.reconcileExecution(caseId, executionId)` fences against an unfinished
operation and returns `completed` or `not-committed`; database outages still throw.
Application-owned `withTransaction` calls expose `CommitOutcomeUnknownError`.

Schema bootstrap is explicit and rejects incompatible old framework tables. It
does not reset databases or convert old JSONB cases. `deleteCase` deletes framework
records only; domain data remains owned by the application.

See [storage adapters](https://github.com/mochicodecom/affordance/blob/main/docs/storage.md)
for interfaces, atomicity, journal serialization, and domain evolution.

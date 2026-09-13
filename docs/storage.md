# Domain storage and atomic execution

`@affordance/core` owns definitions, validation, guard evaluation, and execution
evidence. The application owns business records. An adapter assembles those
records into Case State and provides exclusive, atomic execution.

Core has no SQL, Postgres, ORM, or database transaction types. Other adapters can
use the same interfaces through their own database or ORM. The Postgres types in
the examples below belong to `@affordance/pg` and the application.

## Define domain operations

```ts
import { actor, caseType, repositories, stepsOf } from '@affordance/core'
import { z } from 'zod'

const State = z.object({ approved: z.boolean() })
interface Repos { approve(): Promise<void> }
const approvalStep = stepsOf(State, actor<{ reviewer: boolean }>(), repositories<Repos>())
const approval = caseType({
  name: 'approval',
  state: State,
  steps: [approvalStep({
    name: 'approve',
    requires: { outstanding: state => !state.approved },
    permits: { reviewer: (_state, ctx) => ctx.actor.reviewer },
    handler: async ctx => { await ctx.repos.approve() },
  })],
})
```

The handler returns `Promise<void>`. It can inspect `ctx.state`, `ctx.actor`,
`ctx.input`, and a scoped step's `ctx.scope`/`ctx.scopeKey`. Writes happen through
`ctx.repos`. Mutating `ctx.state` does not save it. The engine reloads domain state
after the handler and validates that result before committing.

## Bind Postgres persistence

Assume the application already owns `approvals(id text primary key, approved
boolean not null)`:

```ts
import { bootstrap, createPgStorage } from '@affordance/pg'
import { createEngine } from '@affordance/core'

await bootstrap(pool)
const storage = createPgStorage({ db: { pool } })
const bound = storage.bindCase(approval, {
  load: async (q, reference) => {
    const { rows } = await q.query<{ approved: boolean }>(
      'select approved from approvals where id = $1', [reference],
    )
    if (!rows[0]) throw new Error('approval does not exist')
    return rows[0]
  },
  protect: async (tx, reference) => {
    const { rows } = await tx.query(
      'select id from approvals where id = $1 for update', [reference],
    )
    if (!rows[0]) throw new Error('approval does not exist')
  },
  repositories: (tx, reference) => ({
    approve: async () => {
      await tx.query('update approvals set approved = true where id = $1', [reference])
    },
  }),
})
const engine = createEngine({ storage, caseTypes: [bound] })
const current = await engine.attachCase('approval', { reference: approvalId })
await engine.execute(current.id, 'approve', { actor: { reviewer: true } })
```

`bindCase` checks the repository context against the definition's required type.
Bindings belong to one storage instance; the engine rejects a binding from a
different instance. The adapter rejects duplicate type names.

`attachCase` validates the protected domain state and atomically creates case
metadata. Reattaching the same `(case type, reference)` returns the existing
case. The reference is an application record identity; it is not a second state
copy. Missing domain records and unreadable state fail loudly.

Create an application record and attach its case in one transaction when needed:

```ts
import { withTransaction } from '@affordance/pg'

const current = await withTransaction({ pool }, async tx => {
  await tx.query('insert into approvals (id, approved) values ($1, false)', [approvalId])
  return storage.attachCase(tx, bound, approvalId)
})
```

Use the supplied `tx` directly. Calling `engine.attachCase` or opening another
framework transaction from this callback would acquire another operation rather
than join this transaction. Retained transaction handles reject queries after
their callback finishes.

## Concurrency contract

The Postgres execution adapter first locks the framework case row, then calls
`protect`, then loads state. Protection must cover all facts used by guards and
handlers, including related records. Every cooperating external writer must use
the same domain protocol. For a purchase parent lock, this includes writers that
insert, update, or delete buyers and wires. Locking a child alone is insufficient.
Define a consistent order for operations involving several cases or parents.

Two executions on one case serialize, including executions with different scope
keys. There is no durable claim, heartbeat, or automatic handler retry. Postgres
waits on the row lock; the adapter does not promise FIFO scheduling. Other
adapters must provide equivalent exclusion and atomicity or reject this contract.

Ordinary reads use a short repeatable-read transaction so multiple repository
queries observe one consistent snapshot. Application loaders should return
collections in deterministic order. Listing pages case metadata newest first,
then loads complete domain state through the same binding. It defaults to active
cases, registered types, and 100 rows (maximum 1000). One unreadable case fails
the page. Cursor filters cannot change between pages.

## Atomic interface

Adapters implement `EngineStorage` from `@affordance/core/storage`, including:

```ts
interface AtomicCasePort<R> {
  withCase<T>(
    caseId: string,
    executionId: string,
    run: (session: AtomicCaseSession<R>) => Promise<T>,
  ): Promise<T>
}
```

The session exposes `repos`, `loadCase`, and `persistCompletion`. The latter stages
metadata, correlations, and evidence in the same operation; it does not commit
independently. The adapter invokes the callback once and resolves only after a
confirmed commit. A handler error, invalid resulting state, or failed evidence
write rolls back the domain operation. All repositories must participate in this
same atomicity; independent CRUD implementations cannot substitute for it.

Protected operations explicitly use Read Committed isolation so a load after a
waited lock observes the newly committed domain rows. Ordinary aggregate reads
use a short Repeatable Read, read-only transaction. See the
[Postgres isolation rules](https://www.postgresql.org/docs/17/transaction-iso.html).

## Unknown commit outcomes

Lost COMMIT acknowledgments do not prove rollback. Affirmative Postgres
constraint, serialization, and deadlock errors retain their SQLSTATE and report
known rollback; callbacks are never automatically retried. The Postgres execution
adapter throws `ExecutionIndeterminateError` with the case and execution IDs.
It writes no false failure evidence and does not replay the handler. To determine
what happened:

```ts
const outcome = await storage.reconcileExecution(error.caseId, error.executionId)
// 'completed' or 'not-committed'; database unavailability still throws.
```

Reconciliation first locks the same case row, waiting for any original operation
to finish, then checks completion evidence. Read the journal for that execution
when it completed. A new attempt after confirmed non-commit reloads current state
and reevaluates its guard. Request-level deduplication and external effect recovery
remain the application's responsibility. `withTransaction` exposes
`CommitOutcomeUnknownError` for application-owned transactions.
If Postgres acknowledges `COMMIT` with a `ROLLBACK` command after a caught SQL
error, `withTransaction` throws `TransactionRolledBackError` instead of returning
the callback's result. Only a `COMMIT` acknowledgment reports success.

## Evidence and serialization

A successful execution writes `started` and `completed` together with domain
changes. `started` contains a copy of the state, actor, validated input, guard,
and evaluation time taken before application code runs. `completed` contains a
JSON Patch delta and dormancy. `startedAt` replaces the old claim timestamp.
These are historical records, not a reconstruct-on-read state store. The engine
journals committed operations; refused or rolled-back operations have no journal
entries. The `failed` journal type is reserved for explicit, confirmed rollback
diagnostics by an adapter.

Snapshot serialization preserves Date, Set, bigint, null, undefined, and absent
properties through the versioned `{ version: 1, json, meta? }` format. Adapters
encode/decode journal state, actors, and inputs with core's serialization helpers.
Deltas compare encoded documents and are stored directly. Unsupported values
fail before completion commits. Domain storage decides how its own columns map
to runtime state; it does not need to store the serialization envelope.

`replayGuard(definition, startedEntry)` validates the historical snapshot and
compares today's guard with the recorded evaluation. External edits are visible
on the next case read but do not automatically create framework evidence or
advance `seq`; that counter counts framework executions only.

## External work and schema changes

Network calls must run outside atomic handlers. Adopters can invoke short guarded
operations before/after calls managed by their existing orchestration. Affordance
does not provide an outbox, worker, cancellation manager, or long-running claim.
Separate operations do not imply atomicity across an external API call. Ingestion
still settles delivery bookkeeping separately from the case execution.

This release is a breaking replacement. The Postgres adapter requires a fresh
framework schema and never resets existing databases automatically. There is no
JSONB current-state adapter, full-state-return handler, or `engine.migrate`.
Applications manage their own domain schema/data migrations. See
[domain evolution](migration.md).

# @affordance/pg

Postgres storage for Case references, optional observed diffs, launched execution
ownership/status, correlations and event delivery bookkeeping. The application
owns domain tables and all business transactions.

```ts
import { createEngine, createBackgroundRuntime } from '@affordance/core'
import { bootstrap, createPgStorage } from '@affordance/pg'

await bootstrap(pool) // Fresh framework schema; does not migrate or reset old data.
const storage = createPgStorage({ db: { pool } })
const binding = storage.bindCase(definition, {
  load: (q, reference) => purchases(q).loadCaseState(reference),
})
const runtime = createBackgroundRuntime()
const engine = createEngine({
  storage, caseTypes: [binding], launch: { runtime, leaseMs: 60_000 },
})
const current = await engine.attachCase(definition.name, { reference: purchaseId })
```

Bindings supply only an authoritative loader. Reads use a short consistent
snapshot. No framework transaction or connection remains open during a handler's
business work. Handlers close over the application's services and may use
`withTransaction` themselves. To create and attach in one application transaction,
call `storage.attachCase(tx, binding, reference)`.

Launch claims use a partial unique index on Case identity. Running and unresolved
records retain ownership; expiration never removes that index entry. Framework
transitions lock the selected execution row, then check `clock_timestamp()` and
identity. Completion and resolution release only the selected execution's block.
These transactions do not include domain writes. Ordinary runs and other writers
are outside this coordination protocol.

Journal writes use execution identity for deduplication. Core passes the remaining
journal budget to the adapter, including connection acquisition. Queued attempts
skip their write after the budget expires. Journal SQL uses a transaction-local
`statement_timeout`: a blocked write rolls back and releases its connection so
launch finalization can proceed, including with a one-connection pool or dedicated
client. The previous connection timeout is restored after the transaction.

A write committed near the deadline may still appear after core reports timeout.
It never changes launch status. A journal failure can coexist with completed
status; a lost status acknowledgment remains uncertain until lookup/reconciliation.
Neither implies that business code can be replayed safely.

The app owns pool/client lifetime. `withTransaction` exposes
`CommitOutcomeUnknownError` when a commit acknowledgment is lost and
`TransactionRolledBackError` when PostgreSQL acknowledges a rollback. The app must
reconcile its own domain transaction. `registerCorrelation(q, registration)` lets
an app explicitly include routing metadata in its own transaction.

This breaking beta requires a fresh v6 framework schema. Bootstrap rejects older
schemas and never drops data. No journal or lease data conversion is supplied.
`deleteCase` removes framework records only. See the
[storage contract](https://github.com/mochicodecom/affordance/blob/main/docs/storage.md).

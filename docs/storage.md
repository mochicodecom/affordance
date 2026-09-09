# Storage adapters

`@affordance/core` owns case definitions, guards, validation, execution decisions,
ingestion policy, and migration orchestration. `@affordance/pg` implements their
persistence using Postgres. Apps inject one coordinated `EngineStorage<TCommit>`.

```ts
import { createEngine } from '@affordance/core'
import { bootstrap, createPgStorage } from '@affordance/pg'

await bootstrap(pool)
const storage = createPgStorage({ db: { pool } })
const engine = createEngine({ storage, caseTypes: [purchase] })
```

## Implementing an adapter

Import `EngineStorage`, its repository interfaces, `LifecyclePort`, and
`LifecycleTx` from `@affordance/core/storage`. The same entry point exports
`projectEntry` for consistent journal defaults and `mintId` for framework IDs.

| Interface | Responsibility |
| --- | --- |
| `cases` | Create validated state, fetch raw records, list filtered pages. |
| `execution` | Serialize case operations, persist claims and commit effects, maintain claim expiry and attempts. |
| `journal` | Read append-only evidence in ordinal order with filters. |
| `correlations` | Register/replace by `(system, externalId)`, preserving registration identity; look up and list mappings. |
| `deliveries` | Atomically acquire new or reopenable deliveries, settle outcomes, read dead letters. |
| `migrations` | Page through unmarked cases and inspect completed migration markers. |

Core resolves and validates records after loading them. During a claim that
validation happens inside `execution.withCase`; adapters do not receive or own
the case-type registry. Migration's temporary step definition follows the same
core path.

`withCase(caseId, callback)` must serialize the addressed case, invoke the
callback once, and atomically commit all its writes or roll them all back when
it throws. Missing cases throw `CaseNotFoundError`. An optimistic implementation
must report a serialization conflict rather than replay arbitrary callbacks.

The claim operation includes guard re-evaluation, takeover evidence, claim
creation and the claimed journal entry. The handler then runs outside that
operation. The commit operation verifies ownership and atomically writes state,
sequence, dormancy, ordered commit effects, completed evidence and claim removal.
A displaced handler must fail; an expired claim that still belongs to the same
execution may commit. Heartbeats and expiry use storage's authoritative clock.
Core's `now` supplies guard evaluation instants; stored timestamps are assigned
by the adapter.

All repositories in an adapter must participate in these guarantees. Independent
CRUD implementations alone cannot provide atomic state and correlation commits.
Provider calls remain outside storage transactions and must tolerate retries.
Delivery settlement remains separate from case execution, preserving the existing
crash/recovery behavior; this interface does not promise exactly-once external effects.

## Application commit contexts

The Postgres default context is its `Transaction`. Apps can expose repositories
with a stable interface instead:

```ts
import { actor, commitContext, stepsOf } from '@affordance/core'
import { createPgStorage } from '@affordance/pg'

type Repositories = {
  payments: { record(caseId: string, amount: number): Promise<void> }
}
const storage = createPgStorage({
  db: { pool },
  commitContext: tx => ({ payments: createPaymentRepository(tx) }),
})
const step = stepsOf(PurchaseState, actor<PurchaseActor>(), commitContext<Repositories>())
const recordPayment = step({
  name: 'record-payment',
  handler: async (state, ctx) => {
    ctx.onCommit(async ({ payments }) => {
      await payments.record(ctx.caseId, state.amount)
    })
    return state
  },
})
```

The factory must bind repositories to the supplied transaction. The context type
is retained through scoped handlers, steps, case definitions, and engine binding;
a handler requiring different repositories fails type checking. Unspecified
contexts default to `unknown`. `ctx.onCommit` and `ctx.correlate` share one ordered
queue, rebuilt on every attempt. A failed commit rolls back both kinds of effects.

## Case listing

`engine.listCases({ caseTypeName?, includeEnded?, limit?, cursor? })` returns
`{ cases, nextCursor }`. It lists only registered case types, newest first with a
stable tie breaker. Dormant cases are excluded by default. The page size defaults
to 100, with an integer maximum of 1000. Cursors belong to the adapter; reuse the
same filters on continuation. Pagination is a live traversal, not a frozen snapshot.

Each result is validated like `engine.case(id)`, including schema defaults.
Unreadable state fails the page; the engine does not silently drop it. Validation
uses the fetched records without per-case reloads. These reads expose state;
the host owns access control and any business-specific search or projection.
The reference console follows every page and derives its domain-specific labels
in the UI.

## Migrating existing applications

- Replace `createEngine({ db, caseTypes })` with
  `createEngine({ storage: createPgStorage({ db }), caseTypes })`.
- Import `bootstrap`, `DatabaseAccess`, `Queryable`, `PoolLike`, `Transaction`,
  `queryableOf`, and schema/table constants from `@affordance/pg`.
- Type SQL commit callbacks with `commitContext<Transaction>()`, or introduce
  transaction-bound application repositories as above.
- Pass storage to `hasMigrated(storage, caseId, name)` instead of a query handle.
- Use `engine.listCases()` for framework case listings. Demo deletion belongs to
  the Postgres administrative helper, outside the execution interface.

## Verification

Core has no Postgres dependency. An AST-based test restricts its imports and
rejects SQL persistence statements and query calls. A shared contract suite runs
against a serialized memory adapter with rollback and the Postgres adapter. It
covers listing/validation, concurrent claims, takeover, commit rollback and order,
retry discard, delivery deduplication/reopening, and migration continuation.
Postgres-specific suites cover connection mechanics and timestamp-precise paging.
The release smoke test installs the built packages outside the workspace to check
exports, declaration dependencies, and actual Postgres/HTTP execution.

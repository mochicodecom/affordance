# Introduction to Affordance

Updated: 2026-09-06

## The problem: too much process structure

We often reach for a finite state machine (FSM) or workflow before asking how
much ordering the problem actually needs. A house purchase has buyers,
verification, agreements, and funding progressing independently. Encoding every
combination as a process position makes exceptions and changing requirements
expensive to model. A predefined graph also needs a policy for in-flight cases
when that graph changes.

Affordance starts with less structure: **store the facts, define the steps, and
compute what each actor can do now.** Each step declares the state it needs and
the state it produces. Steps chain through those facts. An FSM still fits a
small, stable set of transitions; Affordance fits work whose order emerges from
changing conditions and several independent concerns.

## The mental model: an object with guarded behavior

A **case** is a persisted object representing one business matter. Its **case
type** defines a state schema and a set of steps, including their conditions,
scope, and permissions. An **affordance** is one of those steps currently
available to a particular actor on that case.

| Term | Meaning in code |
| --- | --- |
| Case state | The current document: buyers, commitments, reports, outcomes. |
| Step | An independently defined guard plus an async handler. |
| Guard / condition | Named predicates: `requires` checks the case; `permits` checks the actor. All must pass. |
| Actor | The person, external system, or agent asking or executing. |
| Scope | A collection element a step binds to, such as one buyer. |
| Handler | Receives current state and execution context; returns the next state. |
| Execution / claim | One recorded run, protected by an exclusive, expiring claim on the case. |
| Journal / delta | The append-only execution record and each committed change as JSON Patch. |

```mermaid
flowchart LR
  State["Case state"] --> Evaluate["Evaluate step guards"]
  Actor["Actor + scope bindings"] --> Evaluate
  Evaluate --> Available["Affordances"]
  Evaluate --> Blocked["Blocked steps + reasons"]
  Available --> Caller["Caller chooses and executes"]
  Caller --> State
  Caller --> Journal["Journal"]
```

Availability does not start execution. A caller chooses a step; the engine
checks it again before running it. An empty affordance list means this actor
has nothing available now. Completion is a domain fact such as `closedAt`.

## Define a small case

This simplified purchase needs commitments from every buyer and a title report
before it can close. The TypeScript snippets below build one example using the
workspace's `@affordance/core`, `@affordance/pg`, Zod, and `pg` dependencies.

```ts
import {
  actor,
  caseType,
  createEngine,
  stepsOf,
} from '@affordance/core'
import { bootstrap, createPgStorage } from '@affordance/pg'
import pg from 'pg'
import { z } from 'zod'

const PurchaseState = z.object({
  buyers: z.array(
    z.object({
      id: z.string(),
      committedAmount: z.number().positive().nullable(),
    }),
  ),
  titleReportId: z.string().nullable(),
  closedAt: z.string().nullable(),
})

type PurchaseActor = { id: string; role: 'buyer' | 'officer' }
const purchaseStep = stepsOf(PurchaseState, actor<PurchaseActor>())
```

`stepsOf` infers state, input, and scope types for each step. The schema stores
independent facts; there is no field identifying a position in a process.

### Scope and permissions belong to the step

`commit-funds` binds to each buyer. Alice can commit her own amount while Bob
has a separate affordance for his.

```ts
const commitFunds = purchaseStep({
  name: 'commit-funds',
  scope: { select: (s) => s.buyers, key: (buyer) => buyer.id },
  requires: {
    purchaseOpen: (s) => s.closedAt === null,
    notCommitted: (_s, ctx) => ctx.scope.committedAmount === null,
  },
  permits: {
    isThisBuyer: (_s, ctx) =>
      ctx.actor?.role === 'buyer' && ctx.actor.id === ctx.scope.id,
  },
  input: z.object({ amount: z.number().positive() }),
  handler: async (s, ctx) => ({
    ...s,
    buyers: s.buyers.map((buyer) =>
      buyer.id === ctx.scopeKey
        ? { ...buyer, committedAmount: ctx.input.amount }
        : buyer,
    ),
  }),
})
```

The affordance's identity is `(step, scopeKey)`. `requires` explains whether the
work is possible; `permits` explains whether this actor may do it. The app
authenticates callers and supplies their actor identity.

### Connect steps through state

An officer can record the title report independently of the buyers' commitments.
Closing depends on both facts, without naming either preceding step.

```ts
const recordTitleReport = purchaseStep({
  name: 'record-title-report',
  requires: {
    purchaseOpen: (s) => s.closedAt === null,
    reportMissing: (s) => s.titleReportId === null,
  },
  permits: { isOfficer: (_s, ctx) => ctx.actor?.role === 'officer' },
  input: z.object({ reportId: z.string().min(1) }),
  handler: async (s, ctx) => ({ ...s, titleReportId: ctx.input.reportId }),
})

const closePurchase = purchaseStep({
  name: 'close-purchase',
  requires: {
    purchaseOpen: (s) => s.closedAt === null,
    allCommitted: (s) => ({
      ok:
        s.buyers.length > 0 &&
        s.buyers.every((b) => b.committedAmount !== null),
      reason: 'Every buyer must commit funds before closing',
    }),
    titleChecked: (s) => s.titleReportId !== null,
  },
  permits: { isOfficer: (_s, ctx) => ctx.actor?.role === 'officer' },
  handler: async (s) => ({ ...s, closedAt: new Date().toISOString() }),
})

const purchase = caseType({
  name: 'tutorial-purchase',
  state: PurchaseState,
  steps: [commitFunds, recordTitleReport, closePurchase],
})
```

Conditions are pure, synchronous predicates: no network calls, mutations, or
clock reads. External facts must first enter state through a handler. Handlers
can perform I/O and read the clock, as `closePurchase` does here.

These arrows describe data dependencies, not a graph supplied to the engine:

```mermaid
flowchart LR
  Commit["commit-funds, per buyer"] --> Amounts["buyers[].committedAmount"]
  Record["record-title-report"] --> Report["titleReportId"]
  Amounts --> Guard["close-purchase guard"]
  Report --> Guard
  Guard --> Close["Officer can close"]
```

The `steps` array controls listing order only. Adding an exception means adding
another guarded step. Deploying new definitions changes what existing cases can
do, provided their stored state still satisfies the schema. Handle older state
shapes deliberately; incompatible changes may need a [migration](../migration.md).

## Ask, execute, ask again

Start the repository's local Postgres with `pnpm db:up` after `pnpm install`
(Node 22.12+, pnpm, and Docker required). This setup uses its local credentials:

```ts
const pool = new pg.Pool({
  connectionString: 'postgres://postgres:postgres@localhost:5432/affordance',
})
await bootstrap(pool)
const engine = createEngine({ storage: createPgStorage({ db: { pool } }), caseTypes: [purchase] })
const { id: caseId } = await engine.createCase('tutorial-purchase', {
  buyers: [{ id: 'alice', committedAmount: null }],
  titleReportId: null,
  closedAt: null,
})
const alice: PurchaseActor = { id: 'alice', role: 'buyer' }
const officer: PurchaseActor = { id: 'officer', role: 'officer' }

const { affordances } = await engine.affordances(caseId, alice)
// [{ step: 'commit-funds', scopeKey: 'alice' }]

const { blocked } = await engine.affordances(caseId, officer)
const closing = blocked.find((step) => step.step === 'close-purchase')
console.log(closing?.possible, closing?.permitted) // false, true
console.log(closing?.unmet.map((condition) => condition.name))
// ['allCommitted', 'titleChecked']

await engine.execute(caseId, 'commit-funds', {
  actor: alice,
  scopeKey: 'alice',
  input: { amount: 100_000 },
})
await engine.execute(caseId, 'record-title-report', {
  actor: officer,
  input: { reportId: 'title-123' },
})
const next = await engine.affordances(caseId, officer)
// next.affordances: [{ step: 'close-purchase' }]
await engine.execute(caseId, 'close-purchase', { actor: officer })
```

The first two executions can happen in either order. They make closing
available by changing state; neither handler schedules it. Several affordances
can coexist, but **only one execution holds a case's claim at a time**, even
across different scope keys. Independent progress does not require concurrent
writes to the same case document.

## Execution: a “pseudo-transaction” around an async handler

An execution groups the work into **claim → run → commit**. Two short database
transactions protect an async handler that runs between them:

```mermaid
sequenceDiagram
  participant Engine
  participant DB as Postgres
  participant Handler
  participant Service as External service
  Engine->>DB: Begin transaction and lock case
  Engine->>DB: Validate input and recheck guard
  Engine->>DB: Write claim and journal, then commit
  Engine->>Handler: Run with state and execution context
  Note over Engine,DB: Claim heartbeats without holding a transaction
  Handler->>Service: Await I/O with executionId as deduplication key
  Service-->>Handler: Result
  Handler-->>Engine: Return next state
  Engine->>DB: Begin transaction and verify claim ownership
  Engine->>DB: Write state, app writes, and journal
  Engine->>DB: Release claim and commit
```

For example, this optional step obtains a report through an application-supplied
service. Register `obtainTitleReport(yourTitleService)` in the case type to use it:

```ts
type TitleService = {
  obtain(request: {
    caseId: string
    idempotencyKey: string
  }): Promise<{ id: string }>
}

const obtainTitleReport = (service: TitleService) =>
  purchaseStep({
    name: 'obtain-title-report',
    requires: {
      purchaseOpen: (s) => s.closedAt === null,
      reportMissing: (s) => s.titleReportId === null,
    },
    permits: { isOfficer: (_s, ctx) => ctx.actor?.role === 'officer' },
    handler: async (s, ctx) => {
      const report = await service.obtain({
        caseId: ctx.caseId,
        idempotencyKey: ctx.executionId,
      })
      return { ...s, titleReportId: report.id }
    },
  })
```

The state, journal completion entry, and any app database writes registered with
`ctx.onCommit(tx => ...)` commit atomically. An external service call cannot be
rolled back by Postgres. Handlers may retry with the same `executionId`, so the
service must honor that key to avoid repeating the effect. A new execute call
gets a new ID; deduplication across separate executions needs an app-level key.

A crashed process stops heartbeating its claim. A later execution can take over
after expiry; the old handler cannot commit after losing ownership. There is no
durable suspension of JavaScript. For work that takes hours, commit the request
and its external identifier, then let a later event execute a step that records
the result. `ctx.correlate` and `engine.ingest` provide that connection.

## Every execution leaves evidence

The journal records what happened and why it was allowed, using the evidence at
execution time:

| Entry | Evidence |
| --- | --- |
| `claimed` | Step, scope, actor, validated input, evaluation time, guard results, and the state those guards read. |
| `completed` | The committed state delta as JSON Patch. |
| `attempt-failed` / `failed` | Attempt number and error, including retries that precede success. |
| `expired` | Abandonment of a claim, recorded when a later execution takes over. |

```ts
const journal = await engine.journal(caseId)
const aliceJournal = await engine.journal(caseId, { scopeKey: 'alice' })
// aliceJournal contains the claimed and completed entries for her commitment.
await pool.end() // Close the pool when this example finishes.
```

This records claimed executions, not every API call: reads and refusals before a
claim write no journal entry. Current state is stored directly; reading a case
does not replay its journal or rerun old handlers.

## Go further

- [Reference app](../../packages/reference-app/README.md): a full purchase with
  multiple buyers, provider events, and exception handling.
- [Codebase map](reference/codebase-map.md): where the public APIs and their
  implementations live.
- [Vocabulary](../../CONTEXT.md), [architecture](../architecture.md), and
  [HTTP contract](../affordance-contract.md): precise definitions and deeper detail.

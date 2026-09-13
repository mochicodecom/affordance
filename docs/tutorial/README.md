# A house purchase built from current facts

Affordance computes what work is possible for a case and actor. A purchase can
have buyers awaiting verification, signatures, or funding at the same time.
Each step declares its conditions independently. The application decides which
available step to execute; the framework does not prescribe an ordering.

## Run the reference application

From the repository root:

```sh
pnpm db:up
pnpm build
pnpm --filter @affordance/reference-app ui:build
pnpm --filter @affordance/reference-app serve
```

The console is at `http://localhost:8787/`. Create a purchase and choose an actor.
The reference application persists purchases, buyers, and wires in its own
relational tables. Framework records contain a reference to the purchase.

Existing framework schemas from before domain-backed execution are incompatible.
Use a fresh database through `DATABASE_URL`; bootstrap does not reset an existing
schema. The application seeds no cases.

## Define a step

The reference app's schema describes the state its loader assembles. Its typed
step factory supplies that state, its actor, and its repository interface:

```ts
const purchaseStep = stepsOf(
  PurchaseState,
  actor<PurchaseActor>(),
  repositories<PurchaseRepositories>(),
)

const recordCommitment = purchaseStep({
  name: 'record-commitment',
  scope: {
    select: state => state.buyers.filter(buyer => buyer.committed === null),
    key: buyer => buyer.id,
  },
  requires: { open: state => state.purchase.closedAt === null },
  permits: { ownCommitment: (_state, ctx) => ctx.actor.id === ctx.scope.id },
  input: z.object({ amount: z.number().positive() }),
  handler: async ctx => {
    await ctx.repos.commit(ctx.scopeKey, ctx.input.amount)
  },
})
```

`requires` checks domain facts; `permits` checks actor authority. Named conditions
provide reasons when a step is blocked. Conditions are pure and synchronous.
Scope selects one collection element using a stable key. The handler performs a
targeted domain update instead of returning a replacement purchase document.

## Bind persistence

The application supplies three Postgres operations:

```ts
const storage = createPgStorage({ db: { pool } })
const bound = storage.bindCase(purchase, {
  load: loadPurchase,
  protect: protectPurchase,
  repositories: purchaseRepositories,
})
const engine = createEngine({ storage, caseTypes: [bound] })
const current = await engine.attachCase('house-purchase', { reference: purchaseId })
```

`loadPurchase` assembles the purchase, buyers, and wires from domain tables.
`protectPurchase` locks the purchase parent row. Every cooperating writer uses
that same parent lock, including code outside Affordance that updates a buyer.
`purchaseRepositories` binds targeted writes to the supplied transaction.

Core itself knows no SQL or ORM. An adapter for another persistence technology
provides the same loading and atomic execution behavior with its own mechanics.
See [the full storage guide](../storage.md) for a complete binding example.

## Ask and act

```ts
const offered = await engine.affordances(current.id, buyerActor)
await engine.execute(current.id, 'record-commitment', {
  actor: buyerActor,
  scopeKey: buyerId,
  input: { amount: 250_000 },
})
```

Available work is a preview. Execution serializes access to the case, reloads
current domain facts, checks the guard again, runs the handler, then reloads and
validates the result. Domain changes and execution evidence commit together.
Different buyer scopes still share the case's atomic operation.

If another domain writer changes the purchase, the next read observes its new
facts directly. No JSONB copy needs synchronization. That external write does not
automatically add an execution to the framework journal.

## External systems

The demo records a verification request, then calls its in-memory mock provider
after the atomic execution returns. The mock provider queues a later webhook.
The result is materialized through a correlated, guarded step.

That demo orchestration is deliberately application code, not a library worker or
outbox. Adopters use their existing approach to dispatch, retry, cancel, and
recover external work. A database transaction never spans the provider call.
Separate domain operations do not make the whole interaction atomic.

## Inspect evidence

```ts
const entries = await engine.journal(current.id, { scopeKey: buyerId })
```

Each committed operation has a `started` entry with immutable state, actor,
validated input, and guard evidence, followed by a `completed` entry with its
delta. They commit together. `replayGuard` compares today's guard against the
historical snapshot. The engine records committed domain operations; refusals and
rolled-back attempts do not create journal entries.

A lost COMMIT acknowledgment produces an uncertain outcome rather than a definite
failure. The Postgres adapter can reconcile by execution identity before the
application decides whether another attempt is appropriate.

## Completion and evolution

Completion is a domain fact such as `purchase.closedAt`. Calling `ctx.end()` marks
the case dormant, excluding it from routine listings while still allowing work
such as deed recording. `ctx.reopen()` clears that marker.

Definitions resolve by name against current code. Applications manage domain
schema/data migrations and loader compatibility. There is no generic document
migration API. See [domain evolution](../migration.md), [architecture](../architecture.md),
and [the codebase map](reference/codebase-map.md).

# Work from current facts

A Case is a business matter whose available work depends on current facts and the
actor. A Step declares Guard conditions and an application-owned operation.

```ts
const dealStep = stepsOf(DealState, actor<DealActor>())
const recordEin = dealStep({
  name: 'record-ein', input: RecordEinInput,
  permits: { operator: (_state, ctx) => ctx.actor.roles.includes('operator') },
  handler: async ({ reference, actor, input, state }) => {
    const saved = await deals.recordEin(reference, actor, input)
    return { ...state, ein: saved.ein }
  },
})
```

The operation commits its own changes. Its returned State reports what happened
for optional journaling. To skip the diff, await the operation without returning
State. To call a provider, do so in the handler using your application's existing
idempotency and admission rules; execution identity is available for correlation.

Bind the Case Type to an authoritative loader, then ask and act:

```ts
const binding = storage.bindCase(dealType, { load: (q, id) => deals.load(q, id) })
const runtime = createBackgroundRuntime()
const engine = createEngine({ storage, caseTypes: [binding], launch: { runtime, leaseMs: 60_000 } })
const available = await engine.affordances(caseId, actor)
const completed = await engine.run(caseId, 'record-ein', { actor, input })
const entries = await engine.journal(caseId)
```

For background work, use the same handler contract with `launch`:

```ts
const { executionId } = await engine.launch(caseId, 'submit-filing', { actor, input })
const execution = await engine.getExecution(executionId)
// Following application/operator reconciliation of an unresolved execution:
await engine.resolveExecution(executionId, { actor, reason: 'Provider outcome reconciled' })
```

Launch returns after handler entry; inspect status for the eventual outcome.
The provided runtime requires a long-lived process; drain it during shutdown.
Expired ownership remains blocked until explicit resolution. Resolution is not
cancellation, and leases do not prevent late domain/provider writes.

Run the reference purchase app with `pnpm db:up`,
`pnpm --filter @affordance/reference-app ui:build` and
`pnpm --filter @affordance/reference-app serve`. Open `http://localhost:8787/`.
Its operations own their Postgres transactions and mock-provider dispatch.
The [core example](../../packages/core/README.md) covers the complete configuration;
[architecture](../architecture.md) specifies uncertainty and evidence semantics.

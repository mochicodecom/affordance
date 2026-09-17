# @affordance/core

Compute available work from current domain facts and actor permissions. A Step's
handler owns persistence, transactions, final business admission and external
calls. Affordance validates state/input, evaluates Guards and invokes it once.

```ts
import { actor, caseType, createBackgroundRuntime, createEngine, stepsOf } from '@affordance/core'
import { z } from 'zod'

const State = z.object({ ein: z.string().nullable() })
const step = stepsOf(State, actor<{ id: string }>())
const definition = caseType({
  name: 'deal', state: State,
  steps: [
    step({
      name: 'record-ein', input: z.object({ ein: z.string() }),
      handler: async ({ reference, actor, input, state }) => {
        const saved = await deals.recordEin(reference, actor, input)
        return { ...state, ein: saved.ein } // Already persisted; evidence only.
      },
    }),
    step({
      name: 'notify',
      handler: async ({ reference, executionId }) => {
        await notifications.send(reference, { executionId })
        // No return: success without a diff journal.
      },
    }),
  ],
})

// Bind an authoritative loader using your adapter, e.g. storage.bindCase(definition, { load }).
const runtime = createBackgroundRuntime()
const engine = createEngine({
  storage, caseTypes: [binding],
  operations: { journalTimeoutMs: 1000 },
  launch: { runtime, leaseMs: 60_000 },
})
const result = await engine.run(caseId, 'record-ein', { actor, input: { ein: '12-3456789' } })
// result.journal.status: 'skipped' | 'recorded' | 'failed'
const { executionId } = await engine.launch(caseId, 'notify', { actor })
const execution = await engine.getExecution(executionId)
// running | completed | unresolved | resolved; null for unknown IDs and ordinary runs.
await runtime.drain() // Stop new launches and await owned tasks during application shutdown.
```

`run` waits for handler completion and a bounded optional journal attempt. `launch`
returns after handler entry while the runtime owns the remaining work. Both use
the same `Promise<State | void>` contract and handler context. There are no injected
repositories, transaction callbacks, or completion wrappers. `undefined` skips
the journal; a valid State produces an `observed` diff, even if unchanged.
Returned State never becomes current Case State. Subsequent reads use the binding.

A thrown handler error propagates unchanged from `run`; committed effects may
already exist. A launched handler error appears as unresolved status. Invalid
evidence and journal failure do not reverse successful handler completion or
retry business code. The journal timeout includes adapter acquisition wait.
An already-started write may finish late under the original execution ID.

The supplied runtime is for a long-lived Node process and keeps outstanding tasks
alive until they settle. It cannot survive process death or a serverless host
freezing after a request. Such hosts need an independently owned runtime with a
real handler-entry acknowledgment. A queue acceptance alone is insufficient.
There is no replay, heartbeat, automatic retry, compensation or recovery worker.

Launch ownership excludes other participating launches for the same Case.
Expiration leaves a block until application/operator reconciliation:

```ts
await engine.resolveExecution(executionId, { actor, reason: 'Reconciled with provider' })
```

Resolution is not cancellation. Leases do not fence domain or provider writes;
an old handler can still write after expiry or resolution. Ordinary runs and
unrelated writers do not participate. The host must authorize status and resolution.

Safe actor attribution defaults to a string actor or string `actor.id`, otherwise
null. Configure `operations.actorIdentity` for another string identity. Request
input and authentication objects are not journaled by this pipeline. Define Case
State as the intended journal projection; schema validation applies before and
after. Keep credentials and unrelated data out of that schema.

This breaking beta removes `execute`, `executeNonAtomic`, transaction-bound
handler repositories and the atomic adapter port. Framework journal/lease data
is not migrated. See [architecture](https://github.com/mochicodecom/affordance/blob/main/docs/architecture.md).

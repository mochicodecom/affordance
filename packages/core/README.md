# @affordance/core

Compute what a case can do now from application-owned facts and actor permissions.
Core defines schemas, guards, scoped steps, atomic domain execution, and historical
evidence. It does not depend on a database or ORM.

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

Bind the definition to your adapter's state loader, concurrency protection, and
repositories before constructing an engine. `@affordance/pg` supplies a Postgres
implementation. Other adapters implement `EngineStorage` and `AtomicCasePort`
from `@affordance/core/storage`.

`engine.attachCase(type, { reference })` associates framework metadata with an
existing domain record. Reads assemble and validate current domain state.
`engine.execute` reevaluates guards and runs one short atomic domain operation.
Handlers return no state document. Their domain writes, journal evidence,
correlations, sequence, and dormancy commit together.

External API orchestration belongs to the adopter. Network calls run outside
atomic handlers. Executions are not automatically retried, and uncertain commits
are reported explicitly rather than falsely recorded as failures.

See [storage and binding examples](https://github.com/mochicodecom/affordance/blob/main/docs/storage.md)
and [architecture](https://github.com/mochicodecom/affordance/blob/main/docs/architecture.md).

This is a breaking replacement of the JSONB current-state and full-state handler
APIs. Existing framework schemas are unsupported and never reset automatically.

For operations that already own their transactions, use
`engine.executeNonAtomic(caseId, stepName, { actor, input, scopeKey, repos })`.
It loads and validates current state, resolves the registered step, validates
input and evaluates its guard, then invokes its handler with those operations.
It does not acquire an atomic case session, retry the handler, reload state after
success, or write journal evidence, sequence, correlations or dormancy. Guards
are a fresh observation, not a lock; the operation retains final admission and
concurrency control. Handler errors propagate unchanged and may follow committed
effects. `correlate`, `end` and `reopen` are unsupported in this mode.

The result identifies the completed invocation and its guard evaluation; it
contains no committed-state delta. An application can write a completion receipt
separately. Such a receipt can be missing after a crash or persistence failure;
recording failure must not fail or retry a known successful operation. The
existing `execute` method and system ingestion keep their atomic guarantees.

# @affordance/core

Compute what a case can do now, for a particular actor. A case is a persisted
object with state and independently guarded steps. Steps become available
through state changes, without a predefined ordering.

Requires Node 22.12+ and a storage adapter. The example uses Postgres through `@affordance/pg`. ESM JavaScript and TypeScript declarations
are included. Zod is one option for the Standard Schema validation interface.

```bash
npm install @affordance/core @affordance/pg pg zod
```

```ts
import { actor, caseType, createEngine, stepsOf } from '@affordance/core'
import { bootstrap, createPgStorage } from '@affordance/pg'
import { Pool } from 'pg'
import { z } from 'zod'

const State = z.object({ ownerId: z.string(), approved: z.boolean() })
const step = stepsOf(State, actor<{ id: string }>())
const approval = caseType({
  name: 'approval',
  state: State,
  steps: [step({
    name: 'approve',
    requires: { pending: (state) => !state.approved },
    permits: { owner: (state, ctx) => state.ownerId === ctx.actor.id },
    handler: async (state) => ({ ...state, approved: true }),
  })],
})

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
try {
  await bootstrap(pool)
  const engine = createEngine({ storage: createPgStorage({ db: { pool } }), caseTypes: [approval] })
  const current = await engine.createCase('approval', { ownerId: 'alice', approved: false })
  console.log(await engine.affordances(current.id, { id: 'alice' }))
  await engine.execute(current.id, 'approve', { actor: { id: 'alice' } })
  console.log(await engine.journal(current.id))
} finally {
  await pool.end()
}
```

The engine claims a case, runs its async handler outside a database transaction,
then commits state and journal together. Executions serialize per case;
external effects must tolerate retries.

Read the [introduction](https://github.com/mochicodecom/affordance/blob/main/docs/tutorial/README.md)
and [architecture](https://github.com/mochicodecom/affordance/blob/main/docs/architecture.md).
The private [reference app](https://github.com/mochicodecom/affordance/tree/main/packages/reference-app)
shows how a host can expose available steps as HTTP links. Licensed under [MIT](./LICENSE).

`engine.listCases({ caseTypeName, includeEnded, limit, cursor })` returns
`{ cases, nextCursor }`. It lists registered types, validates stored state just
like `engine.case(id)`, and excludes dormant cases by default. The default page
size is 100 (maximum 1000); continue with the returned cursor and the same filters.
Validation failures are reported to the caller. Listing does not apply actor
permissions; the host controls access just as for addressed case reads.

See [storage adapters](https://github.com/mochicodecom/affordance/blob/main/docs/storage.md)
for the public interfaces, transaction guarantees, and custom commit contexts.

## Stored runtime values

Date, Set and bigint are supported by default, including nested values, without
application codec configuration. Guards and handlers keep the application's
runtime schema and types. Adapters use core's serialization format for complete
state, claim-time snapshots, actors and inputs.

Journal deltas compare serialized values and type metadata: value paths begin
with `/json`, and runtime type changes can affect `/meta`. Sets compare by
structural membership regardless of insertion order; complete snapshots retain
iteration order. `replayGuard` is asynchronous because it schema-validates the
restored full snapshot before guard reevaluation. Neither loading nor replay
depends on deltas. See the [storage contract](../../docs/storage.md#serialization-contract)
for adapter requirements and unsupported values that throw `SerializationError`.

# @affordance/core

Compute what a case can do now, for a particular actor. A case is a persisted
object with state and independently guarded steps. Steps become available
through state changes, without a predefined ordering.

Requires Node 22.12+ and Postgres. ESM JavaScript and TypeScript declarations
are included. Zod is one option for the Standard Schema validation interface.

```bash
npm install @affordance/core pg zod
```

```ts
import { actor, bootstrap, caseType, createEngine, stepsOf } from '@affordance/core'
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
  const engine = createEngine({ db: { pool }, caseTypes: [approval] })
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
The optional [HTTP adapter](https://github.com/mochicodecom/affordance/tree/main/packages/http)
exposes available steps as links. Licensed under [MIT](./LICENSE).

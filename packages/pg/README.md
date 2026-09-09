# @affordance/pg

Postgres storage for `@affordance/core`: cases, execution claims, journals,
correlations, delivery deduplication, migrations, and atomic commit effects.

```sh
npm install @affordance/core @affordance/pg pg
```

```ts
import { createEngine } from '@affordance/core'
import { bootstrap, createPgStorage } from '@affordance/pg'
import { Pool } from 'pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
await bootstrap(pool)
const storage = createPgStorage({ db: { pool } })
const engine = createEngine({ storage, caseTypes: [purchase] })
const page = await engine.listCases({ limit: 100 })
```

The app owns connection lifetime. Supply `{ pool }` for a connection source or
`{ client }` for a dedicated connection. Schema bootstrap is explicit and
idempotent; the engine does not run DDL when constructed.

`ctx.onCommit` receives the commit transaction by default. Supply
`commitContext: tx => ({ payments: createPaymentRepository(tx) })` to expose
application repositories bound to that transaction instead. Declare the context
with core's `stepsOf(schema, actor<Actor>(), commitContext<Repositories>())`.

`deleteCase(db, caseId)` is destructive administrative cleanup for disposable
cases. It deletes the case and its framework records in one transaction.

See [storage adapters](https://github.com/mochicodecom/affordance/blob/main/docs/storage.md)
for the interface and migration from `createEngine({ db })`.

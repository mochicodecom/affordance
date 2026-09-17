import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  actor,
  caseType,
  createBackgroundRuntime,
  createEngine,
  StepInputValidationError,
  StepNotAvailableError,
  stepsOf,
} from '@affordance/core'
import { bootstrap, createPgStorage, withTransaction } from '@affordance/pg'
import { Pool } from 'pg'
import { z } from 'zod'

const State = z.object({
  items: z.array(
    z.object({ id: z.string(), done: z.boolean(), amount: z.number() }),
  ),
})
const pool = new Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5432/affordance_test',
})
const runtime = createBackgroundRuntime()
const step = stepsOf(State, actor<{ id: string }>())
const definition = caseType({
  name: `npm-consumer-${randomUUID()}`,
  state: State,
  steps: [
    step({
      name: 'finish',
      scope: { select: (s) => s.items, key: (i) => i.id },
      requires: { unfinished: (_s, c) => !c.scope.done },
      permits: { owns: (_s, c) => c.actor.id === c.scope.id },
      input: z.object({ amount: z.number().positive() }),
      handler: async (ctx) => {
        // @ts-expect-error input remains numeric through published declarations
        const invalid: string = ctx.input.amount
        void invalid
        return withTransaction({ pool }, async (tx) => {
          const changed = await tx.query(
            'update consumer_items set done=true,amount=$3 where reference=$1 and id=$2 and not done',
            [ctx.reference, ctx.scope.id, ctx.input.amount],
          )
          if (changed.rowCount !== 1) throw new Error('already done')
          return {
            items: (
              await tx.query<{ id: string; done: boolean; amount: number }>(
                'select id,done,amount from consumer_items where reference=$1 order by id',
                [ctx.reference],
              )
            ).rows,
          }
        })
      },
    }),
    step({ name: 'void', handler: async () => {} }),
  ],
})
try {
  await bootstrap(pool)
  await pool.query(
    'create table if not exists consumer_items (reference text,id text,done boolean,amount double precision,primary key(reference,id))',
  )
  const reference = randomUUID()
  await pool.query("insert into consumer_items values ($1,'owner',false,0)", [
    reference,
  ])
  const storage = createPgStorage({ db: { pool } })
  const binding = storage.bindCase(definition, {
    load: async (q, id) => ({
      items: (
        await q.query<{ id: string; done: boolean; amount: number }>(
          'select id,done,amount from consumer_items where reference=$1 order by id',
          [id],
        )
      ).rows,
    }),
  })
  const engine = createEngine({
    storage,
    caseTypes: [binding],
    launch: { runtime, leaseMs: 60_000 },
  })
  const current = await engine.attachCase(definition.name, { reference })
  const run = (amount: number) =>
    engine.run(current.id, 'finish', {
      actor: { id: 'owner' },
      scopeKey: 'owner',
      input: { amount },
    })
  await assert.rejects(run(-1), StepInputValidationError)
  assert.equal((await run(10)).journal.status, 'recorded')
  await assert.rejects(run(10), StepNotAvailableError)
  assert.deepEqual(
    (await engine.journal(current.id)).map((e) => e.entry),
    ['observed'],
  )
  const launched = await engine.launch(current.id, 'void', {
    actor: { id: 'owner' },
  })
  await runtime.drain()
  assert.equal(
    (await engine.getExecution(launched.executionId))?.status,
    'completed',
  )
} finally {
  await runtime.drain()
  await pool.end()
}

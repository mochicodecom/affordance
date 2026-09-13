import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  actor,
  caseType,
  createEngine,
  repositories,
  StepInputValidationError,
  StepNotAvailableError,
  stepsOf,
} from '@affordance/core'
import { bootstrap, createPgStorage } from '@affordance/pg'
import { Pool } from 'pg'
import { z } from 'zod'

const State = z.object({
  items: z.array(
    z.object({ id: z.string(), done: z.boolean(), amount: z.number() }),
  ),
})
interface Repos {
  finish(id: string, amount: number): Promise<void>
}
const step = stepsOf(State, actor<{ id: string }>(), repositories<Repos>())
const definition = caseType({
  name: `npm-consumer-${randomUUID()}`,
  state: State,
  steps: [
    step({
      name: 'finish',
      scope: { select: (state) => state.items, key: (item) => item.id },
      requires: { unfinished: (_s, c) => !c.scope.done },
      permits: { owns: (_s, c) => c.actor.id === c.scope.id },
      input: z.object({ amount: z.number().positive() }),
      handler: async (ctx) => {
        // @ts-expect-error input remains numeric through published declarations
        const invalid: string = ctx.input.amount
        void invalid
        await ctx.repos.finish(ctx.scope.id, ctx.input.amount)
      },
    }),
  ],
})
const pool = new Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5432/affordance_test',
})
try {
  await bootstrap(pool)
  await pool.query(
    'create table if not exists consumer_items (reference text, id text, done boolean, amount double precision, primary key(reference,id))',
  )
  const reference = randomUUID()
  await pool.query("insert into consumer_items values ($1,'owner',false,0)", [
    reference,
  ])
  const storage = createPgStorage({ db: { pool } })
  const bound = storage.bindCase(definition, {
    load: async (q, id) => ({
      items: (
        await q.query<{ id: string; done: boolean; amount: number }>(
          'select id,done,amount from consumer_items where reference=$1 order by id',
          [id],
        )
      ).rows,
    }),
    protect: async (tx, id) => {
      await tx.query(
        'select id from consumer_items where reference=$1 order by id for update',
        [id],
      )
    },
    repositories: (tx, reference) => ({
      finish: async (id, amount) => {
        await tx.query(
          'update consumer_items set done=true,amount=$3 where reference=$1 and id=$2',
          [reference, id, amount],
        )
      },
    }),
  })
  const engine = createEngine({ storage, caseTypes: [bound] })
  const current = await engine.attachCase(definition.name, { reference })
  const available = (await engine.affordances(current.id, { id: 'owner' }))
    .affordances[0]
  assert(available)
  assert.equal(available.scopeKey, 'owner')
  const execute = (amount: number) =>
    engine.execute(current.id, 'finish', {
      actor: { id: 'owner' },
      scopeKey: 'owner',
      input: { amount },
    })
  await assert.rejects(execute(-1), StepInputValidationError)
  assert((await execute(10)).delta.length > 0)
  await assert.rejects(execute(10), StepNotAvailableError)
  assert.deepEqual(
    (await engine.journal(current.id)).map((e) => e.entry),
    ['started', 'completed'],
  )
} finally {
  await pool.end()
}

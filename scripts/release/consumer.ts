import assert from 'node:assert/strict'
import {
  actor,
  caseType,
  createEngine,
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
const step = stepsOf(State, actor<{ id: string }>())
const finish = step({
  name: 'finish',
  scope: { select: (state) => state.items, key: (item) => item.id },
  requires: { unfinished: (_state, ctx) => !ctx.scope.done },
  permits: { owns: (_state, ctx) => ctx.actor.id === ctx.scope.id },
  input: z.object({ amount: z.number().positive() }),
  handler: async (state, ctx) => {
    const amount: number = ctx.input.amount
    const id: string = ctx.scope.id
    // Consumer inference must preserve the input and scope types.
    // @ts-expect-error amount is inferred as a number, never a string or any.
    const invalid: string = ctx.input.amount
    void invalid
    return {
      ...state,
      items: state.items.map((item) =>
        item.id === id ? { ...item, done: true, amount } : item,
      ),
    }
  },
})
const definition = caseType({
  name: 'npm-consumer',
  state: State,
  steps: [finish],
})
const pool = new Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5432/affordance_test',
})

try {
  await bootstrap(pool)
  const engine = createEngine({
    storage: createPgStorage({ db: { pool } }),
    caseTypes: [definition],
  })
  const created = await engine.createCase(definition.name, {
    items: [{ id: 'owner', done: false, amount: 0 }],
  })
  const current = await engine.affordances(created.id, { id: 'owner' })
  const available = current.affordances[0]
  assert(available)
  assert.equal(available.step, 'finish')
  assert.equal(available.scopeKey, 'owner')
  const execute = (amount: number) =>
    engine.execute(created.id, available.step, {
      actor: { id: 'owner' },
      scopeKey: available.scopeKey,
      input: { amount },
    })
  await assert.rejects(execute(-1), StepInputValidationError)
  const result = await execute(10)
  assert(result.delta.length > 0)
  await assert.rejects(execute(10), StepNotAvailableError)
  const journal = await engine.journal(created.id)
  assert.deepEqual(
    journal.map((entry) => entry.entry),
    ['claimed', 'completed'],
  )
  assert(journal[0]?.guard?.available)
  const after = await engine.affordances(created.id, { id: 'owner' })
  assert.equal(after.affordances.length, 0)
} finally {
  await pool.end()
}

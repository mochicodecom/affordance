import assert from 'node:assert/strict'
import {
  type AffordancePayload,
  CONTRACT,
  type ExecutionPayload,
} from '@affordance/contract'
import { actor, caseType, createEngine, stepsOf } from '@affordance/core'
import { createAffordanceApi, createHonoApp } from '@affordance/http'
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
  const app = createHonoApp({
    api: createAffordanceApi({ engine }),
    resolveActor: () => ({ id: 'owner' }),
  })
  const created = await app.request('/cases', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      caseType: definition.name,
      state: { items: [{ id: 'owner', done: false, amount: 0 }] },
    }),
  })
  assert.equal(created.status, 201)
  const payload = (await created.json()) as AffordancePayload
  assert.equal(payload.contract, CONTRACT)
  const available = payload.affordances[0]
  assert(available)
  assert.equal(available.step, 'finish')
  assert.equal(available.scopeKey, 'owner')
  const request = (amount: number) =>
    app.request(available.links.execute.href, {
      method: available.links.execute.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scopeKey: available.scopeKey, input: { amount } }),
    })
  assert.equal((await request(-1)).status, 422)
  const executed = await request(10)
  assert.equal(executed.status, 201)
  const result = (await executed.json()) as ExecutionPayload
  assert.equal(result.contract, CONTRACT)
  assert(result.execution.delta.length > 0)
  assert.equal((await request(10)).status, 409)
  const journal = await engine.journal(payload.case.id)
  assert.deepEqual(
    journal.map((entry) => entry.entry),
    ['claimed', 'completed'],
  )
  assert(journal[0]?.guard?.available)
  const after = await engine.affordances(payload.case.id, { id: 'owner' })
  assert.equal(after.affordances.length, 0)
} finally {
  await pool.end()
}

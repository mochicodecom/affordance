import { randomUUID } from 'node:crypto'
import { caseType, createEngine, stepsOf } from '@affordance/core'
import { deserializeValue, serializeValue } from '@affordance/core/storage'
import { testPool } from '@affordance/testkit'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { createPgStorage } from '../src/index.js'

const pool = testPool()

it('persists independently decodable complete documents and separate JSON Patch evidence', async () => {
  const State = z.object({ date: z.date(), set: z.set(z.bigint()) })
  const before = { date: new Date(0), set: new Set([2n, 1n]) }
  const after = { date: new Date(1), set: new Set([3n]) }
  const type = caseType({
    name: `serialized-${randomUUID()}`,
    state: State,
    steps: [
      stepsOf(State)({
        name: 'change',
        input: State,
        handler: async () => after,
      }),
    ],
  })
  const engine = createEngine({
    storage: createPgStorage({ db: { pool } }),
    caseTypes: [type],
  })
  const created = await engine.createCase(type.name, before)
  const result = await engine.execute(created.id, 'change', {
    actor: before,
    input: after,
  })
  // These two reads do not fetch any delta. Each state column is a full document.
  const current = (
    await pool.query<{ state: unknown }>(
      'select state from affordance.cases where id = $1',
      [created.id],
    )
  ).rows[0]!
  const claimed = (
    await pool.query<{ state: unknown; actor: unknown; input: unknown }>(
      "select state, actor, input from affordance.journal where case_id = $1 and entry = 'claimed'",
      [created.id],
    )
  ).rows[0]!
  expect(current.state).toEqual(serializeValue(after))
  expect(claimed.state).toEqual(serializeValue(before))
  expect(deserializeValue(current.state)).toStrictEqual(after)
  expect(deserializeValue(claimed.state)).toStrictEqual(before)
  expect(deserializeValue(claimed.actor)).toStrictEqual(before)
  expect(deserializeValue(claimed.input)).toStrictEqual(after)
  const completed = (
    await pool.query<{ state: unknown; delta: unknown }>(
      "select state, delta from affordance.journal where case_id = $1 and entry = 'completed'",
      [created.id],
    )
  ).rows[0]!
  expect(completed.state).toBeNull()
  expect(completed.delta).toEqual(result.delta)
  expect(JSON.parse(JSON.stringify(completed.delta))).toEqual(result.delta)
})

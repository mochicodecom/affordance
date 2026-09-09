import { randomUUID } from 'node:crypto'
import { caseType, createEngine } from '@affordance/core'
import { testPool } from '@affordance/testkit'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createPgStorage, deleteCase } from '../src/index.js'

const pool = testPool()
describe('Postgres case cursors', () => {
  it('preserves timestamp precision and continues after the cursor case is deleted', async () => {
    const type = caseType({
      name: randomUUID(),
      state: z.object({}),
      steps: [],
    })
    const engine = createEngine({
      storage: createPgStorage({ db: { pool } }),
      caseTypes: [type],
    })
    const cases = await Promise.all([
      engine.createCase(type.name, {}),
      engine.createCase(type.name, {}),
      engine.createCase(type.name, {}),
    ])
    for (let i = 0; i < cases.length; i++) {
      await pool.query(
        'update affordance.cases set created_at = $2::timestamptz where id = $1',
        [cases[i]!.id, `2026-01-01T00:00:00.00000${i + 1}Z`],
      )
    }
    const first = await engine.listCases({ limit: 1 })
    expect(first.cases.map((c) => c.id)).toEqual([cases[2]!.id])
    await deleteCase({ pool }, first.cases[0]!.id)
    await engine.createCase(type.name, {}) // Newer insert must not shift the continuation.
    const second = await engine.listCases({
      limit: 1,
      cursor: first.nextCursor!,
    })
    const third = await engine.listCases({
      limit: 1,
      cursor: second.nextCursor!,
    })
    expect(second.cases.map((c) => c.id)).toEqual([cases[1]!.id])
    expect(third.cases.map((c) => c.id)).toEqual([cases[0]!.id])
    expect(third.nextCursor).toBeNull()
    await expect(
      engine.listCases({ cursor: first.nextCursor!, includeEnded: true }),
    ).rejects.toThrow('changed filters')
    await expect(engine.listCases({ cursor: 'invalid' })).rejects.toThrow(
      TypeError,
    )
  })
})

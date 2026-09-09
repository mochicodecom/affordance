import { caseType, createEngine } from '@affordance/core'
import { testPool } from '@affordance/testkit'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { createPgStorage, queryableOf, withTransaction } from '../src/index.js'

const pool = testPool()
it('serializes dedicated-client operations and keeps reads outside a rolled-back transaction', async () => {
  const client = await pool.connect()
  try {
    const db = { client }
    const storage = createPgStorage({ db })
    const type = caseType({
      name: 'client-transaction-contract',
      state: z.object({ count: z.number() }),
      steps: [],
    })
    const engine = createEngine({ storage, caseTypes: [type] })
    const created = await engine.createCase(type.name, { count: 0 })
    let entered!: () => void
    let release!: () => void
    const inside = new Promise<void>((resolve) => {
      entered = resolve
    })
    const finish = new Promise<void>((resolve) => {
      release = resolve
    })
    const aborted = withTransaction(db, async (tx) => {
      await tx.query(
        'update affordance.cases set state = $2::jsonb where id = $1',
        [created.id, JSON.stringify({ count: 1 })],
      )
      entered()
      await finish
      throw new Error('rollback')
    })
    const rejection = expect(aborted).rejects.toThrow('rollback')
    await inside
    const read = engine.case(created.id)
    const write = withTransaction(db, async (tx) => {
      await tx.query(
        'update affordance.cases set seq = seq + 1 where id = $1',
        [created.id],
      )
    })
    release()
    await rejection
    expect(await read).toMatchObject({ state: { count: 0 }, seq: 0 })
    await write
    expect(await engine.case(created.id)).toMatchObject({
      state: { count: 0 },
      seq: 1,
    })
    expect((await queryableOf(db).query('select 1 as one')).rows).toEqual([
      { one: 1 },
    ])
  } finally {
    client.release()
  }
})

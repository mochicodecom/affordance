import { randomUUID } from 'node:crypto'
import {
  actor,
  caseType,
  createBackgroundRuntime,
  createEngine,
  stepsOf,
} from '@affordance/core'
import { testPool } from '@affordance/testkit'
import { beforeAll, expect, it } from 'vitest'
import { z } from 'zod'
import { createPgStorage } from '../src/index.js'

const pool = testPool({ max: 1 })
beforeAll(async () => {
  await pool.query(
    'create table if not exists launch_domains (id text primary key,count integer not null)',
  )
})
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
async function fixture(handler: () => Promise<void>) {
  const reference = randomUUID()
  await pool.query('insert into launch_domains values ($1,0)', [reference])
  const state = z.object({ count: z.number() })
  const step = stepsOf(state, actor<{ id: string }>())
  const definition = caseType({
    name: reference,
    state,
    steps: [step({ name: 'work', handler })],
  })
  const storage = createPgStorage({ db: { pool } })
  const binding = storage.bindCase(definition, {
    load: async (q, id) => {
      const { rows } = await q.query<{ count: number }>(
        'select count from launch_domains where id=$1',
        [id],
      )
      return rows[0]!
    },
  })
  const runtime = createBackgroundRuntime()
  const engine = createEngine({
    storage,
    caseTypes: [binding],
    launch: { runtime, leaseMs: 60_000 },
  })
  const { id } = await engine.attachCase(definition.name, { reference })
  return { engine, storage, runtime, id, args: { actor: { id: 'operator' } } }
}
it('does not retain a connection across handler work; expiration blocks launch until explicit resolution', async () => {
  const first = deferred(),
    second = deferred()
  let calls = 0
  const f = await fixture(async () => {
    calls++
    await (calls === 1 ? first : second).promise
  })
  try {
    const old = await f.engine.launch(f.id, 'work', f.args)
    await pool.query(
      "update affordance.launched_executions set expires_at=clock_timestamp()-interval '1 second' where execution_id=$1",
      [old.executionId],
    )
    expect(await f.engine.getExecution(old.executionId)).toMatchObject({
      status: 'unresolved',
      reason: 'expired',
    })
    await expect(f.engine.launch(f.id, 'work', f.args)).rejects.toMatchObject({
      name: 'LaunchBlockedError',
    })
    const resolved = await f.engine.resolveExecution(old.executionId, {
      actor: 'reconciler',
      reason: 'Checked provider and live handler',
    })
    const current = await f.engine.launch(f.id, 'work', f.args)
    first.resolve()
    expect(
      await f.storage.launches!.complete(old.executionId, {
        status: 'recorded',
      }),
    ).toBe(false)
    await f.storage.launches!.release(old.executionId)
    expect(await f.engine.getExecution(old.executionId)).toEqual(resolved)
    expect(await f.engine.getExecution(current.executionId)).toMatchObject({
      status: 'running',
    })
    second.resolve()
    await f.runtime.drain()
    expect(await f.engine.getExecution(current.executionId)).toMatchObject({
      status: 'completed',
    })
  } finally {
    first.resolve()
    second.resolve()
    await f.runtime.drain()
  }
})
it('admits only one of two simultaneous claims for a case', async () => {
  const gate = deferred()
  let calls = 0
  const f = await fixture(async () => {
    calls++
    await gate.promise
  })
  try {
    const outcomes = await Promise.allSettled([
      f.engine.launch(f.id, 'work', f.args),
      f.engine.launch(f.id, 'work', f.args),
    ])
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(calls).toBe(1)
  } finally {
    gate.resolve()
    await f.runtime.drain()
  }
})
it('never resolves an unexpired running execution', async () => {
  const gate = deferred()
  const f = await fixture(async () => {
    await gate.promise
  })
  try {
    const launched = await f.engine.launch(f.id, 'work', f.args)
    await expect(
      f.engine.resolveExecution(launched.executionId, {
        actor: 'operator',
        reason: 'too early',
      }),
    ).rejects.toThrow('not unresolved')
    expect(await f.engine.getExecution(launched.executionId)).toMatchObject({
      status: 'running',
    })
  } finally {
    gate.resolve()
    await f.runtime.drain()
  }
})

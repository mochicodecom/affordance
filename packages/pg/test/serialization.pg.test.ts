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

it.each([false, true])(
  'reports undecodable candidates by case and continues through later pages (dryRun=%s)',
  async (dryRun) => {
    const State = z.object({ count: z.number() })
    const type = caseType({
      name: `decode-sweep-${randomUUID()}`,
      state: State,
      steps: [],
    })
    const engine = createEngine({
      storage: createPgStorage({ db: { pool } }),
      caseTypes: [type],
    })
    const cases = (
      await Promise.all(
        Array.from({ length: 3 }, () =>
          engine.createCase(type.name, { count: 0 }),
        ),
      )
    ).sort((a, b) => a.id.localeCompare(b.id))
    const bad = cases[1]!
    await pool.query(
      'update affordance.cases set state = $2::jsonb where id = $1',
      [
        bad.id,
        JSON.stringify({
          version: 1,
          json: 'invalid',
          meta: { values: ['Date'], v: 1 },
        }),
      ],
    )
    const progress: string[] = []
    const report = await engine.migrate(
      type.name,
      'increment',
      (s) => ({ ...s, count: s.count + 1 }),
      {
        dryRun,
        batchSize: 2,
        onProgress: (p) => progress.push(p.caseId),
      },
    )
    expect(report).toMatchObject({ scanned: 3, migrated: 2, unchanged: 0 })
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]?.caseId).toBe(bad.id)
    expect(report.failed[0]?.error.message).toContain(bad.id)
    expect(report.failed[0]?.error.message).toMatch(/state.*invalid Date/)
    expect(progress).toEqual(cases.map((c) => c.id))
    for (const good of [cases[0]!, cases[2]!]) {
      expect((await engine.case(good.id)).state).toEqual({
        count: dryRun ? 0 : 1,
      })
    }
    expect(await engine.journal(bad.id)).toEqual([])
    await expect(engine.case(bad.id)).rejects.toThrow(bad.id)
    await expect(engine.listCases()).rejects.toThrow(bad.id)
  },
)

it.each(['actor', 'input', 'state'] as const)(
  'identifies the journal row, case and %s column on a decode failure',
  async (column) => {
    const State = z.object({ count: z.number() })
    const type = caseType({
      name: `journal-context-${randomUUID()}`,
      state: State,
      steps: [
        stepsOf(State)({
          name: 'check',
          input: z.unknown(),
          handler: async (s) => s,
        }),
      ],
    })
    const engine = createEngine({
      storage: createPgStorage({ db: { pool } }),
      caseTypes: [type],
    })
    const created = await engine.createCase(type.name, { count: 1 })
    for (const field of ['actor', 'input'] as const) {
      const error = await engine
        .execute(created.id, 'check', { actor: null, [field]: new Map() })
        .catch((error: unknown) => error)
      expect(error).toMatchObject({
        name: 'SerializationError',
        message: expect.stringContaining(created.id),
      })
      expect(error).toHaveProperty(
        'message',
        expect.stringContaining(`step 'check'`),
      )
      expect(error).toHaveProperty(
        'message',
        expect.stringContaining(`${field}:`),
      )
    }
    await engine.execute(created.id, 'check', { actor: null })
    const [claim] = await engine.journal(created.id, { entry: 'claimed' })
    // Deliberately corrupt this test's new-format evidence; no legacy fixture or reader.
    await pool.query(
      `update affordance.journal set ${column} = $2::jsonb where id = $1`,
      [
        claim!.id,
        JSON.stringify({
          version: 1,
          json: 'invalid',
          meta: { values: ['bigint'], v: 1 },
        }),
      ],
    )
    const error = await engine
      .journal(created.id)
      .catch((error: unknown) => error)
    expect(error).toMatchObject({
      name: 'SerializationError',
      message: expect.stringContaining(claim!.id),
    })
    expect(error).toHaveProperty('message', expect.stringContaining(created.id))
    expect(error).toHaveProperty(
      'message',
      expect.stringContaining(`${column}:`),
    )
    expect(error).toHaveProperty('cause', expect.any(Error))
  },
)

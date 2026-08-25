/**
 * The migration escape hatch against a real database.
 *
 * The acceptance criterion has three parts: a rename over seeded cases
 * journals one system Execution per case, audit reconstruction shows the
 * transform, and re-running is a no-op.
 */

import { randomUUID } from 'node:crypto'
import { testPool } from '@affordance/testkit'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createEngine } from '../../src/engine/index.js'
import { foldExecutions } from '../../src/execution/index.js'
import { hasMigrated, migrationStepName } from '../../src/migration/index.js'
import { caseType, step } from '../../src/model/index.js'
import { FRAMEWORK_SCHEMA } from '../../src/store/index.js'

const pool = testPool()

/**
 * The two-shape window `docs/migration.md` prescribes: the schema and the
 * conditions read the old field and the new one, so the app is correct
 * whether or not a given case has been restructured yet.
 */
const LedgerState = z.object({
  purchase: z.object({ address: z.string() }),
  /** The old shape: one buyer, singular. */
  buyer: z
    .object({ id: z.string(), committed: z.number() })
    .nullable()
    .default(null),
  /** The new shape: a collection. */
  buyers: z
    .array(z.object({ id: z.string(), committed: z.number() }))
    .default([]),
  notes: z.array(z.string()).default([]),
})

type Ledger = z.output<typeof LedgerState>

const buyersOf = (s: Ledger) =>
  s.buyers.length > 0 ? s.buyers : s.buyer === null ? [] : [s.buyer]

const addNote = step({
  name: 'add-note',
  input: z.string(),
  handler: async (s: Ledger, ctx): Promise<Ledger> => ({
    ...s,
    notes: [...s.notes, ctx.input],
  }),
})

/** Reads through both shapes — which is why the migration can be leisurely. */
const closeOut = step({
  name: 'close-out',
  requires: { hasBuyers: (s: Ledger) => buyersOf(s).length > 0 },
  handler: async (s: Ledger): Promise<Ledger> => s,
})

const ledger = caseType({
  name: `ledger-migration-${randomUUID().slice(0, 8)}`,
  state: LedgerState,
  steps: [addNote, closeOut],
})

const engine = createEngine({ db: { pool }, caseTypes: [ledger] })

const MIGRATION = 'buyer-to-buyers'

/** The restructure: the singular field becomes the collection. */
const toCollection = (state: unknown): unknown => {
  const s = state as Ledger
  if (s.buyer === null) return s
  return { ...s, buyers: [...s.buyers, s.buyer], buyer: null }
}

const seed = async (count: number) =>
  Promise.all(
    Array.from({ length: count }, (_, index) =>
      engine.createCase(ledger.name, {
        purchase: { address: `purchase-${index}` },
        buyer: { id: `buyer_${index}`, committed: 1_000 * (index + 1) },
      }),
    ),
  )

const stateOf = async (caseId: string): Promise<Ledger> => {
  const { rows } = await pool.query<{ state: Ledger }>(
    `select state from ${FRAMEWORK_SCHEMA}.cases where id = $1`,
    [caseId],
  )
  return rows[0]!.state
}

describe('migrate', () => {
  it('restructures every case as one journaled system Execution, and re-running is a no-op', async () => {
    const cases = await seed(3)

    const first = await engine.migrate(ledger.name, MIGRATION, toCollection)

    expect(first).toMatchObject({
      name: MIGRATION,
      caseTypeName: ledger.name,
      dryRun: false,
      scanned: 3,
      migrated: 3,
      unchanged: 0,
      failed: [],
    })
    for (const created of cases) {
      const state = await stateOf(created.id)
      expect(state.buyer).toBeNull()
      expect(state.buyers).toHaveLength(1)

      // One system Execution, journaled like anything else that ever happened
      // to the case — actor, delta and all.
      const executions = foldExecutions(await engine.journal(created.id))
      expect(executions).toHaveLength(1)
      expect(executions[0]).toMatchObject({
        step: migrationStepName(MIGRATION),
        status: 'completed',
        actor: { kind: 'migration', migration: MIGRATION },
      })
      expect(executions[0]?.delta?.some((op) => op.path === '/buyers/-')).toBe(
        true,
      )
      expect(await hasMigrated(pool, created.id, MIGRATION)).toBe(true)
    }

    // Idempotent: the second run finds nothing left to examine at all.
    const second = await engine.migrate(ledger.name, MIGRATION, toCollection)
    expect(second).toMatchObject({ scanned: 0, migrated: 0, failed: [] })
    expect(await engine.journal(cases[0]!.id)).toHaveLength(2)
  })

  it('reconstructs before and after from the journal alone', async () => {
    const [created] = await seed(1)
    await engine.migrate(ledger.name, MIGRATION, toCollection, {
      caseIds: [created!.id],
    })

    const claimed = (await engine.journal(created!.id, { entry: 'claimed' }))[0]
    const completed = (
      await engine.journal(created!.id, { entry: 'completed' })
    )[0]

    // The `claimed` entry stores the state the Execution ran against…
    expect((claimed!.state as Ledger).buyer).toMatchObject({ id: 'buyer_0' })
    expect((claimed!.state as Ledger).buyers).toEqual([])
    // …and the `completed` entry stores exactly what changed.
    // Appends are `/-` per RFC 6902, the journal's delta format.
    expect(completed?.delta).toEqual([
      { op: 'replace', path: '/buyer', value: null },
      {
        op: 'add',
        path: '/buyers/-',
        value: { id: 'buyer_0', committed: 1_000 },
      },
    ])
  })

  it('journals a case the transform had nothing to do to, and marks it', async () => {
    const created = await engine.createCase(ledger.name, {
      purchase: { address: 'already-migrated' },
      buyers: [{ id: 'buyer_x', committed: 5 }],
    })

    const report = await engine.migrate(ledger.name, MIGRATION, toCollection, {
      caseIds: [created.id],
    })

    expect(report).toMatchObject({ scanned: 1, migrated: 0, unchanged: 1 })
    // Marked all the same: "considered, nothing to do" is a provable fact.
    expect(await hasMigrated(pool, created.id, MIGRATION)).toBe(true)
  })

  it('reports progress per case and honours a limit', async () => {
    const cases = await seed(3)
    const seen: string[] = []

    const report = await engine.migrate(ledger.name, MIGRATION, toCollection, {
      caseIds: cases.map((created) => created.id),
      limit: 2,
      batchSize: 1,
      onProgress: (progress) =>
        seen.push(`${progress.processed}:${progress.outcome}`),
    })

    expect(report.scanned).toBe(2)
    expect(seen).toEqual(['1:migrated', '2:migrated'])
    // The third is untouched, and a later run would still find it.
    const remaining = await engine.migrate(
      ledger.name,
      MIGRATION,
      toCollection,
      {
        caseIds: cases.map((created) => created.id),
        dryRun: true,
      },
    )
    expect(remaining.scanned).toBe(1)
  })

  it('dry-runs without writing, marking, or journaling anything', async () => {
    const [created] = await seed(1)

    const report = await engine.migrate(ledger.name, MIGRATION, toCollection, {
      caseIds: [created!.id],
      dryRun: true,
    })

    expect(report).toMatchObject({ dryRun: true, scanned: 1, migrated: 1 })
    expect((await stateOf(created!.id)).buyer).not.toBeNull()
    expect(await engine.journal(created!.id)).toEqual([])
    expect(await hasMigrated(pool, created!.id, MIGRATION)).toBe(false)
  })

  it('reports a case it could not migrate and leaves it for the next run', async () => {
    const cases = await seed(2)
    const [ok, doomed] = cases

    const report = await engine.migrate(
      ledger.name,
      MIGRATION,
      (state) => {
        const s = state as Ledger
        if (s.purchase.address === 'purchase-1')
          throw new Error('this case confuses the transform')
        return toCollection(s)
      },
      { caseIds: cases.map((created) => created.id) },
    )

    expect(report.scanned).toBe(2)
    expect(report.migrated).toBe(1)
    expect(report.failed).toHaveLength(1)
    expect(report.failed[0]?.caseId).toBe(doomed!.id)
    expect(report.failed[0]?.error.message).toMatch(
      /this case confuses the transform/,
    )
    // No marker for the failure, so a corrected run picks it up…
    expect(await hasMigrated(pool, doomed!.id, MIGRATION)).toBe(false)
    expect(await hasMigrated(pool, ok!.id, MIGRATION)).toBe(true)

    const retry = await engine.migrate(ledger.name, MIGRATION, toCollection, {
      caseIds: cases.map((created) => created.id),
    })
    expect(retry).toMatchObject({ scanned: 1, migrated: 1, failed: [] })
    expect((await stateOf(doomed!.id)).buyers).toHaveLength(1)
  })

  it('refuses a transform whose result the state schema rejects', async () => {
    const [created] = await seed(1)

    const report = await engine.migrate(
      ledger.name,
      MIGRATION,
      () => ({ purchase: { address: 42 } }),
      { caseIds: [created!.id] },
    )

    expect(report.migrated).toBe(0)
    expect(report.failed).toHaveLength(1)
    // The case is untouched — a migration is an Execution, and an Execution
    // that fails validation writes nothing.
    expect((await stateOf(created!.id)).buyer).not.toBeNull()
  })

  it('leaves ended cases alone unless asked', async () => {
    const [created] = await seed(1)
    await pool.query(
      `update ${FRAMEWORK_SCHEMA}.cases set ended_at = now() where id = $1`,
      [created!.id],
    )

    const skipped = await engine.migrate(ledger.name, MIGRATION, toCollection, {
      caseIds: [created!.id],
    })
    expect(skipped.scanned).toBe(0)

    const included = await engine.migrate(
      ledger.name,
      MIGRATION,
      toCollection,
      {
        caseIds: [created!.id],
        includeEnded: true,
      },
    )
    expect(included).toMatchObject({ scanned: 1, migrated: 1 })
  })

  it('validates its own arguments loudly', async () => {
    await expect(engine.migrate(ledger.name, '', toCollection)).rejects.toThrow(
      /non-empty name/,
    )
    await expect(
      engine.migrate(ledger.name, 'x', 'not a function' as never),
    ).rejects.toThrow(/must be a function/)
  })
})

import { randomUUID } from 'node:crypto'
import { testPool } from '@affordance/testkit'
import { beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  bootstrap,
  CaseNotFoundError,
  CaseStateValidationError,
  FRAMEWORK_SCHEMA,
  insertCase,
  selectCase,
} from '../../src/store/index.js'

// House-purchase-shaped Case State schema. `termsVersion` and `buyers` carry defaults,
// so creating a case proves the schema *output* is what gets materialized.
const PurchaseState = z.object({
  address: z.string(),
  target: z.number().positive(),
  termsVersion: z.number().int().default(1),
  buyers: z
    .array(z.object({ id: z.string(), committed: z.number().nonnegative() }))
    .default([]),
})

// Unique Case Type name per run so assertions never collide with rows left by
// earlier runs or by a concurrent suite (the framework schema is never dropped).
const caseTypeName = `house-purchase-test-${randomUUID()}`

const pool = testPool()

beforeAll(async () => {
  await bootstrap(pool)
})

describe('bootstrap', () => {
  it('is idempotent and safe to run concurrently', async () => {
    await Promise.all([bootstrap(pool), bootstrap(pool), bootstrap(pool)])
    await bootstrap(pool)
    const res = await pool.query(
      `select count(*) from ${FRAMEWORK_SCHEMA}.cases`,
    )
    expect(res.rows).toHaveLength(1)
  })
})

describe('case store', () => {
  it('creates and loads a case with a typed state document round-tripping through Postgres', async () => {
    const created = await insertCase(pool, caseTypeName, PurchaseState, {
      address: '12 Mochi Lane',
      target: 5_000_000,
      // termsVersion and buyers omitted — defaults must be materialized
    })

    expect(created.id).toMatch(
      /^case:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(created.caseTypeName).toBe(caseTypeName)
    expect(created.seq).toBe(0)
    expect(created.endedAt).toBeNull()
    expect(created.createdAt).toBeInstanceOf(Date)
    expect(created.updatedAt).toBeInstanceOf(Date)
    expect(created.state).toEqual({
      address: '12 Mochi Lane',
      target: 5_000_000,
      termsVersion: 1,
      buyers: [],
    })

    const loaded = await selectCase(pool, created.id, PurchaseState)
    expect(loaded.id).toBe(created.id)
    expect(loaded.caseTypeName).toBe(caseTypeName)
    expect(loaded.state).toEqual(created.state)
    expect(loaded.seq).toBe(0)
    expect(loaded.endedAt).toBeNull()

    // typed handle: state is the schema output type
    expect(loaded.state.buyers.length).toBe(0)
    expect(loaded.state.termsVersion + 1).toBe(2)
  })

  it('rejects initial state that fails schema validation and persists nothing', async () => {
    const rejectedType = `${caseTypeName}-rejected`
    const invalid = { address: 42, target: -5 } as unknown as z.input<
      typeof PurchaseState
    >

    const error = await insertCase(
      pool,
      rejectedType,
      PurchaseState,
      invalid,
    ).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(CaseStateValidationError)
    expect((error as CaseStateValidationError).issues.length).toBeGreaterThan(0)

    const res = await pool.query<{ count: string }>(
      `select count(*) as count from ${FRAMEWORK_SCHEMA}.cases where case_type = $1`,
      [rejectedType],
    )
    expect(Number(res.rows[0]?.count)).toBe(0)
  })

  it('rejects stored state that no longer satisfies the provided schema on load', async () => {
    const created = await insertCase(pool, caseTypeName, PurchaseState, {
      address: 'Schema drift house',
      target: 1_000_000,
    })
    const Incompatible = z.object({ address: z.string(), closedAt: z.string() })
    await expect(
      selectCase(pool, created.id, Incompatible),
    ).rejects.toBeInstanceOf(CaseStateValidationError)
  })

  it('throws CaseNotFoundError for an unknown case id', async () => {
    await expect(
      selectCase(pool, randomUUID(), PurchaseState),
    ).rejects.toBeInstanceOf(CaseNotFoundError)
  })

  it('concurrent loads see a consistent sequence counter', async () => {
    const created = await insertCase(pool, caseTypeName, PurchaseState, {
      address: 'Concurrent house',
      target: 2_500_000,
      buyers: [{ id: 'buyer_007', committed: 250_000 }],
    })
    expect(created.seq).toBe(0)

    // 12 parallel loads over a 10-connection pool: every handle must report
    // the same, correctly-initialized counter.
    const loads = await Promise.all(
      Array.from({ length: 12 }, () =>
        selectCase(pool, created.id, PurchaseState),
      ),
    )
    expect(new Set(loads.map((h) => h.seq)).size).toBe(1)
    expect(loads.every((h) => h.seq === 0)).toBe(true)

    // Bumping seq belongs to the execution lifecycle; a direct SQL
    // update stands in for it to prove parallel reads agree on a committed
    // counter value, not just on the initial zero.
    await pool.query(
      `update ${FRAMEWORK_SCHEMA}.cases set seq = 41 where id = $1`,
      [created.id],
    )
    const reloads = await Promise.all(
      Array.from({ length: 12 }, () =>
        selectCase(pool, created.id, PurchaseState),
      ),
    )
    expect(new Set(reloads.map((h) => h.seq)).size).toBe(1)
    expect(reloads.every((h) => h.seq === 41)).toBe(true)
  })
})

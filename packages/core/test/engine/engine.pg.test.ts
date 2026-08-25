import { randomUUID } from 'node:crypto'
import { expectJsonRoundTrips, testPool } from '@affordance/testkit'
import { describe, expect, it } from 'vitest'
import {
  computeAffordances,
  createEngine,
  UnknownCaseTypeError,
} from '../../src/engine/index.js'
import {
  CaseNotFoundError,
  CaseStateValidationError,
  FRAMEWORK_SCHEMA,
  insertCase,
} from '../../src/store/index.js'
import {
  asOf,
  housePurchase,
  organizer,
  PurchaseState,
  readyState,
} from './fixture.js'

const pool = testPool({ max: 5 })
const engine = createEngine({ db: { pool }, caseTypes: [housePurchase] })

describe('engine round-trip through Postgres', () => {
  it('createCase via the store, then affordances(caseId, actor) — and it matches the pure computation', async () => {
    const created = await insertCase(
      pool,
      housePurchase.name,
      PurchaseState,
      readyState(),
    )

    const record = await engine.affordances(created.id, organizer, asOf)
    expect(record.caseId).toBe(created.id)
    expect(record.caseTypeName).toBe('house-purchase')
    expect(record.endedAt).toBeNull()
    expect(record.affordances).toContainEqual({ step: 'issue-funding-call' })

    // the engine is exactly the store-bound pure computation
    const pure = computeAffordances(
      housePurchase,
      { id: created.id, state: created.state, endedAt: null },
      { actor: organizer, asOf },
    )
    expect(record).toEqual(pure)

    // …and computing from the handle in hand — no reload — is the same answer
    expect(engine.affordancesOf(created, organizer, asOf)).toEqual(record)
    expectJsonRoundTrips(record)
  })

  it('asOf defaults to now at the engine boundary', async () => {
    const created = await insertCase(
      pool,
      housePurchase.name,
      PurchaseState,
      readyState(),
    )
    const before = Date.now()
    const record = await engine.affordances(created.id, organizer)
    const after = Date.now()
    const evaluatedAt = Date.parse(record.asOf)
    expect(evaluatedAt).toBeGreaterThanOrEqual(before)
    expect(evaluatedAt).toBeLessThanOrEqual(after)
  })

  it('explain reaches through the store to one step, scoped or not', async () => {
    const state = readyState()
    state.purchase.termsVersion = 2 // mid-purchase amendment: buyer_a and buyer_b signed v1
    const created = await insertCase(
      pool,
      housePurchase.name,
      PurchaseState,
      state,
    )

    const explanation = await engine.explain(created.id, 'request-re-sign', {
      scopeKey: 'buyer_a',
      actor: organizer,
      asOf,
    })
    expect(explanation.caseId).toBe(created.id)
    expect(explanation.scopeKey).toBe('buyer_a')
    expect(explanation.evaluation.available).toBe(true)
  })

  it('explain without an actor probes requires; permits conditions say they were not evaluated', async () => {
    const created = await insertCase(
      pool,
      housePurchase.name,
      PurchaseState,
      readyState(),
    )
    const explanation = await engine.explain(created.id, 'issue-funding-call', {
      asOf,
    })
    expect(explanation.evaluation.possible).toBe(true)
    expect(explanation.evaluation.permitted).toBe(false)
    const permitsResult = explanation.evaluation.conditions.find(
      (c) => c.name === 'isOrganizer',
    )
    // A stated answer, not a leaked TypeError: the condition was never run,
    // and the reason says so in the contract's own words.
    expect(permitsResult).toMatchObject({
      passed: false,
      reason: 'not evaluated: no actor supplied',
    })
  })

  it('a dormant (ended) case still answers, with dormancy annotated', async () => {
    const created = await insertCase(
      pool,
      housePurchase.name,
      PurchaseState,
      readyState(),
    )
    await pool.query(
      `update ${FRAMEWORK_SCHEMA}.cases set ended_at = '2026-08-04T00:00:00Z' where id = $1`,
      [created.id],
    )
    const record = await engine.affordances(created.id, organizer, asOf)
    expect(record.endedAt).toBe('2026-08-04T00:00:00.000Z')
    expect(record.affordances.length).toBeGreaterThan(0)
  })

  it('an unknown case id propagates the store error', async () => {
    await expect(
      engine.affordances(randomUUID(), organizer),
    ).rejects.toBeInstanceOf(CaseNotFoundError)
  })

  it('a case whose type is not registered fails with UnknownCaseTypeError', async () => {
    const created = await insertCase(
      pool,
      `unregistered-${randomUUID()}`,
      PurchaseState,
      readyState(),
    )
    await expect(
      engine.affordances(created.id, organizer),
    ).rejects.toBeInstanceOf(UnknownCaseTypeError)
  })

  it('stored state that no longer satisfies the registered schema fails loudly on load', async () => {
    const created = await insertCase(
      pool,
      housePurchase.name,
      PurchaseState,
      readyState(),
    )
    await pool.query(
      `update ${FRAMEWORK_SCHEMA}.cases set state = '{"drifted": true}'::jsonb where id = $1`,
      [created.id],
    )
    await expect(
      engine.affordances(created.id, organizer),
    ).rejects.toBeInstanceOf(CaseStateValidationError)
  })
})

describe('createEngine validation', () => {
  it('rejects duplicate case type names at construction', () => {
    expect(() =>
      createEngine({ db: { pool }, caseTypes: [housePurchase, housePurchase] }),
    ).toThrow(/duplicate case type name 'house-purchase'/)
  })
})

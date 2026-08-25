/**
 * Case resolution: the one place a case row becomes a Case Type definition
 * plus a Case State that can be trusted.
 *
 * The interesting assertions are about the *lenient/loud* split, because that
 * is the policy four call sites used to each decide for themselves: a claim
 * and an `affordances` read owe their caller an answer about a named case, so
 * an unreadable document is loud; a migration scan must not
 * be taken down by one unreadable case, so it is a skip.
 */

import { randomUUID } from 'node:crypto'
import { testPool } from '@affordance/testkit'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { UnknownCaseTypeError } from '../../src/engine/index.js'
import { withTransaction } from '../../src/execution/index.js'
import { caseType, step } from '../../src/model/index.js'
import {
  CaseNotFoundError,
  CaseStateValidationError,
  insertCase,
  resolveCase,
  resolveCaseForUpdate,
  resolveStoredState,
  validateCaseState,
} from '../../src/store/index.js'

const pool = testPool({ max: 5 })

const State = z.object({
  address: z.string(),
  closed: z.boolean().default(false),
})

const purchase = caseType({
  name: `resolve-test-${randomUUID()}`,
  state: State,
  steps: [
    step({
      name: 'close',
      handler: async (s: z.infer<typeof State>) => ({ ...s, closed: true }),
    }),
  ],
})

const registry =
  (definition = purchase) =>
  (name: string) => {
    if (name !== definition.name)
      throw new UnknownCaseTypeError(name, [definition.name])
    return definition
  }

const createCase = async (
  state: z.input<typeof State> = { address: '12 Mochi Lane' },
): Promise<string> => {
  const handle = await insertCase(pool, purchase.name, purchase.state, state)
  return handle.id
}

describe('resolveCase', () => {
  it('returns the definition, the row and the validated state together', async () => {
    const caseId = await createCase()
    const resolved = await resolveCase(pool, registry(), caseId)

    expect(resolved.definition.name).toBe(purchase.name)
    expect(resolved.handle.id).toBe(caseId)
    // The schema's *output*: `closed` was defaulted in, and is what a
    // condition will read.
    expect(resolved.state).toEqual({ address: '12 Mochi Lane', closed: false })
  })

  it('throws CaseNotFoundError for a case id that does not exist', async () => {
    await expect(resolveCase(pool, registry(), randomUUID())).rejects.toThrow(
      CaseNotFoundError,
    )
  })

  it('throws UnknownCaseTypeError when the row names a type nobody registered', async () => {
    const caseId = await createCase()
    const empty = (name: string): never => {
      throw new UnknownCaseTypeError(name, [])
    }
    await expect(resolveCase(pool, empty, caseId)).rejects.toThrow(
      UnknownCaseTypeError,
    )
  })

  it('is loud about a stored document that no longer satisfies its schema', async () => {
    const caseId = await createCase()
    await pool.query(
      `update affordance.cases set state = $2::jsonb where id = $1`,
      [caseId, JSON.stringify({ address: 42 })],
    )
    await expect(resolveCase(pool, registry(), caseId)).rejects.toThrow(
      CaseStateValidationError,
    )
  })
})

describe('resolveCaseForUpdate', () => {
  it('resolves the same way, inside a transaction holding the case row', async () => {
    const caseId = await createCase({ address: 'Held' })
    const resolved = await withTransaction({ pool }, (tx) =>
      resolveCaseForUpdate(tx, registry(), caseId),
    )
    expect(resolved.state).toEqual({ address: 'Held', closed: false })
  })
})

describe('resolveStoredState', () => {
  it('validates a document already in hand, applying schema defaults', async () => {
    expect(await resolveStoredState(purchase, { address: 'In hand' })).toEqual({
      state: { address: 'In hand', closed: false },
    })
  })

  it('is lenient: null rather than a throw, so one bad case cannot take down a sweep', async () => {
    expect(await resolveStoredState(purchase, { address: 42 })).toBeNull()
    expect(await resolveStoredState(purchase, null)).toBeNull()
  })

  it('wraps the state, so a Case State that legitimately is null is not read as a failure', async () => {
    const nullable = caseType({
      name: `resolve-nullable-${randomUUID()}`,
      state: z.null(),
      steps: [],
    })
    expect(await resolveStoredState(nullable, null)).toEqual({ state: null })
  })
})

describe('validateCaseState', () => {
  it('names what was being validated in the error, so a handler’s return is distinguishable', async () => {
    await expect(
      validateCaseState(
        purchase,
        { address: 42 },
        "state returned by step 'close'",
      ),
    ).rejects.toThrow(/state returned by step 'close'/)
    await expect(validateCaseState(purchase, { address: 42 })).rejects.toThrow(
      /stored state/,
    )
  })
})

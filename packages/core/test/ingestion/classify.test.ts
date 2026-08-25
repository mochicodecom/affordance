/**
 * The dead-letter projection and the reopen policy — no database.
 *
 * A framework Refusal names its own kind at the raise site; ingestion's
 * reason is that code, projected, never re-derived by `instanceof`. The
 * policy over the codes is data, so these tests are tables.
 */

import { describe, expect, it } from 'vitest'
import { AffordanceError, type AffordanceErrorCode } from '../../src/errors.js'
import { ClaimLostError, settleSystemRun } from '../../src/execution/index.js'
import {
  classifyDeadLetter,
  type DeadLetterReason,
  REOPENS_ON_REDELIVERY,
} from '../../src/ingestion/index.js'

/** What ingestion actually does with a throw: settle it, then project it. */
const classify = (error: unknown): [DeadLetterReason, string] =>
  classifyDeadLetter(settleSystemRun(error))

const CODES: readonly AffordanceErrorCode[] = [
  'step-not-available',
  'case-busy',
  'invalid-input',
  'not-found',
  'bad-request',
  'execution-failed',
  'invalid-state',
]

describe('classifyDeadLetter', () => {
  it('projects every code straight through, with the error’s own message as detail', () => {
    for (const code of CODES) {
      const error = new AffordanceError(code, `what a ${code} refusal says`)
      expect(classify(error)).toEqual([code, `what a ${code} refusal says`])
    }
  })

  it('classifies a lost claim as case-busy — the code it declares, not the class it is', () => {
    // The regression the instanceof ladder had: ClaimLostError is not a
    // CaseBusyError, but its raise site declared 'case-busy', and that is
    // the answer — "not now", eligible for the provider's next retry.
    const [reason, detail] = classify(
      new ClaimLostError('case:1', 'exec:1', null),
    )
    expect(reason).toBe('case-busy')
    expect(detail).toMatch(/lost its claim/)
  })

  it('keeps a bug as execution-failed — dead-lettered, never dropped', () => {
    expect(classify(new Error('TypeError: cannot read x'))).toEqual([
      'execution-failed',
      'TypeError: cannot read x',
    ])
    expect(classify('unhelpful string throw')).toEqual([
      'execution-failed',
      'unhelpful string throw',
    ])
  })
})

describe('REOPENS_ON_REDELIVERY', () => {
  it('reopens exactly the outcomes another delivery could cure', () => {
    const reopenable = (
      Object.keys(REOPENS_ON_REDELIVERY) as DeadLetterReason[]
    )
      .filter((reason) => REOPENS_ON_REDELIVERY[reason])
      .sort()
    expect(reopenable).toEqual(['case-busy', 'execution-failed'])
  })
})

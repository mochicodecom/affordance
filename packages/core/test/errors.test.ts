/**
 * The error taxonomy.
 *
 * The point of the code is that an adapter never has to be told about a new
 * error class. That only holds if *every* deliberate refusal carries one, so
 * this suite enumerates them — a new class that forgets to extend
 * `AffordanceError` fails here rather than in production as an unmapped 500.
 */

import { describe, expect, it } from 'vitest'
import {
  AffordanceError,
  type AffordanceErrorCode,
  CaseNotFoundError,
  CaseStateValidationError,
  type GuardEvaluation,
  isAffordanceError,
  ScopeKeyError,
  StepInputValidationError,
  StepNotAvailableError,
  UnknownCaseTypeError,
  UnknownStepError,
} from '../src/index.js'

const evaluation: GuardEvaluation = {
  asOf: '2026-08-05T00:00:00.000Z',
  possible: false,
  permitted: true,
  available: false,
  conditions: [
    {
      name: 'escrowReady',
      section: 'requires',
      kind: 'condition',
      passed: false,
      reason: 'no account',
    },
  ],
}

/** Every error the framework raises deliberately, with the code it must carry. */
const taxonomy: readonly [string, AffordanceError, AffordanceErrorCode][] = [
  [
    'StepNotAvailableError',
    new StepNotAvailableError('c1', 'close', null, evaluation),
    'step-not-available',
  ],
  [
    'StepInputValidationError',
    new StepInputValidationError('close', [{ message: 'required' }]),
    'invalid-input',
  ],
  ['CaseNotFoundError', new CaseNotFoundError('c1'), 'not-found'],
  [
    'UnknownCaseTypeError',
    new UnknownCaseTypeError('purchase', []),
    'not-found',
  ],
  [
    'CaseStateValidationError',
    new CaseStateValidationError('stored state', [{ message: 'bad' }]),
    'invalid-state',
  ],
  [
    'UnknownStepError',
    new UnknownStepError('purchase', 'nope', ['close']),
    'bad-request',
  ],
  [
    'ScopeKeyError',
    new ScopeKeyError('escalate', 'buyer_7', 'no such element'),
    'bad-request',
  ],
]

describe('the error taxonomy', () => {
  it.each(taxonomy)(
    '%s is an AffordanceError carrying code %s',
    (_name, error, code) => {
      expect(error).toBeInstanceOf(AffordanceError)
      expect(isAffordanceError(error)).toBe(true)
      expect(error.code).toBe(code)
    },
  )

  it.each(taxonomy)(
    '%s keeps its own name, so instanceof branching still reads',
    (name, error) => {
      expect(error.name).toBe(name)
    },
  )

  it.each(taxonomy)('%s says something in its message', (_name, error) => {
    expect(error.message.length).toBeGreaterThan(0)
  })

  it('covers every code in the taxonomy — a code nothing raises is a contract with no meaning', () => {
    const codes: readonly AffordanceErrorCode[] = [
      'step-not-available',

      'invalid-input',
      'not-found',
      'bad-request',
      'invalid-state',
    ]
    expect(new Set(taxonomy.map(([, , code]) => code))).toEqual(new Set(codes))
  })

  it('does not claim an ordinary bug — those are for the edge to rethrow, not to answer with', () => {
    expect(isAffordanceError(new Error('a bug'))).toBe(false)
    expect(isAffordanceError(new TypeError('a definition bug'))).toBe(false)
    expect(isAffordanceError('not even an error')).toBe(false)
  })

  it('keeps `cause` intact where a class passes one through', () => {
    const boom = new Error('boom')
    expect(
      new AffordanceError('bad-request', 'refused', { cause: boom }).cause,
    ).toBe(boom)
  })
})

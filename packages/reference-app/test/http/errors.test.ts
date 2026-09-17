/**
 * The adapter's error mapping, tested without a database.
 *
 * Framework refusals and indeterminate commits preserve their structured
 * meaning across the HTTP boundary.
 *
 * A stub engine is all this needs: the adapter's whole job here is to
 * translate what the engine threw.
 */

import {
  type AffordanceError,
  CaseNotFoundError,
  CaseStateValidationError,
  type GuardEvaluation,
  ScopeKeyError,
  StepInputValidationError,
  StepNotAvailableError,
  UnknownCaseTypeError,
  UnknownStepError,
} from '@affordance/core'
import { describe, expect, it } from 'vitest'
import { createAffordanceApi, type EnginePort } from '../../src/http/index.js'
import { stubEnginePort } from './fixture.js'

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

/** An engine port that does nothing but throw what the test hands it from `execute` — the one route this suite drives. */
const throwing = (error: unknown): EnginePort =>
  stubEnginePort({ run: () => Promise.reject(error) })

const execute = async (
  error: unknown,
): Promise<{ status: number; body: any }> => {
  const api = createAffordanceApi({ engine: throwing(error) })
  const response = await api.handle({
    method: 'POST',
    path: '/cases/c1/steps/close',
    actor: { id: 'ops-1' },
  })
  return { status: response.status, body: response.body as any }
}

const cases: readonly [string, AffordanceError, number, string][] = [
  [
    'StepNotAvailableError',
    new StepNotAvailableError('c1', 'close', null, evaluation),
    409,
    'step-not-available',
  ],
  [
    'StepInputValidationError',
    new StepInputValidationError('close', [{ message: 'required' }]),
    422,
    'invalid-input',
  ],
  ['CaseNotFoundError', new CaseNotFoundError('c1'), 404, 'not-found'],
  [
    'UnknownCaseTypeError',
    new UnknownCaseTypeError('purchase', []),
    404,
    'not-found',
  ],
  [
    'UnknownStepError',
    new UnknownStepError('purchase', 'nope', ['close']),
    400,
    'bad-request',
  ],
  [
    'ScopeKeyError',
    new ScopeKeyError('escalate', 'buyer_7', 'no such element'),
    400,
    'bad-request',
  ],
  [
    'CaseStateValidationError',
    new CaseStateValidationError('stored state', [{ message: 'bad' }]),
    500,
    'invalid-state',
  ],
]

describe('framework errors on the wire', () => {
  it.each(cases)(
    '$0 answers with its code and status',
    async (name, error, status, code) => {
      const response = await execute(error)
      expect({
        name,
        status: response.status,
        code: response.body.error,
      }).toEqual({
        name,
        status,
        code,
      })
      expect(response.body.contract).toBe('affordance/v2')
    },
  )

  it('carries the unmet conditions on a refusal', async () => {
    const { body } = await execute(
      new StepNotAvailableError('c1', 'close', null, evaluation),
    )
    expect(body.possible).toBe(false)
    expect(body.permitted).toBe(true)
    expect(body.unmet.map((c: { name: string }) => c.name)).toEqual([
      'escrowReady',
    ])
  })

  it('carries the schema issues on an invalid input', async () => {
    const { body } = await execute(
      new StepInputValidationError('close', [{ message: 'required' }]),
    )
    expect(body.issues).toEqual([{ message: 'required' }])
  })

  it('rethrows anything that is not a framework refusal — a bug is not an answer', async () => {
    await expect(execute(new Error('the database is gone'))).rejects.toThrow(
      'the database is gone',
    )
    await expect(execute(new TypeError('a definition bug'))).rejects.toThrow(
      TypeError,
    )
  })
})

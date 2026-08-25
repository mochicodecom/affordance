/**
 * The adapter's error mapping, tested without a database.
 *
 * The mapping used to be an `instanceof` ladder over nine error classes drawn
 * from four core modules, and nothing forced it to stay exhaustive: a tenth
 * class fell through to a rethrow, which the binding surfaces as a 500 with
 * no contract payload. Now the framework declares the *kind* and the adapter
 * declares the *status*, so the interesting test is that every kind gets an
 * answer — including `ClaimLostError`, which the ladder never named.
 *
 * A stub engine is all this needs: the adapter's whole job here is to
 * translate what the engine threw.
 */

import {
  type AffordanceError,
  CaseBusyError,
  CaseNotFoundError,
  CaseStateValidationError,
  ClaimLostError,
  type GuardEvaluation,
  ScopeKeyError,
  StepExecutionError,
  StepInputValidationError,
  StepNotAvailableError,
  UnknownCaseTypeError,
  UnknownStepError,
} from '@affordance/core'
import { describe, expect, it } from 'vitest'
import { createAffordanceApi, type EnginePort } from '../src/index.js'
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
  stubEnginePort({ execute: () => Promise.reject(error) })

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
    'CaseBusyError',
    new CaseBusyError('c1', {
      executionId: 'e1',
      stepName: 'close',
      scopeKey: null,
      expiresAt: '2026-08-05T00:00:30.000Z',
    }),
    409,
    'case-busy',
  ],
  // Never named by the old ladder: it fell through to a rethrow, and the
  // binding turned a lost claim into an unhandled 500.
  ['ClaimLostError', new ClaimLostError('c1', 'e1', 'e2'), 409, 'case-busy'],
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
    'StepExecutionError',
    new StepExecutionError('c1', 'e1', 'close', null, 3, new Error('boom')),
    500,
    'execution-failed',
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
      expect(response.body.contract).toBe('affordance/v1')
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

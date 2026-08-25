import { expectJsonRoundTrips } from '@affordance/testkit'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  type AffordanceExplanation,
  computeExplanation,
  explainContext,
} from '../../src/engine/index.js'
import {
  NO_ACTOR,
  NOT_EVALUATED_REASON,
  unmetConditions,
} from '../../src/guards/index.js'
import {
  caseType,
  SCOPE_FAILURE_CONDITION,
  ScopeKeyError,
  step,
  UnknownStepError,
} from '../../src/model/index.js'
import {
  amendmentState,
  asOf,
  buyerActor,
  escrowOfficer,
  handlerRuns,
  housePurchase,
  organizer,
  type Purchase,
  type PurchaseActor,
  readyState,
  snapshot,
  verificationState,
} from './fixture.js'

// The fixture default (`organizer`) is this helper's own; the *rule* the
// request passes through is the production one — explainContext, verbatim —
// so what these tests prove holds for what the engine actually runs.
const explain = (
  state: Purchase,
  stepName: string,
  options: { scopeKey?: string; actor?: PurchaseActor; at?: string } = {},
): AffordanceExplanation =>
  computeExplanation(
    housePurchase,
    snapshot(state),
    stepName,
    explainContext(
      {
        actor: options.actor ?? organizer,
        ...(options.at !== undefined && { asOf: options.at }),
        ...(options.scopeKey !== undefined && { scopeKey: options.scopeKey }),
      },
      () => asOf,
    ),
  )

const failedNames = (explanation: AffordanceExplanation): string[] =>
  unmetConditions(explanation.evaluation).map((c) => c.name)

describe('explain on unscoped steps', () => {
  it('a blocked step names exactly the unmet conditions, with full per-condition results', () => {
    const state = readyState()
    state.escrow = { status: 'opening' }
    state.split = { confirmed: false }
    const explanation = explain(state, 'issue-funding-call')
    expect(explanation.step).toBe('issue-funding-call')
    expect(explanation.scopeKey).toBeUndefined()
    expect(explanation.evaluation.possible).toBe(false)
    expect(explanation.evaluation.permitted).toBe(true)
    expect(explanation.evaluation.available).toBe(false)
    expect(failedNames(explanation)).toEqual(['splitFinal', 'escrowReady'])
    // the full record includes the passing conditions too
    expect(explanation.evaluation.conditions.map((c) => c.name)).toEqual([
      'splitFinal',
      'committedEnough',
      'escrowReady',
      'isOrganizer',
    ])
  })

  it('distinguishes not-permitted-for-this-actor from not-possible', () => {
    const forBuyer = explain(readyState(), 'issue-funding-call', {
      actor: buyerActor,
    })
    expect(forBuyer.evaluation.possible).toBe(true)
    expect(forBuyer.evaluation.permitted).toBe(false)
    expect(failedNames(forBuyer)).toEqual(['isOrganizer'])

    const forOps = explain(readyState(), 'issue-funding-call')
    expect(forOps.evaluation.available).toBe(true)
    expect(failedNames(forOps)).toEqual([])
  })

  it('carries the case metadata alongside the evaluation', () => {
    const explanation = explain(readyState(), 'issue-funding-call')
    expect(explanation).toMatchObject({
      caseId: 'case-under-test',
      caseTypeName: 'house-purchase',
      asOf,
      endedAt: null,
    })
    expect('complete' in explanation).toBe(false)
  })
})

describe('explain on scoped steps', () => {
  it('binds the element by scope key and evaluates its conditions against it', () => {
    const blocked = explain(amendmentState(), 'request-re-sign', {
      scopeKey: 'buyer_b',
    })
    expect(blocked.scopeKey).toBe('buyer_b')
    expect(blocked.evaluation.possible).toBe(false)
    expect(failedNames(blocked)).toEqual(['onPriorTerms'])

    const available = explain(amendmentState(), 'request-re-sign', {
      scopeKey: 'buyer_a',
    })
    expect(available.evaluation.available).toBe(true)
  })

  it('surfaces per-element condition results: flagged vs unflagged reviews', () => {
    const unflagged = explain(verificationState(), 'escalate-verification', {
      scopeKey: 'buyer_b',
      actor: escrowOfficer,
    })
    expect(unflagged.evaluation.conditions[0]).toMatchObject({
      name: 'flagged',
      kind: 'condition',
      passed: false,
      reason: 'the review carries no flag to escalate',
    })

    const flagged = explain(verificationState(), 'escalate-verification', {
      scopeKey: 'buyer_a',
      actor: escrowOfficer,
    })
    expect(flagged.evaluation.conditions[0]).toMatchObject({
      name: 'flagged',
      passed: true,
    })
    expect(flagged.evaluation.available).toBe(true)
  })

  it('the explanation record survives a JSON round-trip unchanged', () => {
    const explanation = explain(verificationState(), 'escalate-verification', {
      scopeKey: 'buyer_d',
      actor: escrowOfficer,
    })
    expectJsonRoundTrips(explanation)
  })
})

describe('explain is loud about bad addresses', () => {
  it('an unknown step names the case type and lists its steps', () => {
    expect(() => explain(readyState(), 'wire-funds')).toThrow(UnknownStepError)
    expect(() => explain(readyState(), 'wire-funds')).toThrow(
      /case type 'house-purchase' has no step 'wire-funds' — steps: issue-funding-call, request-re-sign, escalate-verification/,
    )
  })

  it('a scoped step without a scope key lists the currently-selected keys', () => {
    expect(() => explain(amendmentState(), 'request-re-sign')).toThrow(
      ScopeKeyError,
    )
    expect(() => explain(amendmentState(), 'request-re-sign')).toThrow(
      /a scopeKey is required — currently selected: buyer_a, buyer_b/,
    )
  })

  it('an unknown scope key lists the currently-selected keys', () => {
    expect(() =>
      explain(amendmentState(), 'request-re-sign', { scopeKey: 'buyer_z' }),
    ).toThrow(
      /no element in scope has key 'buyer_z' — currently selected: buyer_a, buyer_b/,
    )
  })

  it('a scope key on an unscoped step is rejected', () => {
    expect(() =>
      explain(readyState(), 'issue-funding-call', { scopeKey: 'buyer_a' }),
    ).toThrow(/scope key 'buyer_a' given, but the step is not scoped/)
  })
})

describe('explain answers a defective selector — the listing published this exact link', () => {
  const Broken = z.object({
    items: z.array(z.object({ id: z.string() })).default([]),
  })
  type BrokenState = z.output<typeof Broken>
  const brokenType = caseType({
    name: 'broken-scope',
    state: Broken,
    steps: [
      step({
        name: 'explode',
        scope: {
          select: (_s: BrokenState): readonly { id: string }[] => {
            throw new Error('selector bug')
          },
          key: (i) => i.id,
        },
        handler: async (state) => state,
      }),
    ],
  })

  it('returns the $scope failure as the explanation, in the shape the listing reported it', () => {
    // The blocked entry for a defective selector carries no scopeKey, and its
    // explain link is followed without one — the answer is the failure, not a 400.
    const explanation = computeExplanation(
      brokenType,
      { id: 'x', state: Broken.parse({}), endedAt: null },
      'explode',
      { actor: organizer, asOf },
    )
    expect(explanation.step).toBe('explode')
    expect(explanation.scopeKey).toBeUndefined()
    expect(explanation.evaluation).toEqual({
      asOf,
      possible: false,
      permitted: true,
      available: false,
      conditions: [
        {
          name: SCOPE_FAILURE_CONDITION,
          section: 'requires',
          kind: 'condition',
          passed: false,
          reason: 'scope selector threw: selector bug',
        },
      ],
    })
  })

  it('answers the same way when a scope key was supplied — the selector failing is the whole story', () => {
    const explanation = computeExplanation(
      brokenType,
      { id: 'x', state: Broken.parse({}), endedAt: null },
      'explode',
      { actor: organizer, asOf, scopeKey: 'anything' },
    )
    expect(explanation.evaluation.conditions[0]).toMatchObject({
      name: SCOPE_FAILURE_CONDITION,
      passed: false,
    })
  })
})

describe('explainContext — the boundary’s one normalization, tested as a value', () => {
  const clock = () => asOf

  it('an absent actor key means the requires-only probe', () => {
    expect(explainContext({}, clock).actor).toBe(NO_ACTOR)
  })

  it('a present-but-undefined actor is an actor, not the probe', () => {
    const ctx = explainContext({ actor: undefined }, clock)
    expect('actor' in ctx).toBe(true)
    expect(ctx.actor).toBeUndefined()
    expect(ctx.actor).not.toBe(NO_ACTOR)
  })

  it('asOf defaults through the clock, and only when absent', () => {
    expect(explainContext({}, clock).asOf).toBe(asOf)
    expect(
      explainContext({ asOf: '2026-01-01T00:00:00.000Z' }, clock).asOf,
    ).toBe('2026-01-01T00:00:00.000Z')
  })

  it('an ungiven scopeKey stays an absent key, never an undefined value', () => {
    expect('scopeKey' in explainContext({}, clock)).toBe(false)
    expect(explainContext({ scopeKey: 'buyer_a' }, clock).scopeKey).toBe(
      'buyer_a',
    )
  })

  it('the probe flows through to the evaluation: permits reported un-evaluated', () => {
    const probe = computeExplanation(
      housePurchase,
      snapshot(readyState()),
      'issue-funding-call',
      explainContext({}, clock),
    )
    expect(probe.evaluation.possible).toBe(true)
    expect(
      probe.evaluation.conditions.find((c) => c.name === 'isOrganizer'),
    ).toMatchObject({
      passed: false,
      reason: NOT_EVALUATED_REASON,
    })
  })
})

describe('execution boundary', () => {
  it('explanation never invokes a handler (execution is a separate concern)', () => {
    explain(readyState(), 'issue-funding-call')
    explain(amendmentState(), 'request-re-sign', { scopeKey: 'buyer_a' })
    expect(handlerRuns.count).toBe(0)
  })
})

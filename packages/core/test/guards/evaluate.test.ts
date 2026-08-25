import { expectJsonRoundTrips } from '@affordance/testkit'
import { describe, expect, it } from 'vitest'
import {
  anyOf,
  type Condition,
  type ConditionResult,
  evaluateGuard,
  type Guard,
  type GuardEvaluation,
  unmetConditions,
} from '../../src/guards/index.js'

interface PurchaseState {
  split?: { confirmed?: boolean }
  escrow?: { status?: 'opening' | 'open' }
  buyer?: { preApproved?: boolean; proofOfFunds?: boolean }
  wire?: { amount?: number; expected?: number }
  verification?: { flaggedAt?: string }
}

interface PurchaseActor {
  roles: readonly string[]
}

const organizer: PurchaseActor = { roles: ['organizer'] }
const outsider: PurchaseActor = { roles: ['buyer'] }
const asOf = '2026-08-05T12:00:00.000Z'

const ctx = (state: PurchaseState, actor: PurchaseActor = organizer) => ({
  state,
  actor,
  asOf,
})

const resultNamed = (
  evaluation: GuardEvaluation,
  name: string,
): ConditionResult => {
  const found = evaluation.conditions.find((c) => c.name === name)
  if (!found) throw new Error(`no condition result named '${name}'`)
  return found
}

const failedNames = (evaluation: GuardEvaluation): string[] =>
  unmetConditions(evaluation).map((c) => c.name)

const issueFundingCall: Guard<PurchaseState, PurchaseActor> = {
  requires: {
    splitFinal: (s) => s.split?.confirmed ?? false,
    escrowReady: (s) => (s.escrow?.status ?? 'opening') === 'open',
  },
  permits: {
    isOrganizer: (_s, c) => c.actor.roles.includes('organizer'),
  },
}

const readyState: PurchaseState = {
  split: { confirmed: true },
  escrow: { status: 'open' },
}

describe('AND-map evaluation', () => {
  it('is available when every named condition holds', () => {
    const evaluation = evaluateGuard(issueFundingCall, ctx(readyState))
    expect(evaluation.available).toBe(true)
    expect(evaluation.possible).toBe(true)
    expect(evaluation.permitted).toBe(true)
    expect(failedNames(evaluation)).toEqual([])
    expect(evaluation.conditions.map((c) => [c.name, c.section])).toEqual([
      ['splitFinal', 'requires'],
      ['escrowReady', 'requires'],
      ['isOrganizer', 'permits'],
    ])
  })

  it('one failing condition makes the guard unavailable and names exactly that condition', () => {
    const evaluation = evaluateGuard(
      issueFundingCall,
      ctx({ split: { confirmed: true }, escrow: { status: 'opening' } }),
    )
    expect(evaluation.available).toBe(false)
    expect(failedNames(evaluation)).toEqual(['escrowReady'])
    expect(resultNamed(evaluation, 'escrowReady')).toMatchObject({
      section: 'requires',
      kind: 'condition',
      passed: false,
    })
    expect(resultNamed(evaluation, 'splitFinal').passed).toBe(true)
  })

  it('an empty guard is vacuously available', () => {
    const evaluation = evaluateGuard<PurchaseState, PurchaseActor>({}, ctx({}))
    expect(evaluation).toMatchObject({
      available: true,
      possible: true,
      permitted: true,
      conditions: [],
    })
  })
})

describe('requires vs permits split', () => {
  it('an unmet requires condition means not possible, even though the actor is permitted', () => {
    const evaluation = evaluateGuard(issueFundingCall, ctx({}, organizer))
    expect(evaluation.possible).toBe(false)
    expect(evaluation.permitted).toBe(true)
    expect(evaluation.available).toBe(false)
  })

  it('an unmet permits condition means possible but not permitted for this actor', () => {
    const evaluation = evaluateGuard(
      issueFundingCall,
      ctx(readyState, outsider),
    )
    expect(evaluation.possible).toBe(true)
    expect(evaluation.permitted).toBe(false)
    expect(evaluation.available).toBe(false)
    expect(resultNamed(evaluation, 'isOrganizer')).toMatchObject({
      section: 'permits',
      passed: false,
    })
  })

  it('records which section every result came from', () => {
    const evaluation = evaluateGuard(issueFundingCall, ctx({}, outsider))
    expect(evaluation.possible).toBe(false)
    expect(evaluation.permitted).toBe(false)
    expect(resultNamed(evaluation, 'splitFinal').section).toBe('requires')
    expect(resultNamed(evaluation, 'isOrganizer').section).toBe('permits')
  })
})

describe('anyOf groups', () => {
  const financing: Guard<PurchaseState, PurchaseActor> = {
    requires: {
      financing: anyOf<PurchaseState, PurchaseActor>({
        preApproved: (s) => s.buyer?.preApproved ?? false,
        proofOfFunds: (s) => ({
          ok: s.buyer?.proofOfFunds ?? false,
          reason: 'no proof-of-funds letter on file',
        }),
      }),
    },
  }

  it('one passing arm satisfies the group', () => {
    const evaluation = evaluateGuard(
      financing,
      ctx({ buyer: { preApproved: true } }),
    )
    expect(evaluation.available).toBe(true)
    const group = resultNamed(evaluation, 'financing')
    if (group.kind !== 'anyOf') throw new Error('expected an anyOf result')
    expect(group.passed).toBe(true)
    expect(group.arms.map((a) => [a.name, a.passed])).toEqual([
      ['preApproved', true],
      ['proofOfFunds', false],
    ])
  })

  it('all arms failing reports the group with per-arm results', () => {
    const evaluation = evaluateGuard(financing, ctx({ buyer: {} }))
    expect(evaluation.available).toBe(false)
    expect(failedNames(evaluation)).toEqual(['financing'])
    const group = resultNamed(evaluation, 'financing')
    if (group.kind !== 'anyOf') throw new Error('expected an anyOf result')
    expect(group.passed).toBe(false)
    expect(group.arms).toEqual([
      {
        name: 'preApproved',
        section: 'requires',
        kind: 'condition',
        passed: false,
      },
      {
        name: 'proofOfFunds',
        section: 'requires',
        kind: 'condition',
        passed: false,
        reason: 'no proof-of-funds letter on file',
      },
    ])
  })

  it('rejects an empty arms map at definition time', () => {
    expect(() => anyOf({})).toThrow(TypeError)
  })

  it('rejects a nested anyOf group at definition time', () => {
    const inner = anyOf<PurchaseState, PurchaseActor>({ a: () => true })
    expect(() => anyOf({ nested: inner as never })).toThrow(TypeError)
  })
})

describe('escape-hatch verdicts', () => {
  const reconcile: Guard<PurchaseState, PurchaseActor> = {
    requires: {
      wireReconciled: (s) => {
        const amount = s.wire?.amount ?? 0
        const expected = s.wire?.expected ?? 0
        return amount >= expected && expected > 0
          ? true
          : { ok: false, reason: `wire short by ${expected - amount}` }
      },
      verdictPass: () => ({ ok: true }),
    },
  }

  it('a failing verdict surfaces its reason in the record', () => {
    const evaluation = evaluateGuard(
      reconcile,
      ctx({ wire: { amount: 75_000, expected: 100_000 } }),
    )
    expect(resultNamed(evaluation, 'wireReconciled')).toEqual({
      name: 'wireReconciled',
      section: 'requires',
      kind: 'condition',
      passed: false,
      reason: 'wire short by 25000',
    })
  })

  it('a passing verdict without a reason produces no reason field', () => {
    const evaluation = evaluateGuard(
      reconcile,
      ctx({ wire: { amount: 100_000, expected: 100_000 } }),
    )
    expect(resultNamed(evaluation, 'wireReconciled').passed).toBe(true)
    expect(resultNamed(evaluation, 'verdictPass')).not.toHaveProperty('reason')
  })
})

describe('defective conditions are absorbed, never propagated', () => {
  it('a throwing condition becomes a failed result carrying the thrown message', () => {
    const guard: Guard<PurchaseState, PurchaseActor> = {
      requires: {
        buggy: () => {
          throw new Error('boom')
        },
      },
    }
    const evaluation = evaluateGuard(guard, ctx({}))
    expect(resultNamed(evaluation, 'buggy')).toMatchObject({
      passed: false,
      reason: 'condition threw: boom',
    })
    expect(evaluation.available).toBe(false)
  })

  it('a condition returning neither boolean nor verdict fails with a diagnostic reason', () => {
    const malformed = (() => 42) as unknown as Condition<
      PurchaseState,
      PurchaseActor
    >
    const evaluation = evaluateGuard({ requires: { malformed } }, ctx({}))
    expect(resultNamed(evaluation, 'malformed')).toMatchObject({
      passed: false,
      reason:
        'condition returned neither a boolean nor an { ok, reason? } verdict',
    })
  })

  it('rejects an asOf that is not a determinable instant', () => {
    expect(() =>
      evaluateGuard(issueFundingCall, {
        state: {},
        actor: organizer,
        asOf: 'not an instant',
      }),
    ).toThrow(TypeError)
  })
})

describe('totality over historical state', () => {
  it('conditions written with the ?? discipline evaluate cleanly against sparse pre-existing state', () => {
    const guard: Guard<PurchaseState, PurchaseActor> = {
      requires: {
        splitFinal: (s) => s.split?.confirmed ?? false,
        escrowReady: (s) => (s.escrow?.status ?? 'opening') === 'open',
        verificationFlagged: (s) =>
          (s.verification?.flaggedAt ?? null) !== null,
        financing: anyOf<PurchaseState, PurchaseActor>({
          preApproved: (s) => s.buyer?.preApproved ?? false,
          proofOfFunds: (s) => s.buyer?.proofOfFunds ?? false,
        }),
      },
    }
    const historicalState: PurchaseState = {}
    const evaluation = evaluateGuard(guard, ctx(historicalState))
    expect(evaluation.possible).toBe(false)
    expect(failedNames(evaluation)).toEqual([
      'splitFinal',
      'escrowReady',
      'verificationFlagged',
      'financing',
    ])
    expect(evaluation.conditions.every((c) => c.passed === false)).toBe(true)
  })
})

describe('determinism and serializability', () => {
  const guard: Guard<PurchaseState, PurchaseActor> = {
    requires: {
      splitFinal: (s) => s.split?.confirmed ?? false,
      wireReconciled: (s) => ({
        ok: (s.wire?.amount ?? 0) > 0,
        reason: 'no funds received',
      }),
      verificationFlagged: (s) => (s.verification?.flaggedAt ?? null) !== null,
      financing: anyOf<PurchaseState, PurchaseActor>({
        preApproved: (s) => s.buyer?.preApproved ?? false,
        flagged: (s) => (s.verification?.flaggedAt ?? null) !== null,
      }),
    },
    permits: {
      isOrganizer: (_s, c) => c.actor.roles.includes('organizer'),
    },
  }
  const state: PurchaseState = {
    split: { confirmed: true },
    buyer: {},
    verification: { flaggedAt: '2026-08-01T00:00:00.000Z' },
  }

  it('the same (state, actor, asOf) yields a deeply-equal record every time', () => {
    const first = evaluateGuard(guard, ctx(state))
    const second = evaluateGuard(guard, ctx(state))
    expect(second).toEqual(first)
    const freshEqualState = structuredClone(state)
    expect(evaluateGuard(guard, ctx(freshEqualState))).toEqual(first)
  })

  it('the record is a plain JSON-serializable object', () => {
    const evaluation = evaluateGuard(guard, ctx(state))
    expectJsonRoundTrips(evaluation)
  })
})

// Type-level assertions, verified by `tsc --noEmit`; deliberately never executed.
const typeLevelAssertions = (): void => {
  // biome-ignore format: one line, so the @ts-expect-error covers the whole assignment
  // @ts-expect-error — async conditions are inexpressible: Promise is not a ConditionOutcome
  const asyncCondition: Condition<PurchaseState, PurchaseActor> = async () => true
  void asyncCondition

  const inner = anyOf<PurchaseState, PurchaseActor>({ a: () => true })
  // @ts-expect-error — anyOf arms admit conditions only; nesting a group is outside the algebra
  const nested = anyOf<PurchaseState, PurchaseActor>({ grouped: inner })
  void nested
}
void typeLevelAssertions

import { expectJsonRoundTrips } from '@affordance/testkit'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  type BlockedStep,
  type CaseAffordances,
  computeAffordances,
} from '../../src/engine/index.js'
import {
  caseType,
  SCOPE_FAILURE_CONDITION,
  ScopeKeyError,
  step,
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
  readyState,
  snapshot,
  verificationState,
} from './fixture.js'

const compute = (
  state: Purchase,
  actor = organizer,
  at: string | Date = asOf,
): CaseAffordances =>
  computeAffordances(housePurchase, snapshot(state), { actor, asOf: at })

const blockedFor = (
  record: CaseAffordances,
  stepName: string,
  scopeKey?: string,
): BlockedStep => {
  const found = record.blocked.find(
    (b) => b.step === stepName && b.scopeKey === scopeKey,
  )
  if (!found)
    throw new Error(
      `no blocked entry for ${stepName}${scopeKey ? `(${scopeKey})` : ''}`,
    )
  return found
}

const unmetNames = (blocked: BlockedStep): string[] =>
  blocked.unmet.map((c) => c.name)

describe('case metadata', () => {
  it('carries case id, case type, asOf, and dormancy — and no completion verdict', () => {
    const record = compute(readyState())
    expect(record.caseId).toBe('case-under-test')
    expect(record.caseTypeName).toBe('house-purchase')
    expect(record.asOf).toBe(asOf)
    expect(record.endedAt).toBeNull()
    expect('complete' in record).toBe(false)
  })

  it('normalizes a Date asOf to ISO-8601', () => {
    expect(compute(readyState(), organizer, new Date(asOf)).asOf).toBe(asOf)
  })

  /**
   * The framework has no opinion on whether a matter is finished. A closed
   * purchase is just a state fact, and the only thing that
   * changes about the listing is which steps its conditions now admit — which
   * is the whole answer a client gets, and enough of one.
   */
  it('treats a closed purchase as ordinary state, with no terminal machinery', () => {
    const closed = readyState()
    closed.purchase.closedAt = '2026-08-01T00:00:00.000Z'
    const record = compute(closed)
    expect(record.affordances.map((a) => a.step)).toContain(
      'issue-funding-call',
    )
  })

  it('a dormant (ended) case still computes, with dormancy annotated', () => {
    const endedAt = new Date('2026-08-03T09:00:00.000Z')
    const record = computeAffordances(
      housePurchase,
      snapshot(readyState(), endedAt),
      {
        actor: organizer,
        asOf,
      },
    )
    expect(record.endedAt).toBe('2026-08-03T09:00:00.000Z')
    expect(record.affordances.length).toBeGreaterThan(0)
  })
})

describe('unscoped steps', () => {
  it('an available step is an affordance — its identity, and nothing else', () => {
    // How the step's input is described to a caller is the adapter's
    // translation (Engine.inputSchemaFor); the record carries no second channel.
    const record = compute(readyState())
    expect(record.affordances).toContainEqual({ step: 'issue-funding-call' })
  })

  it('a blocked step names exactly its unmet requires conditions — not possible, for anyone', () => {
    const state = readyState()
    state.escrow = { status: 'opening' }
    const blocked = blockedFor(compute(state), 'issue-funding-call')
    expect(blocked.possible).toBe(false)
    expect(blocked.permitted).toBe(true)
    expect(unmetNames(blocked)).toEqual(['escrowReady'])
    expect(blocked.unmet[0]).toMatchObject({
      section: 'requires',
      reason: 'the escrow account is not open',
    })
  })

  it('two actors see different availability for the same case state', () => {
    const state = readyState()
    const forOps = compute(state, organizer)
    expect(forOps.affordances.map((a) => a.step)).toContain(
      'issue-funding-call',
    )

    const forBuyer = compute(state, buyerActor)
    const blocked = blockedFor(forBuyer, 'issue-funding-call')
    expect(blocked.possible).toBe(true)
    expect(blocked.permitted).toBe(false)
    expect(blocked.unmet).toEqual([
      {
        name: 'isOrganizer',
        section: 'permits',
        kind: 'condition',
        passed: false,
      },
    ])
  })
})

describe('scoped steps fan out per element', () => {
  it('the mid-purchase amendment: per-buyer affordances with independent guard results', () => {
    const record = compute(amendmentState())
    // buyer_a signed v1 < purchase v2 → available; buyer_b signed v2 → blocked, per-element condition named
    expect(record.affordances).toContainEqual({
      step: 'request-re-sign',
      scopeKey: 'buyer_a',
    })
    const blockedB = blockedFor(record, 'request-re-sign', 'buyer_b')
    expect(blockedB.possible).toBe(false)
    expect(unmetNames(blockedB)).toEqual(['onPriorTerms'])
    expect(blockedB.unmet[0]).toMatchObject({
      section: 'requires',
      reason: 'agreement is already on the current terms',
    })
    // buyer_c never signed → not in scope → no affordance and no blocked entry
    expect(record.affordances.filter((a) => a.scopeKey === 'buyer_c')).toEqual(
      [],
    )
    expect(record.blocked.filter((b) => b.scopeKey === 'buyer_c')).toEqual([])
  })

  it('a scoped step selecting zero elements contributes nothing', () => {
    const record = compute(readyState())
    expect(
      record.affordances.filter((a) => a.step === 'escalate-verification'),
    ).toEqual([])
    expect(
      record.blocked.filter((b) => b.step === 'escalate-verification'),
    ).toEqual([])
  })

  it('permits failures are per element too, and distinct from requires failures', () => {
    const record = compute(amendmentState(), escrowOfficer)
    // for escrowOfficer, buyer_a is on prior terms (possible) but not permitted
    const blockedA = blockedFor(record, 'request-re-sign', 'buyer_a')
    expect(blockedA.possible).toBe(true)
    expect(blockedA.permitted).toBe(false)
    expect(unmetNames(blockedA)).toEqual(['isOrganizer'])
    // for buyer_b both fail: requires (already on terms) and permits (wrong actor)
    const blockedB = blockedFor(record, 'request-re-sign', 'buyer_b')
    expect(blockedB.possible).toBe(false)
    expect(blockedB.permitted).toBe(false)
    expect(unmetNames(blockedB)).toEqual(['onPriorTerms', 'isOrganizer'])
  })
})

describe('per-element conditions read the bound element through the engine', () => {
  it('flagged review → available; unflagged review → blocked with the stated reason', () => {
    const record = compute(verificationState(), escrowOfficer)

    expect(record.affordances).toContainEqual({
      step: 'escalate-verification',
      scopeKey: 'buyer_a',
    })

    const unflagged = blockedFor(record, 'escalate-verification', 'buyer_b')
    expect(unflagged.unmet).toEqual([
      {
        name: 'flagged',
        section: 'requires',
        kind: 'condition',
        passed: false,
        reason: 'the review carries no flag to escalate',
      },
    ])

    const alsoUnflagged = blockedFor(record, 'escalate-verification', 'buyer_d')
    expect(alsoUnflagged.unmet).toEqual([
      {
        name: 'flagged',
        section: 'requires',
        kind: 'condition',
        passed: false,
        reason: 'the review carries no flag to escalate',
      },
    ])
  })
})

describe('scope-key integrity (affordance identity)', () => {
  it('duplicate scope keys fail loudly — identity corruption is never absorbed', () => {
    const state = amendmentState()
    state.buyers = [...state.buyers, { ...state.buyers[0]! }]
    expect(() => compute(state)).toThrow(ScopeKeyError)
    expect(() => compute(state)).toThrow(/duplicate scope key 'buyer_a'/)
  })

  it('a throwing scope selector is absorbed into a blocked entry under $scope', () => {
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
    const record = computeAffordances(
      brokenType,
      { id: 'x', state: Broken.parse({}), endedAt: null },
      { actor: organizer, asOf },
    )
    expect(record.affordances).toEqual([])
    expect(record.blocked).toEqual([
      {
        step: 'explode',
        possible: false,
        permitted: true,
        unmet: [
          {
            name: SCOPE_FAILURE_CONDITION,
            section: 'requires',
            kind: 'condition',
            passed: false,
            reason: 'scope selector threw: selector bug',
          },
        ],
      },
    ])
  })
})

describe('determinism and serializability', () => {
  it('the same (state, actor, asOf) yields a deeply-equal record every time', () => {
    const first = compute(verificationState(), escrowOfficer)
    const second = compute(verificationState(), escrowOfficer)
    expect(second).toEqual(first)
  })

  it('the record survives a JSON round-trip unchanged', () => {
    const record = compute(amendmentState(), buyerActor)
    expectJsonRoundTrips(record)
  })

  it('listing order is deterministic: step declaration order, selection order within a scoped step', () => {
    const record = compute(verificationState(), escrowOfficer)
    expect(record.blocked.map((b) => [b.step, b.scopeKey])).toEqual([
      ['issue-funding-call', undefined],
      ['request-re-sign', 'buyer_a'],
      ['request-re-sign', 'buyer_b'],
      ['escalate-verification', 'buyer_b'],
      ['escalate-verification', 'buyer_d'],
    ])
    expect(record.affordances.map((a) => [a.step, a.scopeKey])).toEqual([
      ['escalate-verification', 'buyer_a'],
    ])
  })
})

describe('execution boundary', () => {
  it('affordance computation never invokes a handler (execution is a separate concern)', () => {
    compute(readyState())
    compute(amendmentState(), escrowOfficer)
    compute(verificationState(), escrowOfficer)
    expect(handlerRuns.count).toBe(0)
  })
})

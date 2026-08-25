/**
 * Shared house-purchase fixture (spec §Illustrative API): one case type with an
 * unscoped step (requires + permits + input) and two scoped steps over
 * `buyers[]` — one guarded by a per-element condition on the element's own
 * fields.
 *
 * Handlers must never run during affordance computation (execution is the
 * lifecycle's own job); every fixture handler counts its invocations so
 * tests can assert the count stayed at zero.
 */

import { z } from 'zod'
import type { CaseSnapshot } from '../../src/engine/index.js'
import type { ConditionContext } from '../../src/guards/index.js'
import { caseType, step } from '../../src/model/index.js'

export const PurchaseState = z.object({
  purchase: z.object({
    address: z.string(),
    target: z.number().positive(),
    termsVersion: z.number().int().default(1),
    closedAt: z.string().nullable().default(null),
  }),
  split: z.object({ confirmed: z.boolean() }).default({ confirmed: false }),
  escrow: z
    .object({ status: z.enum(['opening', 'open']) })
    .default({ status: 'opening' }),
  buyers: z
    .array(
      z.object({
        id: z.string(),
        committed: z.number().nonnegative().default(0),
        verification: z
          .object({
            status: z.enum(['clear', 'review']),
            flaggedAt: z.string().optional(),
          })
          .optional(),
        agreement: z
          .object({ signed: z.boolean(), termsVersion: z.number().int() })
          .optional(),
      }),
    )
    .default([]),
})

export type Purchase = z.output<typeof PurchaseState>
export type Buyer = Purchase['buyers'][number]

export interface PurchaseActor {
  readonly id: string
  readonly roles: readonly string[]
}

export const organizer: PurchaseActor = { id: 'org-1', roles: ['organizer'] }
export const escrowOfficer: PurchaseActor = {
  id: 'esc-1',
  roles: ['escrow-officer'],
}
export const buyerActor: PurchaseActor = { id: 'buyer_a', roles: ['buyer'] }

/** Invocation counter proving the engine never touches a handler (the execution lifecycle's job). */
export const handlerRuns = { count: 0 }
const countingHandler =
  () =>
  async (state: Purchase): Promise<Purchase> => {
    handlerRuns.count += 1
    return state
  }

const isOrganizer = (
  _s: Purchase,
  ctx: ConditionContext<PurchaseActor>,
): boolean => ctx.actor.roles.includes('organizer')
const isEscrowOfficer = (
  _s: Purchase,
  ctx: ConditionContext<PurchaseActor>,
): boolean => ctx.actor.roles.includes('escrow-officer')

export const FundingCallInput = z.object({ callAmount: z.number().positive() })

export const issueFundingCall = step({
  name: 'issue-funding-call',
  requires: {
    splitFinal: (s: Purchase) => s.split?.confirmed ?? false,
    committedEnough: (s: Purchase) =>
      s.buyers.reduce((sum, b) => sum + (b.committed ?? 0), 0) >=
      s.purchase.target,
    escrowReady: (s: Purchase) => ({
      ok: (s.escrow?.status ?? 'opening') === 'open',
      reason: 'the escrow account is not open',
    }),
  },
  permits: { isOrganizer },
  input: FundingCallInput,
  handler: countingHandler(),
})

/** Scoped: one affordance per signed buyer still on prior terms (the mid-purchase amendment). */
export const requestReSign = step({
  name: 'request-re-sign',
  scope: {
    select: (s: Purchase) =>
      s.buyers.filter((b) => b.agreement?.signed ?? false),
    key: (b) => b.id,
  },
  requires: {
    onPriorTerms: (s, ctx) => ({
      ok:
        (ctx.scope.agreement?.termsVersion ?? 1) <
        (s.purchase.termsVersion ?? 1),
      reason: 'agreement is already on the current terms',
    }),
  },
  permits: { isOrganizer },
  handler: countingHandler(),
})

/** Scoped: per-buyer verification review — the condition reads the element's own fields. */
export const escalateVerification = step({
  name: 'escalate-verification',
  scope: {
    select: (s: Purchase) =>
      s.buyers.filter((b) => b.verification?.status === 'review'),
    key: (b) => b.id,
  },
  requires: {
    flagged: (_s, ctx) => ({
      ok: (ctx.scope.verification?.flaggedAt ?? null) !== null,
      reason: 'the review carries no flag to escalate',
    }),
  },
  permits: { isEscrowOfficer },
  handler: countingHandler(),
})

export const housePurchase = caseType({
  name: 'house-purchase',
  state: PurchaseState,
  steps: [issueFundingCall, requestReSign, escalateVerification],
})

export const asOf = '2026-08-05T12:00:00.000Z'

/** Everything issue-funding-call needs; both buyers signed on current (v1) terms. */
export const readyState = (): Purchase =>
  PurchaseState.parse({
    purchase: { address: '12 Mochi Lane', target: 1_000_000 },
    split: { confirmed: true },
    escrow: { status: 'open' },
    buyers: [
      {
        id: 'buyer_a',
        committed: 600_000,
        agreement: { signed: true, termsVersion: 1 },
      },
      {
        id: 'buyer_b',
        committed: 400_000,
        agreement: { signed: true, termsVersion: 1 },
      },
      { id: 'buyer_c' },
    ],
  })

/** The mid-purchase amendment: terms moved to v2; buyer_a signed v1 (re-paper), buyer_b signed v2. */
export const amendmentState = (): Purchase => {
  const state = readyState()
  return {
    ...state,
    purchase: { ...state.purchase, termsVersion: 2 },
    buyers: state.buyers.map((b) =>
      b.id === 'buyer_b' && b.agreement
        ? { ...b, agreement: { ...b.agreement, termsVersion: 2 } }
        : b,
    ),
  }
}

/** Verification review tracks: buyer_a flagged (escalatable), buyer_b and buyer_d in review with no flag. */
export const verificationState = (): Purchase => {
  const state = readyState()
  return {
    ...state,
    buyers: [
      {
        ...state.buyers[0]!,
        verification: {
          status: 'review',
          flaggedAt: '2026-07-28T12:00:00.000Z',
        },
      },
      { ...state.buyers[1]!, verification: { status: 'review' } },
      state.buyers[2]!,
      { id: 'buyer_d', committed: 0, verification: { status: 'review' } },
    ],
  }
}

export const snapshot = (
  state: Purchase,
  endedAt: Date | string | null = null,
): CaseSnapshot<Purchase> => ({
  id: 'case-under-test',
  state,
  endedAt,
})

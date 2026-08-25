/**
 * A house-purchase-shaped case type with two audiences: the organizer, who
 * runs the purchase, and buyers, who see only their own track — the steps
 * scoped to their own element. That split is what the adapter's visibility
 * rule has to get right.
 */

import type { ConditionContext } from '@affordance/core'
import { actor, caseType, stepsOf } from '@affordance/core'
import { z } from 'zod'
import type { EnginePort } from '../src/index.js'

export const PurchaseState = z.object({
  purchase: z.object({
    address: z.string(),
    closedAt: z.string().nullable().default(null),
  }),
  split: z
    .object({ confirmed: z.boolean().default(false) })
    .default({ confirmed: false }),
  buyers: z
    .array(
      z.object({
        id: z.string(),
        signed: z.boolean().default(false),
        committed: z.number().default(0),
      }),
    )
    .default([]),
  notes: z.array(z.string()).default([]),
})

export type Purchase = z.output<typeof PurchaseState>
export type Buyer = Purchase['buyers'][number]

export interface Actor {
  readonly id: string
  readonly roles: readonly string[]
}

export const organizer: Actor = { id: 'org-1', roles: ['organizer'] }
export const buyerA: Actor = { id: 'buyer_a', roles: ['buyer'] }
export const buyerB: Actor = { id: 'buyer_b', roles: ['buyer'] }

const isOrganizer = (_s: Purchase, ctx: ConditionContext<Actor>): boolean =>
  ctx.actor?.roles.includes('organizer') ?? false

const purchaseStep = stepsOf(PurchaseState, actor<Actor>())

/** Scoped + buyer-permitted: each buyer may sign their own agreement and no one else's. */
export const signAgreement = purchaseStep({
  name: 'sign-agreement',
  scope: {
    select: (s) => s.buyers.filter((b) => !b.signed),
    key: (b) => b.id,
  },
  permits: {
    isThisBuyer: (_s, ctx) => ({
      ok: ctx.actor?.id === ctx.scope.id,
      reason: 'an agreement is signed by the buyer it belongs to',
    }),
  },
  input: z.object({ signedAt: z.string() }),
  handler: async (s, ctx) => ({
    ...s,
    buyers: s.buyers.map((b) =>
      b.id === ctx.scopeKey ? { ...b, signed: true } : b,
    ),
    notes: [...s.notes, `${ctx.scopeKey} signed`],
  }),
})

/** Purchase-level, organizer only. */
export const confirmSplit = purchaseStep({
  name: 'confirm-split',
  requires: { notConfirmed: (s) => !s.split.confirmed },
  permits: { isOrganizer },
  handler: async (s) => ({ ...s, split: { confirmed: true } }),
})

/** Purchase-level, blocked on a `requires` — the "show me why not" subject. */
export const closePurchase = purchaseStep({
  name: 'close-purchase',
  requires: {
    open: (s) => s.purchase.closedAt === null,
    allSigned: (s) => ({
      ok: s.buyers.every((b) => b.signed),
      reason: `${s.buyers.filter((b) => !b.signed).length} buyers have not signed`,
    }),
    splitFinal: (s) => s.split.confirmed,
  },
  permits: { isOrganizer },
  handler: async (s, ctx) => {
    ctx.end()
    return {
      ...s,
      purchase: { ...s.purchase, closedAt: '2026-09-01T00:00:00.000Z' },
    }
  },
})

/** Materializes an external fact — the ingestion endpoint's target. */
export const recordCommitment = purchaseStep({
  name: 'record-commitment',
  scope: { select: (s) => s.buyers, key: (b) => b.id },
  input: z.object({ amount: z.number() }),
  handler: async (s, ctx) => ({
    ...s,
    buyers: s.buyers.map((b) =>
      b.id === ctx.scopeKey ? { ...b, committed: ctx.input.amount } : b,
    ),
  }),
})

export const purchase = caseType({
  name: 'purchase-http',
  state: PurchaseState,
  steps: [signAgreement, confirmSplit, closePurchase, recordCommitment],
})

export const twoBuyers = () => ({
  purchase: { address: '12 Mochi Lane' },
  buyers: [{ id: 'buyer_a' }, { id: 'buyer_b' }],
})

/**
 * A complete {@link EnginePort} for suites that run without a database —
 * every member is present, no `as unknown as` required. Members a suite does
 * not exercise throw a plain 'not under test' error rather than quietly
 * returning something plausible; the suite overrides only what it drives.
 */
export const stubEnginePort = (
  overrides: Partial<EnginePort> = {},
): EnginePort => {
  const notUnderTest = () => Promise.reject(new Error('not under test'))
  return {
    createCase: notUnderTest,
    affordances: notUnderTest,
    affordancesOf: () => {
      throw new Error('not under test')
    },
    explain: notUnderTest,
    execute: notUnderTest,
    journal: notUnderTest,
    ingest: notUnderTest,
    deadLetters: notUnderTest,
    inputSchemaFor: () => null,
    stepMetadataFor: () => null,
    ...overrides,
  }
}

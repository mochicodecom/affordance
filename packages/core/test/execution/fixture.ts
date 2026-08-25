/**
 * House-purchase-shaped fixture for the execution lifecycle: unlike the engine
 * fixture, every handler here really runs and really mutates Case State.
 *
 * It also carries the deliberately-awkward steps a lifecycle needs proving
 * against — one that stalls until a test opens a gate, one that throws a
 * controlled number of times, one that returns state its own schema rejects,
 * one that writes to an app table through `ctx.onCommit`.
 */

import { z } from 'zod'
import type { ConditionContext } from '../../src/guards/index.js'
import { caseType, step } from '../../src/model/index.js'

/** App-owned table the shared-transaction step writes to. */
export const APP_TABLE = 'case_test_wires'

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
    .default({ status: 'open' }),
  fundingCall: z
    .object({ amount: z.number(), executionId: z.string() })
    .nullable()
    .default(null),
  buyers: z
    .array(
      z.object({
        id: z.string(),
        committed: z.number().nonnegative().default(0),
        agreement: z
          .object({ signed: z.boolean(), termsVersion: z.number().int() })
          .optional(),
        reSignRequests: z.number().int().default(0),
      }),
    )
    .default([]),
  notes: z.array(z.string()).default([]),
})

export type Purchase = z.output<typeof PurchaseState>
export type Buyer = Purchase['buyers'][number]

export interface PurchaseActor {
  readonly id: string
  readonly roles: readonly string[]
}

export const organizer: PurchaseActor = { id: 'ops-1', roles: ['organizer'] }
export const buyerActor: PurchaseActor = { id: 'buyer_a', roles: ['buyer'] }

const isOrganizer = (
  _s: Purchase,
  ctx: ConditionContext<PurchaseActor>,
): boolean => ctx.actor.roles.includes('organizer')

/** A latch a test opens to let a stalled handler proceed. */
export interface Gate {
  /** Resolves once the handler has entered — i.e. the claim is definitely held. */
  readonly entered: Promise<void>
  /** Resolves once the test opens the gate. */
  readonly opened: Promise<void>
  enter(): void
  open(): void
}

export const createGate = (): Gate => {
  let enter!: () => void
  let open!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { entered, opened, enter, open }
}

/** Test-controlled handler behavior, reset per test. */
export const control: {
  gate: Gate | null
  /** How many more times the `flaky` handler should throw before succeeding. */
  failuresRemaining: number
  /** Every `ctx.attempt` the `flaky` handler saw. */
  attemptsSeen: number[]
  /** Every `ctx.executionId` the `flaky` handler saw. */
  executionIdsSeen: string[]
} = { gate: null, failuresRemaining: 0, attemptsSeen: [], executionIdsSeen: [] }

export const resetControl = (): void => {
  control.gate = null
  control.failuresRemaining = 0
  control.attemptsSeen = []
  control.executionIdsSeen = []
}

export const confirmSplit = step({
  name: 'confirm-split',
  requires: {
    notConfirmed: (s: Purchase) => ({
      ok: !(s.split?.confirmed ?? false),
      reason: 'the split is already confirmed',
    }),
  },
  permits: { isOrganizer },
  handler: async (s, ctx) => ({
    ...s,
    split: { confirmed: true },
    notes: [...s.notes, `split confirmed by ${ctx.actor.id}`],
  }),
})

export const FundingCallInput = z.object({ callAmount: z.number().positive() })

export const issueFundingCall = step({
  name: 'issue-funding-call',
  requires: {
    splitFinal: (s: Purchase) => s.split?.confirmed ?? false,
    notYetCalled: (s: Purchase) => (s.fundingCall ?? null) === null,
    escrowReady: (s: Purchase) => ({
      ok: (s.escrow?.status ?? 'opening') === 'open',
      reason: 'the escrow account is not open',
    }),
  },
  permits: { isOrganizer },
  input: FundingCallInput,
  handler: async (s, ctx) => ({
    ...s,
    // The execution id is the idempotency key; recording it in
    // state is what a real handler would send to the escrow company.
    fundingCall: { amount: ctx.input.callAmount, executionId: ctx.executionId },
  }),
})

/** Scoped: one Execution per buyer still on prior terms (the mid-purchase amendment). */
export const requestReSign = step({
  name: 'request-re-sign',
  scope: {
    select: (s: Purchase) =>
      s.buyers.filter((b) => b.agreement?.signed ?? false),
    key: (b: Buyer) => b.id,
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
  handler: async (s, ctx) => ({
    ...s,
    buyers: s.buyers.map((buyer) =>
      buyer.id === ctx.scopeKey
        ? {
            ...buyer,
            reSignRequests: buyer.reSignRequests + 1,
            agreement: { signed: false, termsVersion: s.purchase.termsVersion },
          }
        : buyer,
    ),
    notes: [...s.notes, `re-sign requested for ${ctx.scopeKey}`],
  }),
})

/** Holds its claim until a test opens the gate — stands in for a long or wedged handler. */
export const stall = step({
  name: 'stall',
  permits: { isOrganizer },
  retry: { maxAttempts: 1 },
  handler: async (s, _ctx) => {
    control.gate?.enter()
    await control.gate?.opened
    return { ...s, notes: [...s.notes, 'stalled'] }
  },
})

/** Throws `control.failuresRemaining` times, then succeeds — the retry policy's test subject. */
export const flaky = step({
  name: 'flaky',
  permits: { isOrganizer },
  retry: { maxAttempts: 3, delayMs: 0 },
  handler: async (s, ctx) => {
    control.attemptsSeen.push(ctx.attempt)
    control.executionIdsSeen.push(ctx.executionId)
    if (control.failuresRemaining > 0) {
      control.failuresRemaining -= 1
      throw new Error(`transient failure on attempt ${ctx.attempt}`)
    }
    return {
      ...s,
      notes: [...s.notes, `flaky succeeded on attempt ${ctx.attempt}`],
    }
  },
})

/** Returns a Case State its own schema rejects: a deterministic defect, never retried. */
export const corruptState = step({
  name: 'corrupt-state',
  permits: { isOrganizer },
  retry: { maxAttempts: 3, delayMs: 0 },
  handler: async (s) => ({ ...s, purchase: { ...s.purchase, target: -1 } }),
})

export const WireInput = z.object({
  amount: z.number().positive(),
  poison: z.boolean().default(false),
})

/** Writes to an app-owned table inside the framework's commit transaction. */
export const recordWire = step({
  name: 'record-wire',
  permits: { isOrganizer },
  input: WireInput,
  retry: { maxAttempts: 1 },
  handler: async (s, ctx) => {
    ctx.onCommit(async (tx) => {
      if (ctx.input.poison)
        throw new Error('app-table write refused the commit')
      await tx.query(
        `insert into ${APP_TABLE} (execution_id, amount) values ($1, $2)`,
        [ctx.executionId, ctx.input.amount],
      )
    })
    return { ...s, notes: [...s.notes, `wire recorded: ${ctx.input.amount}`] }
  },
})

/**
 * Dormancy is written by the handler *and* mirrored into Case State: guards
 * are pure over Case State, so `end()`'s marker — which lives in
 * the framework's own bookkeeping — is not something a condition can read.
 * The outcome is state (`purchase.closedAt`); `ctx.end()` is the dormancy
 * annotation that keeps the case out of active listings.
 */
export const closePurchase = step({
  name: 'close-purchase',
  requires: { open: (s: Purchase) => s.purchase.closedAt === null },
  permits: { isOrganizer },
  handler: async (s, ctx) => {
    ctx.end()
    return {
      ...s,
      purchase: { ...s.purchase, closedAt: '2026-08-05T12:00:00.000Z' },
    }
  },
})

/** Un-ending is an ordinary step — guarded on the state the closing handler wrote. */
export const reopenPurchase = step({
  name: 'reopen-purchase',
  requires: { closed: (s: Purchase) => s.purchase.closedAt !== null },
  permits: { isOrganizer },
  handler: async (s, ctx) => {
    ctx.reopen()
    return {
      ...s,
      purchase: { ...s.purchase, closedAt: null },
      notes: [...s.notes, 'reopened'],
    }
  },
})

export const purchaseExecution = caseType({
  name: 'purchase-execution',
  state: PurchaseState,
  steps: [
    confirmSplit,
    issueFundingCall,
    requestReSign,
    stall,
    flaky,
    corruptState,
    recordWire,
    closePurchase,
    reopenPurchase,
  ],
})

/** Two buyers signed on v1 terms; the purchase has since moved to v2 (the amendment). */
export const amendmentState = (): Purchase =>
  PurchaseState.parse({
    purchase: { address: '12 Mochi Lane', target: 1_000_000, termsVersion: 2 },
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
    ],
  })

export const readyState = (): Purchase =>
  PurchaseState.parse({
    purchase: { address: '12 Mochi Lane', target: 1_000_000 },
    buyers: [{ id: 'buyer_a', committed: 1_000_000 }],
  })

/** Poll until `predicate` holds, so tests never race the lifecycle they observe. */
export const waitUntil = async (
  predicate: () => Promise<boolean> | boolean,
  { timeoutMs = 5_000, intervalMs = 10 } = {},
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error('waitUntil: timed out')
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

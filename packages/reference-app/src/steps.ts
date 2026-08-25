/**
 * Every step a house purchase can take, as a flat list of guarded units of
 * work.
 *
 * Read this file looking for an ordering and you will not find one. There is
 * no `next`, no stage, no transition — `record-signature` does not know that
 * `send-agreement` exists, and `close-purchase` does not know that anything
 * precedes it. What each step declares is the *state* it needs to be true,
 * and the sequencing everyone can see in the tests is a consequence of those
 * declarations meeting the facts.
 *
 * The two exception paths the anchor use case demanded are ordinary steps
 * here, which is the claim being tested:
 *
 * - **Wire reconciliation** — `record-wire` materializes an announced wire
 *   already classified: comparing a wire against its buyer's commitment
 *   takes no judgement, so the short / over / wrong-account outcomes are
 *   recorded with the wire, and each has its own resolution step. Nobody
 *   drew a branch.
 * - **Verification escalation** — a provider hit puts a buyer in `review`;
 *   `escalate-verification` is then on offer for the escrow officer, who
 *   decides whether a stalled review warrants enhanced review.
 */

import { randomUUID } from 'node:crypto'
import type {
  ConditionContext,
  ConditionMap,
  ScopedConditionContext,
  StepDefinition,
} from '@affordance/core'
import { actor, anyOf, stepsOf } from '@affordance/core'
import { z } from 'zod'
import type { MockServices } from './services.js'
import type { Buyer, Purchase, PurchaseActor, Wire } from './state.js'
import {
  arrivedAmount,
  buyerOf,
  hasRole,
  PurchaseState,
  registeredAccountOf,
  updateBuyer,
  wireSettled,
} from './state.js'

/**
 * What the provider-calling steps need from the outside world — the port
 * their handlers are bound to at definition time. Binding happens when the
 * definitions are built (`createPurchaseDefinitions`), so two apps in one
 * process each call their own providers; there is no install-order rule and
 * no global to rebind.
 */
export type PurchaseProviders = Pick<
  MockServices,
  'applyForEscrowAccount' | 'startVerification' | 'sendEnvelope'
>

type Ctx = ConditionContext<PurchaseActor>
type BuyerCtx = ScopedConditionContext<Buyer, PurchaseActor>

/**
 * The bound authoring surface: `step()` with `Purchase` and `PurchaseActor`
 * fixed by the state schema. Every step below is written through it, which is
 * why no condition, selector, or handler inside a step call annotates its
 * state parameter — the type flows from `PurchaseState`, the same value
 * `createPurchaseDefinition` hands to `caseType`. (The shared helpers above
 * and below still annotate: they are defined outside a step call, where
 * there is no context to infer from.)
 */
const purchaseStep = stepsOf(PurchaseState, actor<PurchaseActor>())

const isOrganizer = (_s: Purchase, ctx: Ctx) => ({
  ok: hasRole(ctx.actor, 'organizer'),
  reason: 'only the organizer can take this step',
})

const isEscrowOfficer = (_s: Purchase, ctx: Ctx) => ({
  ok: hasRole(ctx.actor, 'escrow-officer'),
  reason: 'only the escrow officer can take this step',
})

/**
 * A materializing step exists to record what an external system said,
 * so the only actor who should ever take one is an external
 * system. `permits` is how that is said — and the effect is that these steps
 * never appear as affordances to a person, without any concept of a "system
 * step" existing in the framework.
 */
const isIntegration = (_s: Purchase, ctx: Ctx) => ({
  ok: hasRole(ctx.actor, 'integration'),
  reason: 'this step records what an external system reported',
})

/**
 * The buyer themselves — nobody else, the organizer included. Deliberate:
 * committing funds is the one step the demo loop cannot finish without a
 * persona hop (organizer invites → buyer commits) — and that hop is what
 * the demo exists to show.
 */
const isThisBuyer = (_s: Purchase, ctx: BuyerCtx) => ({
  ok: ctx.actor?.id === ctx.scope.id,
  reason: 'this step belongs to the buyer it is about',
})

const purchaseOpen = (s: Purchase) => ({
  ok: s.purchase.closedAt === null,
  reason: 'the purchase has closed',
})

// ---------------------------------------------------------------------------
// Purchase setup — the linear stretch. Each step's guard states the fact the
// previous step leaves in state, and its own fact negated (once-only). No
// step names another step; the chain is only these conditions meeting facts.
// ---------------------------------------------------------------------------

const offerAccepted = (s: Purchase) => ({
  ok: s.property.offerAcceptedAt !== null,
  reason: 'the offer has not been accepted',
})

const offerNotYetAccepted = (s: Purchase) => ({
  ok: s.property.offerAcceptedAt === null,
  reason: 'the offer has already been accepted',
})

const inspectionReportObtained = (s: Purchase) => ({
  ok: s.property.inspectionReportId !== null,
  reason: 'there is no inspection report yet',
})

const noInspectionReportYet = (s: Purchase) => ({
  ok: s.property.inspectionReportId === null,
  reason: 'the inspection report has already been obtained',
})

const escrowNotYetApplied = (s: Purchase) => ({
  ok: s.escrow.applicationId === null,
  reason: 'an escrow account has already been applied for',
})

const acceptOffer = purchaseStep({
  name: 'accept-offer',
  title: 'Seller accepted our offer',
  requires: { offerNotYetAccepted, purchaseOpen },
  permits: { isOrganizer },
  handler: async (s) => ({
    ...s,
    property: { ...s.property, offerAcceptedAt: '2026-08-01T09:00:00.000Z' },
    notes: [...s.notes, 'offer accepted'],
  }),
})

const obtainInspectionReport = purchaseStep({
  name: 'obtain-inspection-report',
  title: 'Obtain the inspection report',
  requires: { offerAccepted, noInspectionReportYet },
  permits: { isOrganizer },
  handler: async (s) => ({
    ...s,
    property: { ...s.property, inspectionReportId: 'insp_20260801' },
    notes: [...s.notes, 'inspection report obtained'],
  }),
})

/**
 * Applies to the escrow company and registers how the answer will come back.
 * The account is not open when this commits — it is *applied for*, which is a
 * different fact and is the one the state records.
 */
const openEscrow = (services: PurchaseProviders) =>
  purchaseStep({
    name: 'open-escrow',
    title: 'Open escrow',
    requires: { inspectionReportObtained, escrowNotYetApplied },
    permits: { isOrganizer },
    handler: async (s, ctx) => {
      const applicationId = services.applyForEscrowAccount({
        address: s.purchase.address,
      })
      // The escrow company will quote this application id for the account
      // opening *and* for every wire that lands in it, so one correlation
      // covers both; each event names the step it wants.
      ctx.correlate({
        system: 'escrow',
        externalId: applicationId,
        scopeKey: null,
        step: 'record-escrow-account',
        metadata: { address: s.purchase.address },
      })
      return {
        ...s,
        escrow: { ...s.escrow, status: 'requested', applicationId },
        notes: [...s.notes, 'escrow account requested'],
      }
    },
  })

export const createPurchaseSetup = (services: PurchaseProviders) => [
  acceptOffer,
  obtainInspectionReport,
  openEscrow(services),
]

/** Materializes the escrow company's answer — routed here by the event, not by a poll. */
export const recordEscrowAccount = purchaseStep({
  name: 'record-escrow-account',
  title: 'Record the escrow account',
  description:
    'Materialize the escrow company’s answer: the account it opened for this purchase. Delivered by the escrow system’s webhook, or entered when the answer arrived out of band.',
  requires: {
    applied: (s) => ({
      ok: s.escrow.status === 'requested',
      reason: 'no escrow application is outstanding',
    }),
  },
  permits: { isIntegration },
  input: z.object({ accountId: z.string(), openedAt: z.string() }),
  handler: async (s, ctx) => ({
    ...s,
    escrow: { ...s.escrow, status: 'open', accountId: ctx.input.accountId },
    notes: [...s.notes, `escrow account ${ctx.input.accountId} opened`],
  }),
})

// ---------------------------------------------------------------------------
// Buyers: invitation, commitment, verification, agreement.
// ---------------------------------------------------------------------------

export const inviteBuyer = purchaseStep({
  name: 'invite-buyer',
  title: 'Invite a buyer',
  requires: { purchaseOpen },
  permits: { isOrganizer },
  // Identity is the server's to mint, not the caller's to choose: the input
  // is the name alone, and the handler issues `buyer:<uuid>` in the same
  // `type:uuid` shape the framework uses for cases. External systems'
  // identifiers (wire ids, account ids, envelopes) stay caller-supplied —
  // those are the providers' own correlation identity.
  input: z.object({ name: z.string() }),
  handler: async (s, ctx) => ({
    ...s,
    buyers: [
      ...s.buyers,
      {
        id: `buyer:${randomUUID()}`,
        name: ctx.input.name,
        committed: null,
        verification: {
          status: 'none',
          checkId: null,
          flaggedAt: null,
          hits: [],
          escalatedAt: null,
        },
        agreement: null,
      },
    ],
    notes: [...s.notes, `${ctx.input.name} invited`],
  }),
})

export const recordCommitment = purchaseStep({
  name: 'record-commitment',
  title: 'Commit funds',
  scope: {
    select: (s) => s.buyers.filter((b) => b.committed === null),
    key: (b) => b.id,
  },
  requires: { purchaseOpen },
  permits: { isThisBuyer },
  input: z.object({ amount: z.number().positive() }),
  handler: async (s, ctx) => ({
    ...updateBuyer(s, ctx.scopeKey, (b) => ({
      ...b,
      committed: ctx.input.amount,
    })),
    notes: [...s.notes, `${ctx.scopeKey} committed ${ctx.input.amount}`],
  }),
})

export const createStartVerification = (services: PurchaseProviders) =>
  purchaseStep({
    name: 'start-verification',
    title: 'Start identity verification',
    scope: {
      select: (s) =>
        s.buyers.filter(
          (b) => b.committed !== null && b.verification.status === 'none',
        ),
      key: (b) => b.id,
    },
    permits: { isOrganizer },
    handler: async (s, ctx) => {
      // The demo's lever on the provider, keyed on the buyer's name:
      // '(hit)' comes back flagged, putting the buyer in review — the
      // escalation and enhanced-review branch can then be played live.
      const flagged = ctx.scope.name.includes('(hit)')
      const checkId = services.startVerification({
        buyerId: ctx.scopeKey,
        ...(flagged && { hits: ['sanctions:OFAC'] }),
      })
      ctx.correlate({
        system: 'verify',
        externalId: checkId,
        step: 'record-verification-result',
      })
      return updateBuyer(s, ctx.scopeKey, (b) => ({
        ...b,
        verification: { ...b.verification, status: 'pending', checkId },
      }))
    },
  })

export const recordVerificationResult = purchaseStep({
  name: 'record-verification-result',
  title: 'Record verification result',
  description:
    'Materialize the identity provider’s verdict for one buyer — verified, or flagged for review. Delivered by the provider’s webhook.',
  scope: {
    select: (s) => s.buyers.filter((b) => b.verification.status === 'pending'),
    key: (b) => b.id,
  },
  permits: { isIntegration },
  input: z.object({
    status: z.enum(['clear', 'review']),
    hits: z.array(z.string()).default([]),
    completedAt: z.string(),
  }),
  handler: async (s, ctx) => ({
    ...updateBuyer(s, ctx.scopeKey, (b) => ({
      ...b,
      verification: {
        ...b.verification,
        status: ctx.input.status,
        hits: ctx.input.hits,
        // When the hit put this buyer in review — kept as the record
        // the escalation decision is made against.
        flaggedAt: ctx.input.status === 'review' ? ctx.input.completedAt : null,
      },
    })),
    notes: [...s.notes, `${ctx.scopeKey} verification ${ctx.input.status}`],
  }),
})

/**
 * The verification escalation exception: a hit puts a buyer in review, and
 * the case *offers* an enhanced-review escalation for as long as the review
 * stands unresolved — whether a stalled review warrants it is the escrow
 * officer's call.
 */
export const escalateVerification = purchaseStep({
  name: 'escalate-verification',
  title: 'Escalate a stalled verification',
  description:
    'Move a buyer whose verification sits in review into enhanced review — the escrow officer’s judgement that the stall warrants a closer look.',
  scope: {
    select: (s) => s.buyers.filter((b) => b.verification.status === 'review'),
    key: (b) => b.id,
  },
  permits: { isEscrowOfficer },
  handler: async (s, ctx) => ({
    ...updateBuyer(s, ctx.scopeKey, (b) => ({
      ...b,
      verification: {
        ...b.verification,
        status: 'escalated',
        escalatedAt: '2026-08-15T10:00:00.000Z',
      },
    })),
    notes: [...s.notes, `${ctx.scopeKey} escalated to enhanced review`],
  }),
})

/** Enhanced review's outcome — the only way out of `escalated`, and a human's call. */
export const clearEnhancedReview = purchaseStep({
  name: 'clear-enhanced-review',
  title: 'Clear enhanced review',
  description:
    'Conclude a buyer’s enhanced review and mark them verified — the escrow officer vouches for the identity.',
  scope: {
    select: (s) =>
      s.buyers.filter((b) => b.verification.status === 'escalated'),
    key: (b) => b.id,
  },
  permits: { isEscrowOfficer },
  input: z.object({ cleared: z.boolean() }),
  handler: async (s, ctx) => ({
    ...updateBuyer(s, ctx.scopeKey, (b) => ({
      ...b,
      verification: {
        ...b.verification,
        status: ctx.input.cleared ? 'clear' : 'rejected',
      },
    })),
    notes: [
      ...s.notes,
      `${ctx.scopeKey} enhanced review ${ctx.input.cleared ? 'cleared' : 'rejected'}`,
    ],
  }),
})

export const createSendAgreement = (services: PurchaseProviders) =>
  purchaseStep({
    name: 'send-agreement',
    title: 'Send the purchase agreement',
    scope: {
      select: (s) =>
        s.buyers.filter(
          (b) =>
            b.verification.status === 'clear' &&
            !(b.agreement?.signed ?? false) &&
            (b.agreement?.envelopeId ?? null) === null,
        ),
      key: (b) => b.id,
    },
    requires: { purchaseOpen },
    permits: { isOrganizer },
    handler: async (s, ctx) => {
      const envelopeId = services.sendEnvelope({ buyerId: ctx.scopeKey })
      ctx.correlate({
        system: 'esign',
        externalId: envelopeId,
        step: 'record-signature',
      })
      return updateBuyer(s, ctx.scopeKey, (b) => ({
        ...b,
        agreement: { envelopeId, signed: false, signedAt: null },
      }))
    },
  })

export const recordSignature = purchaseStep({
  name: 'record-signature',
  title: 'Record a signature',
  description:
    'Materialize one signer’s completed signature from the e-sign provider. Delivered by the provider’s webhook.',
  scope: {
    select: (s) =>
      s.buyers.filter(
        (b) =>
          (b.agreement?.envelopeId ?? null) !== null &&
          !(b.agreement?.signed ?? false),
      ),
    key: (b) => b.id,
  },
  permits: { isIntegration },
  input: z.object({ signedAt: z.string() }),
  handler: async (s, ctx) => ({
    ...updateBuyer(s, ctx.scopeKey, (b) => ({
      ...b,
      agreement: {
        envelopeId: b.agreement?.envelopeId ?? null,
        signed: true,
        signedAt: ctx.input.signedAt,
      },
    })),
    notes: [...s.notes, `${ctx.scopeKey} signed`],
  }),
})

// ---------------------------------------------------------------------------
// Money: the funding call, the wires, and reconciliation.
// ---------------------------------------------------------------------------

const committedBuyers = (s: Purchase): readonly Buyer[] =>
  s.buyers.filter((b) => b.committed !== null)

export const issueFundingCall = purchaseStep({
  name: 'issue-funding-call',
  title: 'Issue the funding call',
  requires: {
    purchaseOpen,
    escrowReady: (s) => ({
      ok: s.escrow.status === 'open',
      reason: 'the escrow account is not open',
    }),
    hasBuyers: (s) => ({
      ok: committedBuyers(s).length > 0,
      reason: 'no buyer has committed',
    }),
    allSigned: (s) => {
      // One traversal: the ok/reason pair visibly derives from the same list.
      const unsigned = committedBuyers(s).filter(
        (b) => !(b.agreement?.signed ?? false),
      )
      return {
        ok: unsigned.length === 0,
        reason: `${unsigned.length} committed buyers have not signed`,
      }
    },
    notYetCalled: (s) => ({
      ok: s.fundingCall === null,
      reason: 'the funding call has already been issued',
    }),
  },
  permits: { isOrganizer },
  input: z.object({ reference: z.string() }),
  handler: async (s, ctx) => ({
    ...s,
    fundingCall: {
      amount: committedBuyers(s).reduce(
        (total, b) => total + (b.committed ?? 0),
        0,
      ),
      issuedAt: '2026-08-10T09:00:00.000Z',
      reference: ctx.input.reference,
    },
    notes: [...s.notes, `funding call ${ctx.input.reference} issued`],
  }),
})

/**
 * Materializes a wire the escrow company announced, classified at the same
 * commit. Purchase-level: the event quotes the account.
 *
 * The wire reconciliation exception lives here: comparing a wire against its
 * buyer's commitment takes no judgement, so the classification is part of
 * recording the fact. What it produces is *state* — `short`, `over`,
 * `wrong-account` — and each of those has its own resolution step below,
 * guarded on it. No branch is drawn anywhere; the exception paths are simply
 * steps that become available when their facts are true.
 */
export const recordWire = purchaseStep({
  name: 'record-wire',
  title: 'Record an incoming wire',
  description:
    'Materialize a wire the escrow bank announced, already classified against its buyer’s commitment: settled, short, over, or wrong-account. Delivered by the bank’s webhook.',
  requires: {
    called: (s) => ({
      ok: s.fundingCall !== null,
      reason: 'no funding call has been issued',
    }),
  },
  permits: { isIntegration },
  input: z.object({
    wireId: z.string(),
    buyerId: z.string(),
    amount: z.number(),
    fromAccount: z.string().default(''),
    receivedAt: z.string(),
  }),
  handler: async (s, ctx) => {
    const expected = buyerOf(s, ctx.input.buyerId)?.committed ?? null
    const outcome: Wire['outcome'] =
      ctx.input.fromAccount !== registeredAccountOf(ctx.input.buyerId)
        ? 'wrong-account'
        : expected === null || ctx.input.amount === expected
          ? 'matched'
          : ctx.input.amount < expected
            ? 'short'
            : 'over'
    return {
      ...s,
      wires: [
        ...s.wires,
        {
          id: ctx.input.wireId,
          buyerId: ctx.input.buyerId,
          amount: ctx.input.amount,
          fromAccount: ctx.input.fromAccount,
          receivedAt: ctx.input.receivedAt,
          outcome,
          resolution: null,
        },
      ],
      notes: [...s.notes, `wire ${ctx.input.wireId} recorded: ${outcome}`],
    }
  },
})

const resolutionStep = (
  name: string,
  title: string,
  description: string,
  outcome: Wire['outcome'],
  resolution: NonNullable<Wire['resolution']>,
  permits: Record<
    string,
    (s: Purchase, ctx: Ctx) => { ok: boolean; reason: string }
  >,
): StepDefinition<Purchase, PurchaseActor> =>
  purchaseStep({
    name,
    title,
    description,
    scope: {
      select: (s) =>
        s.wires.filter((w) => w.outcome === outcome && w.resolution === null),
      key: (w) => w.id,
    },
    permits,
    handler: async (s, ctx) => ({
      ...s,
      wires: s.wires.map((w) =>
        w.id === ctx.scopeKey ? { ...w, resolution } : w,
      ),
      notes: [...s.notes, `wire ${ctx.scopeKey} ${resolution}`],
    }),
  })

// The resolutions split by kind of authority: returning or refunding money is
// the escrow company's mechanics, but accepting a short wire is the
// organizer's concession — it is what `shortClosePermitted` reads, a deal
// decision rather than money handling.
export const acceptShortWire = resolutionStep(
  'accept-short-wire',
  'Accept a short wire',
  'Accept a wire that arrived under the buyer’s commitment — the organizer’s concession to close on the shortfall.',
  'short',
  'accepted-short',
  {
    isOrganizer,
  },
)
export const refundOverWire = resolutionStep(
  'refund-over-wire',
  'Refund an over-payment',
  'Return the excess of a wire that arrived over the buyer’s commitment.',
  'over',
  'refunded-over',
  {
    isEscrowOfficer,
  },
)
export const returnWire = resolutionStep(
  'return-wire',
  'Return a wrong-account wire',
  'Send back a wire whose originating account does not match the buyer’s registered account.',
  'wrong-account',
  'returned',
  {
    isEscrowOfficer,
  },
)

// ---------------------------------------------------------------------------
// Closing and deed recording — outcomes as state.
// ---------------------------------------------------------------------------

// Defined outside a step call, so the map's own type annotation is what
// anchors the conditions' state parameter.
const closeConditions: ConditionMap<Purchase, PurchaseActor> = {
  purchaseOpen,
  called: (s) => ({
    ok: s.fundingCall !== null,
    reason: 'the funding call has not been issued',
  }),
  allSigned: (s) => ({
    ok: committedBuyers(s).every((b) => b.agreement?.signed ?? false),
    reason: 'not every committed buyer has signed',
  }),
  wiresSettled: (s) => {
    const unresolved = s.wires.filter((w) => !wireSettled(w))
    return {
      ok: unresolved.length === 0,
      reason: `${unresolved.length} wires are unresolved`,
    }
  },
  /**
   * Either every buyer's money is in, or the organizer accepted closing a
   * little short — a genuine disjunction in the business, expressed as one
   * rather than as two nearly-identical steps.
   */
  funded: anyOf({
    fullyFunded: (s) => ({
      ok:
        arrivedAmount(s.wires) >=
        (s.fundingCall?.amount ?? Number.POSITIVE_INFINITY),
      reason: 'the wires do not cover the funding call',
    }),
    shortClosePermitted: (s) => ({
      ok: s.wires.some((w) => w.resolution === 'accepted-short'),
      reason: 'no short wire has been accepted',
    }),
  }),
}

/** The closing step. */
export const closePurchase = purchaseStep({
  name: 'close-purchase',
  title: 'Close the purchase',
  requires: closeConditions,
  permits: { isOrganizer },
  handler: async (s, ctx) => {
    // The outcome is state; `end()` is the dormancy annotation beside it.
    ctx.end()
    return {
      ...s,
      purchase: { ...s.purchase, closedAt: '2026-08-20T17:00:00.000Z' },
      notes: [...s.notes, 'purchase closed'],
    }
  },
})

/**
 * Post-completion work as an ordinary step. A dormant case still computes
 * affordances and still executes them, so deed recording needs no
 * special machinery — only a guard that says the purchase must have closed
 * first.
 */
export const recordDeed = purchaseStep({
  name: 'record-deed',
  title: 'Record the deed',
  requires: {
    closed: (s) => ({
      ok: s.purchase.closedAt !== null,
      reason: 'the purchase has not closed',
    }),
    notRecorded: (s) => ({
      ok: s.purchase.deedRecordedAt === null,
      reason: 'the deed has already been recorded',
    }),
  },
  permits: { isOrganizer },
  handler: async (s) => ({
    ...s,
    purchase: { ...s.purchase, deedRecordedAt: '2026-09-12T00:00:00.000Z' },
    notes: [...s.notes, 'deed recorded'],
  }),
})

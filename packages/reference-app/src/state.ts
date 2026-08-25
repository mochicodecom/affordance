/**
 * The house purchase's Case State — the whole of what a group purchase *is*,
 * in this system.
 *
 * There is no status field, no stage, no current-step pointer, and nothing
 * that means "where we are". Every step's availability is computed
 * from the facts below, which is why a case can be picked up mid-flight by
 * definitions that did not exist when it started.
 *
 * Outcomes are state too: a closed purchase has `closedAt`, one whose
 * deed has been recorded has `deedRecordedAt`. Neither is an engine state,
 * and both are readable by ordinary conditions — which is what lets
 * post-completion work (deed recording, a late correction) be ordinary
 * guarded steps rather than special machinery.
 *
 * Every field is defaulted. That is not tidiness: a case created under an
 * earlier definition set and read by a later one must parse, and a condition
 * must be able to read a field that did not exist when the document was
 * written.
 */

import { z } from 'zod'

/** How a wire matched what was expected of it — the reconciliation exception. */
export const WireOutcome = z.enum([
  'pending',
  'matched',
  'short',
  'over',
  'wrong-account',
])

/** What a person decided about a wire that did not match. */
export const WireResolution = z.enum([
  'accepted-short',
  'refunded-over',
  'returned',
])

export const VerificationStatus = z.enum([
  'none',
  'pending',
  'clear',
  'review',
  'escalated',
  'rejected',
])

export const PurchaseState = z.object({
  purchase: z.object({
    address: z.string(),
    target: z.number().positive(),
    closedAt: z.string().nullable().default(null),
    /** The deed-recording outcome — a second ending, reachable only after closing. */
    deedRecordedAt: z.string().nullable().default(null),
  }),
  property: z
    .object({
      offerAcceptedAt: z.string().nullable().default(null),
      inspectionReportId: z.string().nullable().default(null),
    })
    .default({ offerAcceptedAt: null, inspectionReportId: null }),
  escrow: z
    .object({
      /** `requested` once the escrow company has the application; `open` once it says so. */
      status: z.enum(['none', 'requested', 'open']).default('none'),
      applicationId: z.string().nullable().default(null),
      accountId: z.string().nullable().default(null),
    })
    .default({ status: 'none', applicationId: null, accountId: null }),
  buyers: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().default(''),
        /** What they have said they will put in; `null` until they commit. */
        committed: z.number().nullable().default(null),
        verification: z
          .object({
            status: VerificationStatus.default('none'),
            checkId: z.string().nullable().default(null),
            /** When a hit put them into review — the basis the 7-day escalation counts from. */
            flaggedAt: z.string().nullable().default(null),
            hits: z.array(z.string()).default([]),
            escalatedAt: z.string().nullable().default(null),
          })
          .default({
            status: 'none',
            checkId: null,
            flaggedAt: null,
            hits: [],
            escalatedAt: null,
          }),
        agreement: z
          .object({
            envelopeId: z.string().nullable().default(null),
            signed: z.boolean().default(false),
            signedAt: z.string().nullable().default(null),
          })
          .nullable()
          .default(null),
      }),
    )
    .default([]),
  fundingCall: z
    .object({ amount: z.number(), issuedAt: z.string(), reference: z.string() })
    .nullable()
    .default(null),
  wires: z
    .array(
      z.object({
        id: z.string(),
        buyerId: z.string(),
        amount: z.number(),
        /** What the escrow company said the money came from — the wrong-account case. */
        fromAccount: z.string().default(''),
        receivedAt: z.string(),
        outcome: WireOutcome.default('pending'),
        resolution: WireResolution.nullable().default(null),
      }),
    )
    .default([]),
  notes: z.array(z.string()).default([]),
})

export type Purchase = z.output<typeof PurchaseState>
export type Buyer = Purchase['buyers'][number]
export type Wire = Purchase['wires'][number]

/** The app's own actor shape. The framework never owns identity. */
export interface PurchaseActor {
  readonly id: string
  readonly roles: readonly string[]
}

export const organizer: PurchaseActor = { id: 'org-1', roles: ['organizer'] }
export const escrowOfficer: PurchaseActor = {
  id: 'esc-1',
  roles: ['escrow-officer'],
}
/** What ingested events run as. */
export const integration = (system: string): PurchaseActor => ({
  id: `system:${system}`,
  roles: ['integration', 'organizer'],
})

export const buyerActor = (id: string): PurchaseActor => ({
  id,
  roles: ['buyer'],
})

export const hasRole = (
  actor: PurchaseActor | undefined,
  role: string,
): boolean => actor?.roles.includes(role) ?? false

/** The buyer a scoped step is bound to, or `null` — the shared lookup. */
export const buyerOf = (state: Purchase, id: string): Buyer | null =>
  state.buyers.find((buyer) => buyer.id === id) ?? null

/**
 * The buyer with this name, or throw. Buyer ids are the server's to mint,
 * so the demo script and the tests learn an id back from state by the name
 * they invited the buyer under; `caseId` only names the case in the error.
 */
export const buyerNamed = (
  state: Purchase,
  name: string,
  caseId: string,
): Buyer => {
  const buyer = state.buyers.find((entry) => entry.name === name)
  if (buyer === undefined)
    throw new Error(`no buyer named ${name} on ${caseId}`)
  return buyer
}

/**
 * The account a buyer is registered to wire from, derived from their id.
 * The escrow company reports which account a wire came from; a wire from
 * any other account is classified `wrong-account`. Stated here once so the
 * classifier and the mock escrow company cannot disagree about the
 * convention.
 */
export const registeredAccountOf = (buyerId: string): string => `ext_${buyerId}`

/**
 * Patch one buyer by id, immutably — the map every scoped handler
 * otherwise re-rolls. A handler's real content is its `patch`; the
 * plumbing lives here, once.
 */
export const updateBuyer = (
  state: Purchase,
  id: string,
  patch: (buyer: Buyer) => Buyer,
): Purchase => ({
  ...state,
  buyers: state.buyers.map((buyer) => (buyer.id === id ? patch(buyer) : buyer)),
})

/** Everything a wire needs before the purchase can close. */
export const wireSettled = (wire: Wire): boolean =>
  wire.outcome === 'matched' || wire.resolution !== null

/**
 * The money that counts as arrived: every wire not returned, optionally one
 * buyer's. The single counting rule shared by the close guard's `funded`
 * condition and the dev console's wire levers — it is stated here once so a
 * console can never disagree with the guard about whose money is in.
 */
export const arrivedAmount = (
  wires: readonly Wire[],
  buyerId?: string,
): number =>
  wires
    .filter(
      (wire) =>
        (buyerId === undefined || wire.buyerId === buyerId) &&
        wire.resolution !== 'returned',
    )
    .reduce((total, wire) => total + wire.amount, 0)

/**
 * The escrow company's levers: once the funding call is out, a committed
 * buyer's wire can be announced — but only while their un-returned wires
 * still total less than their commitment. The amount prefills the
 * remainder, so a short wire naturally offers the balance next, and a buyer
 * whose money has arrived offers nothing.
 *
 * Domain logic, so it lives here with {@link arrivedAmount} — the dev
 * console renders these, it never re-derives them, and cannot drift from
 * the guard.
 */
export const wireLevers = (
  state: Purchase,
): readonly { buyerId: string; name: string; amount: number }[] => {
  if (state.fundingCall === null || state.purchase.closedAt !== null) return []
  if (state.escrow.applicationId === null) return []
  return state.buyers
    .filter((buyer) => typeof buyer.committed === 'number')
    .map((buyer) => ({
      buyerId: buyer.id,
      name: buyer.name || buyer.id,
      amount:
        (buyer.committed as number) - arrivedAmount(state.wires, buyer.id),
    }))
    .filter((lever) => lever.amount > 0)
}

/**
 * An e-sign-shaped fixture: a scoped step that sends an envelope and
 * registers the correlation in the same commit, and a scoped step that
 * materializes what the provider eventually says.
 */

import { z } from 'zod'
import { caseType, step } from '../../src/model/index.js'

export const SigningState = z.object({
  purchase: z.object({
    address: z.string(),
    closedAt: z.string().nullable().default(null),
  }),
  buyers: z
    .array(
      z.object({
        id: z.string(),
        envelopeId: z.string().nullable().default(null),
        signedAt: z.string().nullable().default(null),
        declines: z.number().int().default(0),
      }),
    )
    .default([]),
  notes: z.array(z.string()).default([]),
})

export type Signing = z.output<typeof SigningState>
export type Signer = Signing['buyers'][number]

export const organizer = { id: 'ops-1', roles: ['organizer'] as const }

/** Sends the envelope and registers how the answer will come back — one commit. */
export const sendEnvelope = step({
  name: 'send-envelope',
  scope: {
    select: (s: Signing) => s.buyers.filter((i) => i.envelopeId === null),
    key: (i: Signer) => i.id,
  },
  handler: async (s: Signing, ctx): Promise<Signing> => {
    // Provider ids are globally unique, so the fixture's are too — an
    // envelope id repeated across cases would leave the registry routing
    // events to the wrong case.
    const envelopeId = `env_${ctx.caseId}_${ctx.scopeKey}`
    ctx.correlate({
      system: 'esign',
      externalId: envelopeId,
      step: 'record-signature',
    })
    return {
      ...s,
      buyers: s.buyers.map((buyer) =>
        buyer.id === ctx.scopeKey ? { ...buyer, envelopeId } : buyer,
      ),
    }
  },
})

/** Materializes the provider's answer. The step the webhook routes to. */
export const recordSignature = step({
  name: 'record-signature',
  scope: {
    select: (s: Signing) =>
      s.buyers.filter((i) => i.envelopeId !== null && i.signedAt === null),
    key: (i: Signer) => i.id,
  },
  input: z.object({ signedAt: z.string() }),
  handler: async (s: Signing, ctx): Promise<Signing> => ({
    ...s,
    buyers: s.buyers.map((buyer) =>
      buyer.id === ctx.scopeKey
        ? { ...buyer, signedAt: ctx.input.signedAt }
        : buyer,
    ),
    notes: [...s.notes, `signature recorded for ${ctx.scopeKey}`],
  }),
})

/** A step no envelope can reach while the purchase is open — the guard-refusal case. */
export const recordDecline = step({
  name: 'record-decline',
  scope: {
    select: (s: Signing) => s.buyers,
    key: (i: Signer) => i.id,
  },
  requires: {
    purchaseClosed: (s: Signing) => ({
      ok: s.purchase.closedAt !== null,
      reason: 'declines are only recorded after the purchase closes',
    }),
  },
  handler: async (s: Signing, ctx): Promise<Signing> => ({
    ...s,
    buyers: s.buyers.map((buyer) =>
      buyer.id === ctx.scopeKey
        ? { ...buyer, declines: buyer.declines + 1 }
        : buyer,
    ),
  }),
})

/** Case-level: an envelope registered without a scope element. */
export const recordPurchaseDocument = step({
  name: 'record-purchase-document',
  input: z.object({ documentId: z.string() }),
  handler: async (s: Signing, ctx): Promise<Signing> => ({
    ...s,
    notes: [...s.notes, `purchase document ${ctx.input.documentId}`],
  }),
})

/** A handler that always throws — the execution-failure dead letter. */
export const recordBrokenly = step({
  name: 'record-brokenly',
  retry: { maxAttempts: 1 },
  handler: async (): Promise<Signing> => {
    throw new Error('the materializing handler blew up')
  },
})

export const signing = caseType({
  name: 'signing',
  state: SigningState,
  steps: [
    sendEnvelope,
    recordSignature,
    recordDecline,
    recordPurchaseDocument,
    recordBrokenly,
  ],
})

export const twoBuyers = (): Signing =>
  SigningState.parse({
    purchase: { address: '12 Mochi Lane' },
    buyers: [{ id: 'buyer_a' }, { id: 'buyer_b' }],
  })

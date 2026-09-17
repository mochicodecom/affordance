/**
 * The house-purchase case type: one definition set, built against the
 * providers its handlers call. Binding happens here, at definition time —
 * two apps in one process each get definitions wired to their own providers,
 * with no shared registry to rebind and no install-before-execute ordering
 * rule.
 */

import type { CaseTypeDefinition } from '@affordance/core'
import { caseType } from '@affordance/core'
import type { PurchaseStep } from './operation.js'
import type { PurchaseActor } from './state.js'
import { PurchaseState } from './state.js'
import { createPurchaseSteps } from './steps.js'

/** The name every house-purchase case records. */
export const HOUSE_PURCHASE = 'house-purchase'

/**
 * Build the definition set against the providers its handlers call.
 *
 * The definition set does not declare what "finished" means — the framework
 * has no slot for it. A closed purchase has `purchase.closedAt`;
 * one whose deed is on record has `purchase.deedRecordedAt`. Both are
 * ordinary state read by ordinary conditions, which is how a client learns
 * them: `record-deed` is guarded on the first, so being offered
 * `record-deed` *is* being told the purchase closed.
 */
export const createPurchaseDefinition = (
  operations: PurchaseStep,
): CaseTypeDefinition<typeof PurchaseState, PurchaseActor> =>
  caseType({
    name: HOUSE_PURCHASE,
    state: PurchaseState,
    steps: createPurchaseSteps(operations),
  })

/** A fresh purchase's initial state — a house and nothing else. */
export const newPurchase = (address = '12 Mochi Lane', target = 1_000_000) => ({
  purchase: { address, target },
})

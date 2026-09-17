/** Purchase operations own their transaction, admission and provider dispatch. */
import type {
  CorrelationRequest,
  HandlerContext,
  ScopedStepOptions,
  StepDefinition,
  StepOptions,
} from '@affordance/core'
import {
  actor,
  evaluateGuard,
  StepNotAvailableError,
  stepsOf,
} from '@affordance/core'
import type { DatabaseAccess } from '@affordance/pg'
import { registerCorrelation, withTransaction } from '@affordance/pg'
import {
  loadPurchase,
  type PurchaseRepositories,
  protectPurchase,
  purchaseRepositories,
} from './repository.js'
import { type Purchase, type PurchaseActor, PurchaseState } from './state.js'
import type { PurchaseProviders } from './steps.js'

type Context<I> = HandlerContext<Purchase, PurchaseActor, I> & {
  readonly repos: PurchaseRepositories
  correlate(request: CorrelationRequest): void
  end(): void
}
type Options<I> = Omit<StepOptions<Purchase, PurchaseActor, I>, 'handler'> & {
  handler(ctx: Context<I>): Promise<void>
}
type ScopedOptions<E, I> = Omit<
  ScopedStepOptions<Purchase, E, PurchaseActor, I>,
  'handler'
> & { handler(ctx: Context<I> & { scope: E; scopeKey: string }): Promise<void> }
export interface PurchaseStep {
  <E, I = undefined>(
    options: ScopedOptions<E, I>,
  ): StepDefinition<Purchase, PurchaseActor>
  <I = undefined>(options: Options<I>): StepDefinition<Purchase, PurchaseActor>
}

export const purchaseOperations = (
  db: DatabaseAccess,
  providers: PurchaseProviders,
): PurchaseStep => {
  const define = stepsOf(PurchaseState, actor<PurchaseActor>())
  const operation = (
    options: Options<unknown> | ScopedOptions<unknown, unknown>,
  ) => {
    const definition =
      'scope' in options
        ? define({ ...options, handler: async () => {} })
        : define({ ...options, handler: async () => {} })
    return {
      ...definition,
      handler: async (
        ctx: HandlerContext<Purchase, PurchaseActor, unknown> & {
          scopeKey?: string
        },
      ) => {
        const state = await withTransaction(db, async (tx) => {
          await protectPurchase(tx, ctx.reference)
          const current = await loadPurchase(tx, ctx.reference)
          const scope = definition.scope
            ?.select(current)
            .find((item) => definition.scope?.key(item) === ctx.scopeKey)
          if (definition.scope && scope === undefined)
            throw new Error('purchase scope no longer exists')
          const guard = evaluateGuard(definition.guard, {
            state: current,
            actor: ctx.actor,
            asOf: new Date().toISOString(),
            ...(definition.scope ? { scope, scopeKey: ctx.scopeKey } : {}),
          })
          if (!guard.available)
            throw new StepNotAvailableError(
              ctx.caseId,
              definition.name,
              ctx.scopeKey ?? null,
              guard,
            )
          const correlations: CorrelationRequest[] = []
          let ended = false
          const local = {
            ...ctx,
            state: current,
            repos: purchaseRepositories(tx, ctx.reference),
            scope,
            scopeKey: ctx.scopeKey ?? '',
            correlate: (r: CorrelationRequest) => {
              correlations.push(r)
            },
            end: () => {
              ended = true
            },
          }
          await options.handler(local)
          // Framework metadata is explicitly written by this application transaction.
          for (const r of correlations)
            await registerCorrelation(tx, {
              ...r,
              caseId: ctx.caseId,
              scopeKey:
                r.scopeKey === undefined ? (ctx.scopeKey ?? null) : r.scopeKey,
            })
          if (ended)
            await tx.query(
              'update affordance.cases set ended_at=clock_timestamp() where id=$1',
              [ctx.caseId],
            )
          return loadPurchase(tx, ctx.reference)
        })
        const buyer = state.buyers.find((b) => b.id === ctx.scopeKey)
        // The sample provider calls are synchronous dispatch. Failures propagate;
        // committed domain effects remain and no success diff is fabricated.
        if (definition.name === 'open-escrow')
          providers.applyForEscrowAccount({
            address: state.purchase.address,
            requestId: state.escrow.applicationId!,
          })
        if (definition.name === 'start-verification' && buyer)
          providers.startVerification({
            buyerId: buyer.id,
            requestId: buyer.verification.checkId!,
            ...(buyer.name.includes('(hit)')
              ? { hits: ['sanctions:OFAC'] }
              : {}),
          })
        if (definition.name === 'send-agreement' && buyer)
          providers.sendEnvelope({
            buyerId: buyer.id,
            requestId: buyer.agreement!.envelopeId!,
          })
        return state
      },
    }
  }
  return operation as PurchaseStep
}

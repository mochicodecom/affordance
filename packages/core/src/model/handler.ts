/** Domain operations run inside an adapter's short atomic case operation.
 * Network work belongs to the adopter's orchestration, outside this handler.
 */
export interface CorrelationRequest {
  /** The external system, as the app names it: `'esign'`, `'verify'`, `'escrow'`. */
  readonly system: string
  /** The identifier that system will quote back. */
  readonly externalId: string
  /** Defaults to the Execution's own scope key on a scoped step; pass `null` for case-level. */
  readonly scopeKey?: string | null
  /** The step an event on this identifier should execute — usually the materializing step. */
  readonly step?: string | null
  /** Anything the app wants to keep alongside the mapping. */
  readonly metadata?: unknown
}

export interface HandlerContext<
  TState,
  TActor = unknown,
  TInput = undefined,
  TRepos = unknown,
> {
  readonly executionId: string
  readonly caseId: string
  readonly reference: string
  readonly state: TState
  readonly actor: TActor
  readonly input: TInput
  readonly repos: TRepos
  correlate(request: CorrelationRequest): void
  end(): void
  reopen(): void
}
export interface ScopedHandlerContext<
  TState,
  TElement,
  TActor = unknown,
  TInput = undefined,
  TRepos = unknown,
> extends HandlerContext<TState, TActor, TInput, TRepos> {
  readonly scope: TElement
  readonly scopeKey: string
}
export type StepHandler<
  TState,
  TActor = unknown,
  TInput = undefined,
  TRepos = unknown,
> = (ctx: HandlerContext<TState, TActor, TInput, TRepos>) => Promise<void>
export type ScopedStepHandler<
  TState,
  TElement,
  TActor = unknown,
  TInput = undefined,
  TRepos = unknown,
> = (
  ctx: ScopedHandlerContext<TState, TElement, TActor, TInput, TRepos>,
) => Promise<void>
export type ErasedStepHandler<TState, TActor = unknown, TRepos = unknown> = (
  ctx:
    | HandlerContext<TState, TActor, unknown, TRepos>
    | ScopedHandlerContext<TState, unknown, TActor, unknown, TRepos>,
) => Promise<void>

/** Handlers own persistence, transactions and external calls. Returned State is journal evidence only. */
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

export interface HandlerContext<TState, TActor = unknown, TInput = undefined> {
  readonly executionId: string
  readonly caseId: string
  readonly reference: string
  readonly state: TState
  readonly actor: TActor
  readonly input: TInput
}
export interface ScopedHandlerContext<
  TState,
  TElement,
  TActor = unknown,
  TInput = undefined,
> extends HandlerContext<TState, TActor, TInput> {
  readonly scope: TElement
  readonly scopeKey: string
}
export type StepHandler<TState, TActor = unknown, TInput = undefined> = (
  ctx: HandlerContext<TState, TActor, TInput>,
  // biome-ignore lint/suspicious/noConfusingVoidType: Accept async handlers that intentionally return no value.
) => Promise<NoInfer<TState> | void>
export type ScopedStepHandler<
  TState,
  TElement,
  TActor = unknown,
  TInput = undefined,
> = (
  ctx: ScopedHandlerContext<TState, TElement, TActor, TInput>,
  // biome-ignore lint/suspicious/noConfusingVoidType: Accept async handlers that intentionally return no value.
) => Promise<NoInfer<TState> | void>
export type ErasedStepHandler<TState, TActor = unknown> = (
  ctx:
    | HandlerContext<TState, TActor, unknown>
    | ScopedHandlerContext<TState, unknown, TActor, unknown>,
  // biome-ignore lint/suspicious/noConfusingVoidType: Accept async handlers that intentionally return no value.
) => Promise<NoInfer<TState> | void>

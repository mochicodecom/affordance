/**
 * Handler types.
 *
 * A **handler** is a step's effect function — the only thing that mutates
 * Case State (CONTEXT.md). It receives the current Case State and an
 * execution context, and returns the **next** Case State document; the
 * execution lifecycle derives the journaled delta from
 * (previous, next).
 *
 * Handlers are short-lived, at-least-once and idempotent: the
 * same handler may run more than once for the same Execution, so every
 * external effect must be deduplicated on `ctx.executionId`. Nothing in the
 * model layer ever invokes a handler — `packages/core/src/execution` does.
 */

import type { Queryable } from '../store/index.js'

/**
 * A write to run inside the framework's **commit** transaction, registered
 * from a handler via `ctx.onCommit`. It receives the transaction handle
 * the framework is committing Case State on, so app-table writes land
 * atomically with the case row and the journal entry. This is the
 * shared-transaction seam — the one point where app writes join the
 * framework's transaction — and it avoids holding a transaction open across
 * the handler's external calls.
 *
 * A callback that throws aborts the whole commit: nothing is written, the
 * attempt is journaled as failed, and the retry policy applies.
 */
export type CommitWrite = (tx: Queryable) => Promise<void>

/**
 * What a handler registers when it hands work to an external system
 *: "this envelope id is how the answer will come back". The case
 * is implicit — it is the one the handler is running on — and for a scoped
 * step the scope element is too.
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

/**
 * The context a handler receives alongside Case State.
 *
 * `executionId` is the idempotency key: handlers run at-least-once, so any
 * external effect must be deduplicated on it. `attempt` /
 * `maxAttempts` let a handler tell a first try from a retry.
 */
export interface HandlerContext<TActor = unknown, TInput = undefined> {
  /** Unique id of this Execution — the handler's idempotency key. */
  readonly executionId: string
  /** The case this Execution runs on. */
  readonly caseId: string
  /** The Actor the step is being executed as (app-defined shape). */
  readonly actor: TActor
  /**
   * The step's input, validated against the step's `input` schema before the
   * handler runs (`undefined` for steps that declare no input schema).
   */
  readonly input: TInput
  /** 1-based attempt number for this Execution; > 1 means a retry of the same `executionId`. */
  readonly attempt: number
  /** Total attempts this Execution is allowed, from the step's retry policy. */
  readonly maxAttempts: number

  /**
   * Register an app-table write to run inside the framework's commit
   * transaction, so it commits atomically with the new Case State.
   * Callbacks run in registration order; registrations from a failed attempt
   * are discarded before the next attempt.
   */
  onCommit(write: CommitWrite): void

  /**
   * Register an external identifier against this case (and, on a scoped
   * step, this element) so the eventual webhook can be routed back.
   * Correlation is one half of integrating an external system; Ingestion —
   * executing the routed event as an ordinary step — is the other.
   *
   * Written inside the commit transaction, like any `onCommit` write: a case
   * cannot end up having sent an envelope whose answer it could not route,
   * because the sending and the mapping are the same commit.
   */
  correlate(request: CorrelationRequest): void

  /**
   * Mark the case dormant: a journaled terminal marker written with this
   * Execution's commit. Dormancy means exclusion from
   * default active listings — **never** a freeze: a dormant case still
   * computes affordances, and a step guarded on ended state can still claim
   * and {@link HandlerContext.reopen} it.
   */
  end(): void

  /** Clear the dormancy marker — un-ending is an ordinary step. */
  reopen(): void
}

/** The context a scoped step's handler receives: the base context plus the scope binding. */
export interface ScopedHandlerContext<
  TElement,
  TActor = unknown,
  TInput = undefined,
> extends HandlerContext<TActor, TInput> {
  /** The bound scope element the Execution is about (e.g. one buyer). */
  readonly scope: TElement
  /** The element's scope key — half of the affordance's identity. */
  readonly scopeKey: string
}

/**
 * An unscoped step's handler: async, receives the current Case State and the
 * execution context, and returns the **next** Case State document.
 */
export type StepHandler<TState, TActor = unknown, TInput = undefined> = (
  state: TState,
  ctx: HandlerContext<TActor, TInput>,
) => Promise<TState>

/** A scoped step's handler: as {@link StepHandler}, with the scope binding on ctx. */
export type ScopedStepHandler<
  TState,
  TElement,
  TActor = unknown,
  TInput = undefined,
> = (
  state: TState,
  ctx: ScopedHandlerContext<TElement, TActor, TInput>,
) => Promise<TState>

/**
 * A handler as held on a normalized {@link StepDefinition}: the authoring
 * generics (input, scope element) erased. The execution lifecycle invokes
 * through this type, constructing a context that satisfies the authored shape
 * (the model layer guarantees input was validated and, for scoped steps, a
 * scope is bound).
 */
export type ErasedStepHandler<TState, TActor = unknown> = (
  state: TState,
  ctx:
    | HandlerContext<TActor, unknown>
    | ScopedHandlerContext<unknown, TActor, unknown>,
) => Promise<TState>

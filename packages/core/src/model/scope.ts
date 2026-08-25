/**
 * Scoped steps.
 *
 * A step may declare a **scope** over a state collection: each element the
 * scope selects yields one independent affordance, and the affordance's
 * identity is (step name × scope key) — `escalate-verification(buyer_007)`. Journal
 * entries, correlation keys, and execution requests all address a scoped
 * step by that pair, so the key must be **stable**: derived from the
 * element's own identity (an id the app owns), never from its position in
 * the collection.
 */

import type {
  ConditionContext,
  ConditionMapEntry,
  ConditionOutcome,
} from '../guards/index.js'

/**
 * A step's scope declaration: which elements of case state the step ranges
 * over, and how each element is identified.
 *
 * - `select` — pure selector over case state returning the matching elements
 *   (e.g. `s => s.buyers.filter(b => b.verification?.status === 'review')`).
 *   Subject to the same discipline as conditions: synchronous,
 *   side-effect-free, total over historical state.
 * - `key` — derives the element's **scope key**, a non-empty string that is
 *   stable for the life of the element and unique within one selection
 *   (typically `i => i.id`). The framework deliberately does not require an
 *   `id` field on elements: state schemas are app-owned, so identity
 *   derivation is declared, not assumed. Duplicate or invalid keys are an
 *   identity-corruption bug and fail affordance computation loudly
 *   ({@link ScopeKeyError}).
 */
export interface ScopeDeclaration<TState, TElement> {
  readonly select: (state: TState) => readonly TElement[]
  readonly key: (element: TElement) => string
}

/**
 * The context a scoped step's conditions receive: the base condition context
 * with the bound scope element present and typed. Authors read the element
 * as `ctx.scope` with no need to narrow away `undefined` — the engine always
 * binds it when evaluating a scoped step.
 */
export type ScopedConditionContext<
  TElement,
  TActor = unknown,
> = ConditionContext<TActor, TElement> & {
  readonly scope: TElement
}

/**
 * A condition of a scoped step: same contract as {@link Condition} — pure,
 * synchronous, total, clock-free — receiving the whole case state first and
 * the bound scope element via `ctx.scope`, so cross-cutting facts stay
 * expressible (`(s, ctx) => (ctx.scope.committed ?? 0) <
 * (s.fundingCall?.amount ?? 0)`).
 */
export type ScopedCondition<TState, TElement, TActor = unknown> = (
  state: TState,
  ctx: ScopedConditionContext<TElement, TActor>,
) => ConditionOutcome

/**
 * What may sit under a name in a scoped step's `requires`/`permits`: a
 * scoped condition.
 *
 * `anyOf` groups are not part of the scoped guard surface (the unscoped
 * algebra keeps them); adding a scoped-typed `anyOf` later is an additive
 * change.
 */
export type ScopedConditionMapEntry<
  TState,
  TElement,
  TActor = unknown,
> = ScopedCondition<TState, TElement, TActor>

/** A flat AND-map of named scoped conditions — the scoped counterpart of `ConditionMap`. */
export type ScopedConditionMap<TState, TElement, TActor = unknown> = Readonly<
  Record<string, ScopedConditionMapEntry<TState, TElement, TActor>>
>

/**
 * Erase a scoped condition map to the guards module's entry shape so the
 * engine can hand a scoped step's guard to `evaluateGuard` unchanged. Sound
 * because evaluation of a scoped guard always binds `scope` (which the
 * scoped condition context requires).
 */
export const eraseScopedConditionMap = <TState, TElement, TActor>(
  map: ScopedConditionMap<TState, TElement, TActor> | undefined,
): Readonly<Record<string, ConditionMapEntry<TState, TActor>>> | undefined =>
  map as unknown as
    | Readonly<Record<string, ConditionMapEntry<TState, TActor>>>
    | undefined

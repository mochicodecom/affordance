/**
 * Named conditions — the unit of explainability.
 *
 * A guard is a set of independently-evaluated named conditions, never an
 * opaque boolean closure. Every consumer of the framework's answer to "what
 * can happen now" — affordance listings, `explain`, the journal's
 * guard-results field — leans on conditions being
 * structured, synchronous, and side-effect-free.
 */

/**
 * The escape-hatch result form: a condition may return `{ ok, reason? }`
 * instead of a bare boolean when it wants to say *why* it failed (or passed)
 * in domain language. The `reason` surfaces verbatim in the evaluation
 * record, and from there in `explain` and the journal.
 */
export interface ConditionVerdict {
  readonly ok: boolean
  readonly reason?: string
}

/**
 * What a condition may return: a bare boolean, or a {@link ConditionVerdict}
 * carrying a reason. Nothing else — in particular no `Promise`. A `Promise`
 * is not assignable to this type, which is what makes async conditions
 * inexpressible rather than merely discouraged.
 */
export type ConditionOutcome = boolean | ConditionVerdict

/**
 * The context a condition receives alongside case state.
 *
 * Carries the acting actor — opaque to the framework; the app owns identity
 * and roles. Deliberately carries no
 * clock: a condition can never read "now", so that evaluation
 * "as of T" stays well-defined and deterministic.
 *
 * Scoped steps: when a scoped step's guard is evaluated for
 * one element of its scoped collection, the bound element rides here as
 * `ctx.scope` — e.g. one buyer of `s.buyers` — so a condition can read
 * both the whole case state (its first argument) and the element the
 * affordance is about. For unscoped evaluation `scope` is absent. This is the
 * additive extension the original context reserved; conditions written
 * before it exist keep compiling and behaving identically.
 */
export interface ConditionContext<TActor = unknown, TScope = unknown> {
  /** The acting actor — app-defined shape; the framework never owns identity. */
  readonly actor: TActor
  /**
   * The bound scope element, when evaluating a scoped step's guard for one
   * element of its scoped collection. Absent for unscoped steps.
   * The model layer's scoped-condition types narrow this to the element type
   * and make it non-optional for scoped-step authors.
   */
  readonly scope?: TScope
}

/**
 * One named, pure, synchronous predicate within a guard — the unit of
 * explainability.
 *
 * A condition must be:
 *
 * - **Synchronous.** Enforced by type: the return type admits no `Promise`,
 *   so an `async` condition is a type error.
 * - **Side-effect-free.** Conditions are evaluated freely and repeatedly —
 *   for affordance listings, `explain`, transactional re-evaluation at
 *   execution time, and historical reconstruction. They must not mutate
 *   state, log, or touch the outside world.
 * - **Total over historical state.** Cases float to the latest
 *   definitions, so a condition WILL be evaluated against state written
 *   before the condition existed. Handle absence deliberately with the
 *   `?? fallback` discipline — `s.split?.confirmed ?? false` — and
 *   never assume a field exists just because current handlers write it.
 *   This cannot be enforced by types; it is the baseline discipline every
 *   condition author owes the cases already in flight.
 * - **Clock-free.** Never read `Date.now()` or `new Date()` — a condition's
 *   answer must be a function of (state, actor) alone.
 *
 * A condition should never throw. If one does (typically a totality bug
 * against sparse historical state), evaluation does not propagate the throw:
 * the condition is reported as failed with the thrown message as its reason,
 * so one buggy condition degrades one answer, not the whole case.
 *
 * @typeParam TState - the case state document the condition reads. Conditions
 *   of a scoped step also receive the whole case state here; the
 *   bound scope element arrives via `ctx.scope`.
 * @typeParam TActor - the app-defined actor shape; opaque to the framework.
 */
export type Condition<TState, TActor = unknown> = (
  state: TState,
  ctx: ConditionContext<TActor>,
) => ConditionOutcome

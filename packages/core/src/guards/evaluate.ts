/**
 * Guard evaluation — pure, deterministic, explainable.
 *
 * `evaluateGuard(guard, ctx)` turns a guard and an evaluation context
 * (case state, actor, asOf) into a full per-condition evaluation record:
 * the raw material for affordance computation, `explain`, and
 * the journal's guard-results field.
 */

import { thrownMessage } from '../errors.js'
import type {
  Condition,
  ConditionContext,
  ConditionOutcome,
} from './condition.js'
import type { Guard, GuardArm, GuardEntry, GuardSection } from './guard.js'
import { conditionAddress, guardEntries } from './guard.js'
import type { Instant } from './time.js'
import { toIso } from './time.js'

/**
 * Everything guard evaluation is a function of: case state, the acting
 * actor, and the instant to evaluate as of. Nothing else — no ambient
 * clock, no I/O — so the same context always produces the same record.
 *
 * `asOf` is explicit and mandatory: it is the instant the evaluation is
 * made as of, stated on the record so the journal's claim-time evidence is
 * self-contained.
 *
 * Scoped steps: when evaluating a scoped step's guard for
 * one element of its scoped collection, bind the element as `scope`. It is
 * threaded through to conditions via {@link ConditionContext}. When
 * `scope` is absent, evaluation is exactly what it always was.
 */
export interface GuardEvaluationContext<TState, TActor = unknown> {
  readonly state: TState
  readonly actor: TActor
  readonly asOf: Instant
  /**
   * The bound scope element, when evaluating a scoped step's guard for one
   * element. Threaded to conditions as `ctx.scope`. Omit for unscoped
   * evaluation. `undefined` means "not scoped" — a scope binding is always a
   * present element of a state collection.
   */
  readonly scope?: unknown
}

/** Fields common to every per-condition result in an evaluation record. */
export interface ConditionResultBase {
  /** The condition's name in its section map (or its arm name, within an anyOf group). */
  readonly name: string
  /** Which guard section the condition came from — `requires` or `permits`. */
  readonly section: GuardSection
  readonly passed: boolean
  /**
   * Present when the condition supplied one via the `{ ok, reason? }`
   * escape hatch, or when evaluation had to absorb a defect (a condition
   * that threw, or returned an unrecognized result).
   */
  readonly reason?: string
}

/** Result of one plain (predicate) condition. */
export interface SingleConditionResult extends ConditionResultBase {
  readonly kind: 'condition'
}

/** Result of one arm of an `anyOf` group; `name` is the arm name. */
export type AnyOfArmResult = SingleConditionResult

/**
 * Result of an `anyOf` group: passed when at least one arm passed. Every
 * arm is always evaluated and reported, so a failing group names each
 * failing arm and a passing group shows which arm carried it.
 */
export interface AnyOfConditionResult extends ConditionResultBase {
  readonly kind: 'anyOf'
  readonly arms: readonly AnyOfArmResult[]
}

/** Result of one named entry in a guard section. */
export type ConditionResult = SingleConditionResult | AnyOfConditionResult

/**
 * The full record of one guard evaluation — a plain, JSON-serializable
 * object, deterministic in (guard, state, actor, asOf). This is what
 * affordance computation filters on, what `explain` renders, and what the
 * journal stores as an execution's guard results.
 *
 * The `possible` / `permitted` pair is the requires/permits split made mechanical:
 * `possible` is false when a `requires` condition is unmet (the step is not
 * possible on this case, for anyone); `permitted` is false when a `permits`
 * condition is unmet (not permitted for this actor). `available` is their
 * conjunction. An omitted section is vacuously satisfied.
 */
export interface GuardEvaluation {
  /** The instant evaluated as of, normalized to ISO-8601 UTC. */
  readonly asOf: string
  /** Every `requires` condition holds — the step is possible on this case. */
  readonly possible: boolean
  /** Every `permits` condition holds — the actor is permitted. */
  readonly permitted: boolean
  /** `possible && permitted` — the step is an affordance for this actor. */
  readonly available: boolean
  /** Per-condition results, in guard declaration order (`requires` first). */
  readonly conditions: readonly ConditionResult[]
}

/**
 * Marker for evaluating a guard with no actor at hand — `explain`'s
 * requires-only probe. A `permits` condition is the only kind of entry
 * that reads the actor, so it alone is skipped: reported failed with
 * {@link NOT_EVALUATED_REASON} rather than run against nothing and absorbed
 * as a thrown `TypeError`.
 */
export const NO_ACTOR: unique symbol = Symbol('affordance.no-actor')

/** The stated reason a `permits` condition reports under {@link NO_ACTOR}. */
export const NOT_EVALUATED_REASON = 'not evaluated: no actor supplied'

const withReason = <T extends object>(
  result: T,
  reason: string | undefined,
): T & { reason?: string } =>
  reason === undefined ? result : { ...result, reason }

/** Evaluate one plain condition, absorbing throws and malformed outcomes into a failed result. */
const evaluateCondition = <TState, TActor>(
  name: string,
  section: GuardSection,
  condition: Condition<TState, TActor>,
  state: TState,
  ctx: ConditionContext<TActor>,
): SingleConditionResult => {
  if (section === 'permits' && (ctx.actor as unknown) === NO_ACTOR) {
    return {
      name,
      section,
      kind: 'condition',
      passed: false,
      reason: NOT_EVALUATED_REASON,
    }
  }
  let outcome: ConditionOutcome
  try {
    outcome = condition(state, ctx)
  } catch (err) {
    return {
      name,
      section,
      kind: 'condition',
      passed: false,
      reason: `condition threw: ${thrownMessage(err)}`,
    }
  }
  if (typeof outcome === 'boolean') {
    return { name, section, kind: 'condition', passed: outcome }
  }
  if (
    typeof outcome === 'object' &&
    outcome !== null &&
    typeof outcome.ok === 'boolean'
  ) {
    return withReason(
      { name, section, kind: 'condition' as const, passed: outcome.ok },
      outcome.reason,
    )
  }
  return {
    name,
    section,
    kind: 'condition',
    passed: false,
    reason:
      'condition returned neither a boolean nor an { ok, reason? } verdict',
  }
}

const MALFORMED = 'entry is not a condition function or an anyOf(...) group'

const malformed = (
  name: string,
  section: GuardSection,
): SingleConditionResult => ({
  name,
  section,
  kind: 'condition',
  passed: false,
  reason: MALFORMED,
})

/** Evaluate one arm of an `anyOf` group; the arm's own name is what it reports under. */
const evaluateArm = <TState, TActor>(
  arm: GuardArm<TState, TActor>,
  state: TState,
  ctx: ConditionContext<TActor>,
): AnyOfArmResult => {
  if (arm.kind === 'condition') {
    return evaluateCondition(
      arm.arm,
      arm.section,
      arm.entry as Condition<TState, TActor>,
      state,
      ctx,
    )
  }
  return malformed(arm.arm, arm.section)
}

/** Evaluate one walked guard entry (plain condition or anyOf group). */
const evaluateEntry = <TState, TActor>(
  entry: GuardEntry<TState, TActor>,
  state: TState,
  ctx: ConditionContext<TActor>,
): ConditionResult => {
  const { name, section } = entry
  if (entry.kind === 'condition') {
    return evaluateCondition(
      name,
      section,
      entry.entry as Condition<TState, TActor>,
      state,
      ctx,
    )
  }
  if (entry.kind === 'anyOf') {
    const arms = entry.arms.map((arm) => evaluateArm(arm, state, ctx))
    return {
      name,
      section,
      kind: 'anyOf',
      passed: arms.some((a) => a.passed),
      arms,
    }
  }
  return malformed(name, section)
}

/**
 * Evaluate a guard against (case state, actor, asOf) and return the full
 * evaluation record.
 *
 * Guarantees the rest of the engine leans on:
 *
 * - **Pure and deterministic.** No I/O, no ambient clock; the same
 *   (guard, state, actor, asOf) always yields a deeply-equal record.
 * - **Complete.** Every condition — including every arm of every `anyOf`
 *   group — is evaluated and reported; there is no short-circuiting, so the
 *   record always answers "why / why not" in full.
 * - **Total.** A condition that throws, or returns a malformed
 *   outcome, becomes a failed result with a diagnostic `reason`; one
 *   defective condition can never take down affordance computation for a
 *   case. (The only throw is a `TypeError` when `ctx.asOf` itself is not a
 *   determinable instant — that is a caller bug, not case data.)
 * - **Serializable.** The record is a plain object with only JSON-safe
 *   values, ready for the journal's guard-results field verbatim.
 */
export const evaluateGuard = <TState, TActor = unknown>(
  guard: Guard<TState, TActor>,
  ctx: GuardEvaluationContext<TState, TActor>,
): GuardEvaluation => {
  const asOf = toIso(ctx.asOf)
  const conditionCtx: ConditionContext<TActor> =
    ctx.scope === undefined
      ? { actor: ctx.actor }
      : { actor: ctx.actor, scope: ctx.scope }
  const conditions = guardEntries(guard).map((entry) =>
    evaluateEntry(entry, ctx.state, conditionCtx),
  )
  const holds = (section: GuardSection): boolean =>
    conditions.every((result) => result.section !== section || result.passed)
  const possible = holds('requires')
  const permitted = holds('permits')
  return {
    asOf,
    possible,
    permitted,
    available: possible && permitted,
    conditions,
  }
}

/**
 * The unmet conditions of an evaluation — the derived view every consumer
 * of a refusal renders. A view, not a convention: the error message, the
 * blocked entry and the wire payload all call this instead of each spelling
 * `conditions.filter(!passed)` for themselves.
 */
export const unmetConditions = (
  evaluation: GuardEvaluation,
): readonly ConditionResult[] =>
  evaluation.conditions.filter((condition) => !condition.passed)

/** One unmet condition, addressed — `requires.financing.preApproved` — with its reason when it gave one. */
export interface AddressedUnmet {
  /** See {@link conditionAddress}: `section.name`, or `section.name.arm` inside an `anyOf`. */
  readonly address: string
  readonly reason?: string
}

/**
 * The unmet conditions of an evaluation, flattened to addresses. An `anyOf`
 * group that failed names each failing arm — the same addresses `explain`
 * uses — so a refusal never says less than the
 * evaluation knows.
 */
export const unmetAddresses = (
  evaluation: GuardEvaluation,
): readonly AddressedUnmet[] =>
  unmetConditions(evaluation).flatMap((result): readonly AddressedUnmet[] => {
    if (result.kind === 'anyOf') {
      return result.arms
        .filter((arm) => !arm.passed)
        .map((arm) => ({
          address: conditionAddress(result.section, result.name, arm.name),
          ...(arm.reason !== undefined && { reason: arm.reason }),
        }))
    }
    return [
      {
        address: conditionAddress(result.section, result.name),
        ...(result.reason !== undefined && { reason: result.reason }),
      },
    ]
  })

/** Render the unmet conditions as one message clause: `requires.a — why; permits.b`. */
export const describeUnmet = (evaluation: GuardEvaluation): string =>
  unmetAddresses(evaluation)
    .map((unmet) =>
      unmet.reason === undefined
        ? unmet.address
        : `${unmet.address} — ${unmet.reason}`,
    )
    .join('; ')

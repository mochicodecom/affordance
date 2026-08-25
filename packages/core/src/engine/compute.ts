/**
 * Affordance computation — the pure core of the engine.
 *
 * `computeAffordances` turns (case type, case snapshot, actor, asOf) into
 * the framework's HATEOAS answer: every step's guard evaluated (with scope
 * fan-out), split into available **affordances** and blocked steps with
 * their unmet named conditions, "not possible" mechanically distinct from
 * "not permitted for this actor". `computeExplanation` is the same
 * machinery pointed at one step, returning the full per-condition record.
 *
 * Both are pure: no I/O, no clock — `asOf` is explicit (the
 * *engine* defaults it to now at its boundary, never a condition). The
 * records are plain JSON-serializable objects, deterministic in their
 * inputs — the affordance JSON contract will serialize them
 * verbatim.
 *
 * Addressing a step and binding its scope element is `../model/target.js`'s
 * job rather than this module's: it is a fact about a step definition and a
 * state, and every other consumer of it — the claim,
 * audit replay — would otherwise have to import the engine to reach it.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec'
import type {
  ConditionResult,
  GuardEvaluation,
  Instant,
} from '../guards/index.js'
import { NO_ACTOR, toIso, unmetConditions } from '../guards/index.js'
import type { CaseTypeDefinition, ComputationContext } from '../model/index.js'
import {
  addressTarget,
  evaluateTarget,
  scopeFailureEvaluation,
  selectTargets,
} from '../model/index.js'

/**
 * The slice of a case the pure computation needs: identity, state, dormancy.
 * The engine builds it from a store handle; tests may construct one directly.
 */
export interface CaseSnapshot<TState> {
  readonly id: string
  readonly state: TState
  /** Dormancy marker (`end()`): a dormant case still computes — dormancy is never a freeze. */
  readonly endedAt: Date | string | null
}

/**
 * One available affordance: a step (with its scope binding, if scoped) this
 * actor can take now. Deliberately silent about the step's input — how an
 * input is described to a caller is the adapter's translation
 * (`Engine.inputSchemaFor` is the registry read it serializes from), and a
 * second channel here could only drift from it.
 */
export interface Affordance {
  readonly step: string
  /** The bound element's scope key — present iff the step is scoped. */
  readonly scopeKey?: string
}

/**
 * A step (× scope element, if scoped) that is currently not available, with
 * the unmet named conditions saying why. `possible === false` means unmet
 * `requires` — not possible on this case, for anyone; `permitted === false`
 * means unmet `permits` — not permitted for this actor.
 */
export interface BlockedStep {
  readonly step: string
  readonly scopeKey?: string
  readonly possible: boolean
  readonly permitted: boolean
  /**
   * The failed condition results, verbatim from guard evaluation — named,
   * sectioned, with reasons and (for `after` conditions) basis/flip instants.
   */
  readonly unmet: readonly ConditionResult[]
}

/** The serializable affordances record for one case, one actor, one instant. */
export interface CaseAffordances {
  readonly caseId: string
  readonly caseTypeName: string
  /** The instant evaluated as of (ISO-8601 UTC). */
  readonly asOf: string
  /** Dormancy marker (ISO-8601 UTC), `null` while the case is active. A dormant case still computes. */
  readonly endedAt: string | null
  /** Available affordances, in step declaration order (scoped: selection order within a step). */
  readonly affordances: readonly Affordance[]
  /** Blocked steps (× scope element) with their unmet named conditions. */
  readonly blocked: readonly BlockedStep[]
}

/** The full per-condition breakdown for one step (× scope element, if scoped). */
export interface AffordanceExplanation {
  readonly caseId: string
  readonly caseTypeName: string
  readonly step: string
  /** The scope binding the explanation is about — present iff the step is scoped. */
  readonly scopeKey?: string
  readonly asOf: string
  readonly endedAt: string | null
  /** The guards module's full evaluation record: every condition, passed and failed. */
  readonly evaluation: GuardEvaluation
}

const toIsoOrNull = (value: Instant | null): string | null =>
  value === null ? null : toIso(value)

// The verdict lives with the model (`scopeFailureEvaluation`); this only
// reshapes it into a blocked entry.
const scopeFailureEntry = (
  stepName: string,
  asOf: string,
  reason: string,
): BlockedStep => {
  const evaluation = scopeFailureEvaluation(asOf, { reason })
  return {
    step: stepName,
    possible: evaluation.possible,
    permitted: evaluation.permitted,
    unmet: unmetConditions(evaluation),
  }
}

const toAffordance = (stepName: string, scopeKey?: string): Affordance => ({
  step: stepName,
  ...(scopeKey !== undefined && { scopeKey }),
})

const toBlocked = (
  stepName: string,
  evaluation: GuardEvaluation,
  scopeKey?: string,
): BlockedStep => ({
  step: stepName,
  ...(scopeKey !== undefined && { scopeKey }),
  possible: evaluation.possible,
  permitted: evaluation.permitted,
  unmet: unmetConditions(evaluation),
})

/**
 * Compute the affordances record for one case snapshot: every step's guard
 * evaluated against (state, actor, asOf); scoped steps fan out to one
 * independent evaluation per selected element. Handlers are never
 * touched — this is a read (guards advise; enforcement is the claim's job).
 *
 * A scoped step whose selector is defective is absorbed into a blocked entry
 * under the synthetic `$scope` condition (one defective selector must not
 * take down the case's listing); scope-*key* integrity violations throw
 * `ScopeKeyError` (identity corruption — `selectTargets` never absorbs it).
 * A scoped step selecting zero elements contributes nothing to either list.
 */
export const computeAffordances = <S extends StandardSchemaV1, TActor>(
  definition: CaseTypeDefinition<S, TActor>,
  snapshot: CaseSnapshot<StandardSchemaV1.InferOutput<S>>,
  ctx: ComputationContext<TActor>,
): CaseAffordances => {
  const asOf = toIso(ctx.asOf)
  const affordances: Affordance[] = []
  const blocked: BlockedStep[] = []

  for (const stepDefinition of definition.steps) {
    const { targets, failure } = selectTargets(stepDefinition, snapshot.state)
    if (failure !== null) {
      blocked.push(scopeFailureEntry(stepDefinition.name, asOf, failure.reason))
      continue
    }
    for (const target of targets) {
      const evaluation = evaluateTarget(target, { actor: ctx.actor, asOf })
      const scopeKey = target.binding?.key
      if (evaluation.available)
        affordances.push(toAffordance(stepDefinition.name, scopeKey))
      else blocked.push(toBlocked(stepDefinition.name, evaluation, scopeKey))
    }
  }

  return {
    caseId: snapshot.id,
    caseTypeName: definition.name,
    asOf,
    endedAt: toIsoOrNull(snapshot.endedAt),
    affordances,
    blocked,
  }
}

/** An `explain` request as a caller states it: everything optional. */
export interface ExplainRequest {
  /** Required when the step is scoped; identifies the element. */
  readonly scopeKey?: string
  /** The actor to evaluate `permits` against; omit to probe `requires` alone. */
  readonly actor?: unknown
  /** The instant to evaluate as of; defaults through the supplied clock. */
  readonly asOf?: Instant
}

/**
 * Normalize an {@link ExplainRequest} into the {@link ComputationContext}
 * the pure computation runs on — the engine boundary's one normalization,
 * stated here so the rule and {@link computeExplanation} share a test
 * surface:
 *
 * - An **absent** `actor` key means the requires-only probe ({@link NO_ACTOR}
 *   — `permits` conditions are reported un-evaluated). A key that is
 *   *present but `undefined`* is an actor like any other: the caller said
 *   who is asking, and the answer is about them.
 * - `asOf` defaults through `now` — the clock stops here; everything below
 *   is pure.
 * - `scopeKey` is carried only when given, so "unscoped" stays an absent
 *   key rather than an `undefined` value.
 */
export const explainContext = <TActor = unknown>(
  request: ExplainRequest,
  now: () => Instant,
): ComputationContext<TActor> & { readonly scopeKey?: string } => ({
  // The request's actor is caller-supplied and untyped, and NO_ACTOR is the
  // evaluator's own marker; the assertion papers over neither — `permits`
  // conditions must be total over whatever an actor turns out to be.
  actor: ('actor' in request ? request.actor : NO_ACTOR) as TActor,
  asOf: request.asOf ?? now(),
  ...(request.scopeKey !== undefined && { scopeKey: request.scopeKey }),
})

/**
 * The full per-condition breakdown for one step. Loud where the listing is
 * lenient — `explain` is a targeted probe, so a step name the case type
 * doesn't declare, a missing/unknown scope key on a scoped step, or a scope
 * key on an unscoped step all throw with precise messages (including the
 * currently-valid scope keys, where knowable).
 *
 * One deliberate exception: a scoped step whose selector is **defective**
 * answers rather than throws. The listing publishes exactly that condition
 * as a blocked `$scope` entry with an `explain` link, so the link must be
 * followable — the explanation *is* the `$scope` failure, in the same shape
 * the listing reported it.
 *
 * `actor` is whatever the caller supplies; to ask "why can't *this* actor",
 * pass that actor — `permits` conditions are evaluated against it verbatim.
 */
export const computeExplanation = <S extends StandardSchemaV1, TActor>(
  definition: CaseTypeDefinition<S, TActor>,
  snapshot: CaseSnapshot<StandardSchemaV1.InferOutput<S>>,
  stepName: string,
  ctx: ComputationContext<TActor> & { readonly scopeKey?: string },
): AffordanceExplanation => {
  const asOf = toIso(ctx.asOf)
  const identity = {
    caseId: snapshot.id,
    caseTypeName: definition.name,
    step: stepName,
    asOf,
    endedAt: toIsoOrNull(snapshot.endedAt),
  }

  const address = addressTarget(
    definition,
    snapshot.state,
    stepName,
    ctx.scopeKey,
  )
  if (address.failure !== null) {
    if (address.failure.kind === 'defective-selector') {
      return {
        ...identity,
        evaluation: scopeFailureEvaluation(asOf, address.failure),
      }
    }
    throw address.failure.error
  }
  const target = address.target
  return {
    ...identity,
    ...(target.binding !== null && { scopeKey: target.binding.key }),
    evaluation: evaluateTarget(target, { actor: ctx.actor, asOf }),
  }
}

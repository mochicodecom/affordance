/**
 * Step targeting: resolving "step X, of element K, on this state".
 *
 * A **step target** is a step definition plus its scope binding — the pair
 * that an affordance's identity (step × scope key) names. Everything
 * that acts on a step goes through here first: the execution lifecycle's
 * claim, `explain`, audit replay, and the affordance listing itself.
 *
 * It lives in the model because it is a fact about a {@link StepDefinition}
 * and a Case State, and nothing more — no store, no registry, no clock. Put
 * anywhere higher it would drag every consumer's imports upward toward the
 * engine, which is a facade none of them should need.
 *
 * ## One fan-out, filtered
 *
 * {@link selectTargets} is the only implementation of fan-out — expanding
 * one scoped step into its per-element targets — and it makes the one
 * distinction every consumer needs:
 *
 * - A **defective selector** — one that throws over historical state, or
 *   returns something other than an array — is a *selection failure*,
 *   reported as `failure` with no targets. Each caller decides what its
 *   audience deserves: the affordance listing renders it as a blocked
 *   `$scope` entry, a sweep skips the step, {@link resolveTarget} throws.
 * - A **key integrity violation** — duplicate or malformed scope keys —
 *   corrupts affordance identity itself, so {@link ScopeKeyError} is loud
 *   through every path. No caller may absorb it into an empty selection.
 *
 * Addressing — "step X (of element K) on this state" — is likewise one
 * implementation, {@link addressTarget}, answering with the target or a
 * {@link TargetAddressFailure} that names its kind. Its filters:
 * {@link resolveTarget} (loud: an addressed caller is owed the precise
 * failure, so it throws), audit replay (lenient: a sweep over the Journal
 * reports the failure as a value and keeps going), and `explain` (loud,
 * with one deliberate exception — a `defective-selector` failure is
 * *answered*, because the listing published that exact link).
 */

import { SCOPE_FAILURE_CONDITION } from '@affordance/contract'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { thrownMessage } from '../errors.js'
import type {
  GuardEvaluation,
  Instant,
  SingleConditionResult,
} from '../guards/index.js'
import { evaluateGuard } from '../guards/index.js'
import type { CaseTypeDefinition } from './casetype.js'
import { ScopeKeyError, UnknownStepError } from './errors.js'
import type { StepDefinition } from './step.js'

/**
 * The synthetic condition name under which a throwing or malformed scope
 * selector is reported. `$`-prefixed so it can never collide with an
 * author's condition names. Declared by `@affordance/contract` — it reaches
 * clients through `blocked[].unmet[].name`, so it is wire vocabulary, and
 * the wire owns it; re-exported here for the engine's own consumers.
 */
export { SCOPE_FAILURE_CONDITION }

/**
 * The synthetic `$scope` entry as a condition result — the one spelling of
 * how a failed scope selection reports into an evaluation-shaped record: a
 * failed condition carrying the selector's reason.
 */
const scopeConditionResult = (failure: {
  readonly reason: string
}): SingleConditionResult => ({
  name: SCOPE_FAILURE_CONDITION,
  section: 'requires',
  kind: 'condition',
  passed: false,
  reason: failure.reason,
})

/**
 * A defective selection as a full evaluation record — the
 * possible/permitted/available verdict stated once. The selection failed, so
 * nothing about the step is possible
 * on this case; `permits` were never reachable (they may read the element),
 * reported vacuously satisfied — the requires-level `$scope` failure is the
 * answer. The listing's blocked entry and `explain`'s answer for the same
 * link both derive from this.
 */
export const scopeFailureEvaluation = (
  asOf: string,
  failure: { readonly reason: string },
): GuardEvaluation => ({
  asOf,
  possible: false,
  permitted: true,
  available: false,
  conditions: [scopeConditionResult(failure)],
})

/** What a guard is evaluated against, beyond state: the actor and the instant. */
export interface ComputationContext<TActor = unknown> {
  readonly actor: TActor
  /**
   * The instant to evaluate as of — always explicit. Conditions cannot read
   * the clock, so defaulting to now is the engine's job, done once at its
   * boundary; everything below it is pure and reconstructable.
   */
  readonly asOf: Instant
}

/** One element of a scoped step's selection, with the key that identifies it. */
export interface ScopeBinding {
  readonly element: unknown
  readonly key: string
}

/**
 * A step addressed by name (× scope key, if scoped): the step definition and
 * its scope binding, resolved against a given Case State.
 */
export interface StepTarget<TState, TActor = unknown> {
  readonly step: StepDefinition<TState, TActor>
  /**
   * The Case State the target was resolved against — the document its guard
   * is evaluated over. Carried on the target so a binding can never be
   * evaluated against a different document than the one that produced it.
   */
  readonly state: TState
  /** The bound element and its key, or `null` for an unscoped step. */
  readonly binding: ScopeBinding | null
}

/** The outcome of scope fan-out: the step's targets, or why selection produced none. */
export interface TargetSelection<TState, TActor = unknown> {
  readonly targets: readonly StepTarget<TState, TActor>[]
  /** The selection failure — a defective selector — or `null` when selection succeeded. */
  readonly failure: { readonly reason: string } | null
}

/**
 * Select a scoped step's elements and derive their keys, enforcing key
 * integrity: every key a non-empty string, unique within the selection —
 * scope keys are affordance identity, so violations throw
 * {@link ScopeKeyError} instead of degrading. A `select` that throws
 * (totality bug) is left to the caller to absorb or report.
 */
const selectScope = <TState, TActor>(
  definition: StepDefinition<TState, TActor>,
  scope: NonNullable<StepDefinition<TState, TActor>['scope']>,
  state: TState,
): readonly ScopeBinding[] => {
  const selected = scope.select(state)
  if (!Array.isArray(selected)) {
    throw new ScopeKeyError(
      definition.name,
      null,
      'scope.select must return an array of elements',
    )
  }
  const seen = new Set<string>()
  return selected.map((element) => {
    let key: unknown
    try {
      key = scope.key(element)
    } catch (err) {
      throw new ScopeKeyError(
        definition.name,
        null,
        `scope.key threw: ${thrownMessage(err)}`,
      )
    }
    if (typeof key !== 'string' || key === '') {
      throw new ScopeKeyError(
        definition.name,
        null,
        'scope.key must return a non-empty string for every element',
      )
    }
    if (seen.has(key)) {
      throw new ScopeKeyError(
        definition.name,
        key,
        `duplicate scope key '${key}' — scope keys are affordance identity and must be unique`,
      )
    }
    seen.add(key)
    return { element, key }
  })
}

/**
 * The one implementation of scope fan-out — every consumer (the affordance
 * listing, read tracing, addressing)
 * is a filter over this function.
 *
 * An unscoped step yields exactly one target; a scoped step yields one per
 * selected element, or none with a `failure` naming why when the selector is
 * defective. {@link ScopeKeyError} — identity corruption — propagates: it is
 * never a selection failure, and no caller may absorb it into "no targets".
 */
export const selectTargets = <TState, TActor>(
  step: StepDefinition<TState, TActor>,
  state: TState,
): TargetSelection<TState, TActor> => {
  if (step.scope === null)
    return { targets: [{ step, state, binding: null }], failure: null }
  try {
    return {
      targets: selectScope(step, step.scope, state).map((binding) => ({
        step,
        state,
        binding,
      })),
      failure: null,
    }
  } catch (err) {
    if (err instanceof ScopeKeyError) throw err
    return {
      targets: [],
      failure: { reason: `scope selector threw: ${thrownMessage(err)}` },
    }
  }
}

/**
 * Why an address does not resolve, by kind. Each failure carries the error
 * the loud filter would throw, so the diagnosis (including the
 * currently-valid scope keys, where knowable) is constructed exactly once
 * and reads identically whether it is thrown at an addressed caller or
 * reported by a sweep. The kind is what lets a filter treat one failure
 * differently without re-deriving how the address failed — `explain`
 * *answers* a defective selector (the listing published that exact link)
 * and throws everything else.
 */
export type TargetAddressFailure =
  | {
      /** The named step is not declared on the case type. */
      readonly kind: 'unknown-step'
      readonly error: UnknownStepError
    }
  | {
      /** The selector threw or returned a non-array over this Case State. */
      readonly kind: 'defective-selector'
      /** The selection failure's own words — what the listing's `$scope` entry reports. */
      readonly reason: string
      readonly error: ScopeKeyError
    }
  | {
      /**
       * A scope-key problem on an otherwise healthy step: a key given for an
       * unscoped step, a missing key on a scoped one, or a key no selected
       * element carries.
       */
      readonly kind: 'unscoped-key' | 'missing-key' | 'unknown-key'
      readonly error: ScopeKeyError
    }

/** The outcome of addressing a step: the target, or the precise failure. */
export type TargetAddress<TState, TActor = unknown> =
  | { readonly target: StepTarget<TState, TActor>; readonly failure: null }
  | { readonly target: null; readonly failure: TargetAddressFailure }

/**
 * The one implementation of addressing — "step X (of element K) on this
 * state". Total over everything except key integrity: an undeclared step
 * name, a missing/unknown scope key on a scoped step, a scope key on an
 * unscoped step, and a defective scope selector all come back as `failure`.
 * {@link ScopeKeyError} raised for duplicate or malformed keys (identity
 * corruption, from {@link selectScope}) still propagates — no filter may
 * absorb it.
 */
export const addressTarget = <S extends StandardSchemaV1, TActor>(
  definition: CaseTypeDefinition<S, TActor>,
  state: StandardSchemaV1.InferOutput<S>,
  stepName: string,
  scopeKey?: string,
): TargetAddress<StandardSchemaV1.InferOutput<S>, TActor> => {
  const stepDefinition = definition.getStep(stepName)
  if (stepDefinition === undefined) {
    return {
      target: null,
      failure: {
        kind: 'unknown-step',
        error: new UnknownStepError(
          definition.name,
          stepName,
          definition.steps.map((declared) => declared.name),
        ),
      },
    }
  }

  if (stepDefinition.scope === null) {
    if (scopeKey !== undefined) {
      return {
        target: null,
        failure: {
          kind: 'unscoped-key',
          error: new ScopeKeyError(
            stepName,
            scopeKey,
            `scope key '${scopeKey}' given, but the step is not scoped`,
          ),
        },
      }
    }
    return {
      target: { step: stepDefinition, state, binding: null },
      failure: null,
    }
  }

  const selection = selectTargets(stepDefinition, state)
  if (selection.failure !== null) {
    return {
      target: null,
      failure: {
        kind: 'defective-selector',
        reason: selection.failure.reason,
        error: new ScopeKeyError(
          stepName,
          scopeKey ?? null,
          selection.failure.reason,
        ),
      },
    }
  }
  const known = selection.targets.map((target) => target.binding?.key ?? '')
  const selected =
    known.length > 0 ? known.join(', ') : '(no elements in scope)'
  if (scopeKey === undefined) {
    return {
      target: null,
      failure: {
        kind: 'missing-key',
        error: new ScopeKeyError(
          stepName,
          null,
          `scoped step: a scopeKey is required — currently selected: ${selected}`,
        ),
      },
    }
  }
  const bound = selection.targets.find(
    (target) => target.binding?.key === scopeKey,
  )
  if (bound === undefined) {
    return {
      target: null,
      failure: {
        kind: 'unknown-key',
        error: new ScopeKeyError(
          stepName,
          scopeKey,
          `no element in scope has key '${scopeKey}' — currently selected: ${selected}`,
        ),
      },
    }
  }
  return { target: bound, failure: null }
}

/**
 * Resolve "step X (of element K) on this state" — the addressing shared by
 * `explain` (a targeted probe) and the execution lifecycle's claim.
 *
 * The loud filter over {@link addressTarget}: an addressed caller named a
 * case and a step and is owed an answer about *those*, so every way of
 * failing to address throws with its precise message. Addressing a step you
 * cannot name is a caller bug, not a blocked affordance.
 */
export const resolveTarget = <S extends StandardSchemaV1, TActor>(
  definition: CaseTypeDefinition<S, TActor>,
  state: StandardSchemaV1.InferOutput<S>,
  stepName: string,
  scopeKey?: string,
): StepTarget<StandardSchemaV1.InferOutput<S>, TActor> => {
  const address = addressTarget(definition, state, stepName, scopeKey)
  if (address.failure !== null) throw address.failure.error
  return address.target
}

/**
 * Evaluate one addressed step's guard against the state it was resolved on —
 * the single evaluation shared by `explain` and the claim, so the enforcement
 * moment and the explanation of it can never drift apart.
 */
export const evaluateTarget = <TState, TActor>(
  target: StepTarget<TState, TActor>,
  ctx: ComputationContext<TActor>,
): GuardEvaluation =>
  evaluateGuard(target.step.guard, {
    state: target.state,
    actor: ctx.actor,
    asOf: ctx.asOf,
    ...(target.binding !== null && { scope: target.binding.element }),
  })

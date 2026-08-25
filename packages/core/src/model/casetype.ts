/**
 * Case type definitions.
 *
 * A **case type** declares exactly two things: a typed state schema and a set
 * of steps. Nothing else — no flow, stages, graph, or completion test; a
 * case's only "position" is its state.
 *
 * There is deliberately no completion predicate. Whether a
 * matter is finished is a fact about the matter, and outcomes are state: a
 * closed purchase has `closedAt`. The framework's own answer to "is there
 * anything to do here" is the affordance listing being empty for the actor
 * asking — no declaration required, and correct again the moment state moves.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { StepDefinition } from './step.js'
import { isStandardSchema, looksLikeStepDefinition } from './step.js'

/** Options for {@link caseType}. */
export interface CaseTypeOptions<S extends StandardSchemaV1, TActor = unknown> {
  /**
   * The case type's name — what `cases.case_type` records. Only the name is
   * stored: the code definition floats, meaning existing cases always run
   * against the latest deployed definition.
   */
  readonly name: string
  /** The Case State schema (any Standard Schema — zod v4 qualifies). */
  readonly state: S
  /** The case type's steps, in declaration order (which affordance listings preserve). */
  readonly steps: readonly StepDefinition<
    StandardSchemaV1.InferOutput<S>,
    TActor
  >[]
}

/** A validated case type definition — the unit the engine registers. */
export interface CaseTypeDefinition<
  S extends StandardSchemaV1 = StandardSchemaV1,
  TActor = unknown,
> {
  readonly name: string
  readonly state: S
  readonly steps: readonly StepDefinition<
    StandardSchemaV1.InferOutput<S>,
    TActor
  >[]
  /** Look up a step by name; `undefined` when the case type declares no such step. */
  readonly getStep: (
    name: string,
  ) => StepDefinition<StandardSchemaV1.InferOutput<S>, TActor> | undefined
}

/**
 * A case type with its schema and actor generics erased — what heterogeneous
 * registries (the engine's `caseTypes`) hold. `any` is deliberate: it is the
 * only way a `CaseTypeDefinition<PurchaseSchema, Ops>` and a
 * `CaseTypeDefinition<LoanSchema, Servicer>` fit one list; every use is
 * re-anchored by the state schema validation the engine performs on load.
 */
// deliberate `any`: the existential form of CaseTypeDefinition — "some case
// type", its schema deliberately unstated (see doc above). The schema slot
// must be bare `any` — CaseTypeDefinition is invariant in S, meaning no wider
// or narrower schema type is assignable (S feeds both the state property and
// condition/handler parameters), so any narrower existential would reject
// every concrete schema.
export type AnyCaseType = CaseTypeDefinition<any, any>

/**
 * Define a case type. Validates loudly at construction time:
 *
 * - `name` must be a non-empty string and `state` a Standard Schema
 * - every element of `steps` must be a `step(...)` definition
 * - step names must be unique within the case type — a duplicate would make
 *   affordance identity (step × scope key) ambiguous
 */
export const caseType = <S extends StandardSchemaV1, TActor = unknown>(
  options: CaseTypeOptions<S, TActor>,
): CaseTypeDefinition<S, TActor> => {
  const { name, state, steps } = options
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('caseType: name must be a non-empty string')
  }
  if (!isStandardSchema(state)) {
    throw new TypeError(
      `caseType '${name}': state must be a Standard Schema (e.g. a zod schema)`,
    )
  }
  if (!Array.isArray(steps)) {
    throw new TypeError(
      `caseType '${name}': steps must be an array of step(...) definitions`,
    )
  }

  const byName = new Map<
    string,
    StepDefinition<StandardSchemaV1.InferOutput<S>, TActor>
  >()
  for (const definition of steps) {
    if (!looksLikeStepDefinition(definition)) {
      throw new TypeError(
        `caseType '${name}': every step must be built with step(...)`,
      )
    }
    if (byName.has(definition.name)) {
      throw new TypeError(
        `caseType '${name}': duplicate step name '${definition.name}'`,
      )
    }
    byName.set(definition.name, definition)
  }

  return {
    name,
    state,
    steps: [...steps],
    getStep: (stepName) => byName.get(stepName),
  }
}

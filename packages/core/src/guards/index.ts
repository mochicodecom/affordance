/**
 * The guard model and evaluation engine.
 *
 * A **guard** is a step's full set of named **conditions** — pure,
 * synchronous predicates over (case state, actor) — split into
 * `requires` (case conditions) and `permits` (actor conditions).
 * `evaluateGuard` turns a guard and (state, actor, asOf) into a full,
 * serializable per-condition evaluation record: the raw material for
 * affordances, `explain`, and the journal.
 *
 * See `docs/architecture.md` for why guards are shaped this way, and
 * CONTEXT.md for the vocabulary.
 */

export type {
  Condition,
  ConditionContext,
  ConditionOutcome,
  ConditionVerdict,
} from './condition.js'
export type {
  AddressedUnmet,
  AnyOfArmResult,
  AnyOfConditionResult,
  ConditionResult,
  ConditionResultBase,
  GuardEvaluation,
  GuardEvaluationContext,
  SingleConditionResult,
} from './evaluate.js'
export {
  describeUnmet,
  evaluateGuard,
  NO_ACTOR,
  NOT_EVALUATED_REASON,
  unmetAddresses,
  unmetConditions,
} from './evaluate.js'
export type {
  AnyOfArm,
  AnyOfGroup,
  ConditionMap,
  ConditionMapEntry,
  Guard,
  GuardArm,
  GuardEntry,
  GuardEntryKind,
  GuardSection,
} from './guard.js'
export { anyOf, conditionAddress, guardEntries } from './guard.js'
export type { Instant } from './time.js'
export { toEpochMs, toIso } from './time.js'

/**
 * The definition API: case types and steps.
 *
 * A **case type** declares a typed state schema and a set of guarded
 * **steps** — nothing else. A **step** is a
 * guard plus a handler; a step may declare a **scope** over a state
 * collection, yielding one affordance per selected element with identity
 * (step × scope key). Handlers are declared here and executed by the
 * execution lifecycle; this module never invokes one.
 *
 * See CONTEXT.md for the vocabulary and the guards module for the condition
 * algebra these definitions are built from.
 */

export type {
  AnyCaseType,
  CaseTypeDefinition,
  CaseTypeOptions,
} from './casetype.js'
export { caseType } from './casetype.js'
export { ScopeKeyError, UnknownStepError } from './errors.js'
export type {
  CommitWrite,
  CorrelationRequest,
  ErasedStepHandler,
  HandlerContext,
  ScopedHandlerContext,
  ScopedStepHandler,
  StepHandler,
} from './handler.js'
export type { RetryOptions, RetryPolicy } from './retry.js'
export { DEFAULT_RETRY, normalizeRetry } from './retry.js'
export type {
  ScopeDeclaration,
  ScopedCondition,
  ScopedConditionContext,
  ScopedConditionMap,
  ScopedConditionMapEntry,
} from './scope.js'
export type {
  ActorMarker,
  BoundStep,
  ScopedStepOptions,
  StepDefinition,
  StepMetadata,
  StepOptions,
} from './step.js'
export {
  actor,
  StepInputValidationError,
  step,
  stepsOf,
  validateStepInput,
} from './step.js'
export type {
  ComputationContext,
  ScopeBinding,
  StepTarget,
  TargetAddress,
  TargetAddressFailure,
  TargetSelection,
} from './target.js'
export {
  addressTarget,
  evaluateTarget,
  resolveTarget,
  SCOPE_FAILURE_CONDITION,
  scopeFailureEvaluation,
  selectTargets,
} from './target.js'

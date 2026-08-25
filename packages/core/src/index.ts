// Copyright © 2026 Mochicode LLC — mochicode.com

/**
 * @affordance/core — the case framework's engine.
 *
 * A **case** is state plus independently-defined guarded **steps**; the
 * engine computes the currently-available steps (**affordances**) from
 * guards over state. No declared flow, no program counter;
 * process changes deploy freely against in-flight cases.
 *
 * This barrel *is* the package's interface, and it is curated: the authoring
 * API an app writes definitions with, the engine it runs them on, the error
 * taxonomy an adapter translates, and the record types that cross the wire.
 * The store loaders, the execution lifecycle's internals
 * and the guard walk live behind the engine — submodules import them from
 * each other's `index.js`, apps should not need to.
 */

export type {
  Affordance,
  AffordanceExplanation,
  BlockedStep,
  CaseAffordances,
  CaseSnapshot,
  Engine,
  EngineOptions,
  ExplainOptions,
} from './engine/index.js'
// ── The engine ─────────────────────────────────────────────────────────────
export { createEngine, UnknownCaseTypeError } from './engine/index.js'
export type { AffordanceErrorCode } from './errors.js'
// ── The error taxonomy: every deliberate refusal, one closed code set ──────
export { AffordanceError, isAffordanceError } from './errors.js'
export type {
  ClaimedEntryInput,
  ClaimedJournalEntry,
  CompletedEntryInput,
  ExecuteOptions,
  ExecutionRecord,
  ExecutionResult,
  ExecutionStatus,
  FailureEntryInput,
  GuardReplay,
  JournalEntry,
  JournalEntryInput,
  JournalEntryType,
  JournalError,
  JournalFilter,
  PatchOp,
  StateDelta,
} from './execution/index.js'
// ── Execution records: what came back, what is journaled ───────────────────
export {
  CaseBusyError,
  ClaimLostError,
  diffState,
  foldExecutions,
  isClaimedEntry,
  jsonEqual,
  replayGuard,
  StepExecutionError,
  StepNotAvailableError,
  stepLabel,
} from './execution/index.js'
export type {
  AnyOfConditionResult,
  Condition,
  ConditionContext,
  ConditionMap,
  ConditionMapEntry,
  ConditionOutcome,
  ConditionResult,
  ConditionVerdict,
  Guard,
  GuardEvaluation,
  GuardEvaluationContext,
  GuardSection,
  Instant,
  SingleConditionResult,
} from './guards/index.js'
// ── The authoring API: conditions and guards ───────────────────────────────
export { anyOf, evaluateGuard, toEpochMs, toIso } from './guards/index.js'
export type {
  Correlation,
  CorrelationRegistration,
  DeadLetter,
  DeadLetterFilter,
  DeadLetterReason,
  ExternalActor,
  ExternalEvent,
  IngestionOptions,
  IngestionResult,
  IngestionStatus,
} from './ingestion/index.js'
// ── Ingestion: events in, correlations, dead letters ───────────────────────
export { externalActor, routedStep } from './ingestion/index.js'
export type {
  MigrationFailure,
  MigrationOptions,
  MigrationProgress,
  MigrationReport,
  MigrationTransform,
} from './migration/index.js'
// ── Migration: the journaled restructure ───────────────────────────────────
export { hasMigrated, migrationStepName } from './migration/index.js'
export type {
  ActorMarker,
  AnyCaseType,
  BoundStep,
  CaseTypeDefinition,
  CaseTypeOptions,
  CommitWrite,
  CorrelationRequest,
  HandlerContext,
  RetryOptions,
  RetryPolicy,
  ScopeDeclaration,
  ScopedConditionContext,
  ScopedHandlerContext,
  ScopedStepHandler,
  ScopedStepOptions,
  StepDefinition,
  StepHandler,
  StepMetadata,
  StepOptions,
} from './model/index.js'
// ── The authoring API: case types and steps ────────────────────────────────
// `step` itself stays behind the barrel: `caseType` requires a state schema,
// so `stepsOf` covers every authoring case — one public way to write a step.
export {
  actor,
  caseType,
  DEFAULT_RETRY,
  SCOPE_FAILURE_CONDITION,
  ScopeKeyError,
  StepInputValidationError,
  stepsOf,
  UnknownStepError,
} from './model/index.js'
export type {
  CaseHandle,
  DatabaseAccess,
  Dormancy,
  PoolLike,
  Queryable,
  Transaction,
} from './store/index.js'
// ── Persistence: what an app touches directly ──────────────────────────────
export {
  bootstrap,
  CASE_TABLES,
  CaseNotFoundError,
  CaseStateValidationError,
  FRAMEWORK_SCHEMA,
  queryableOf,
} from './store/index.js'

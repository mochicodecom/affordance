/**
 * The execution lifecycle and the journal.
 *
 * An **Execution** is one recorded run of a step on a case (CONTEXT.md): a
 * claim that re-evaluates the guard transactionally, a handler run outside
 * any transaction, and a commit that writes the new Case State together with
 * the journal entry describing it. The **journal** is the immutable,
 * append-only record those Executions leave behind.
 *
 * See `execute.ts` for the lifecycle's shape and the reasoning behind it.
 */

export type { PatchOp, StateDelta } from './delta.js'
export { diffState, jsonEqual } from './delta.js'
export {
  CaseBusyError,
  ClaimLostError,
  StepExecutionError,
  StepNotAvailableError,
  stepLabel,
} from './errors.js'
export type {
  ExecuteOptions,
  ExecutionEnvironment,
  ExecutionResult,
  LifecycleDeps,
  SystemCommit,
  SystemRunOptions,
  SystemRunOutcome,
  SystemSettled,
} from './execute.js'
export {
  DEFAULT_CLAIM_TTL_MS,
  DEFAULT_HEARTBEAT_MS,
  executeStep,
  runAsSystem,
  runLifecycle,
  settleSystemRun,
} from './execute.js'
export type {
  ClaimedEntryInput,
  ClaimedJournalEntry,
  CompletedEntryInput,
  ExecutionRecord,
  ExecutionStatus,
  FailureEntryInput,
  JournalEntry,
  JournalEntryColumns,
  JournalEntryInput,
  JournalEntryType,
  JournalError,
  JournalFilter,
} from './journal.js'
export {
  appendEntry,
  foldExecutions,
  isClaimedEntry,
  projectEntry,
  readJournal,
} from './journal.js'
export type { HeldClaim, LifecyclePort, LifecycleTx } from './port.js'
export { pgLifecyclePort } from './port.js'
export type { GuardReplay } from './replay.js'
export { replayGuard } from './replay.js'
export type { Timers } from './timers.js'
export { realTimers } from './timers.js'
export { withTransaction } from './transaction.js'

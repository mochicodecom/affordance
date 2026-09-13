/** Atomic domain execution and immutable journal evidence. */
export type { PatchOp, StateDelta } from './delta.js'
export { diffState, jsonEqual } from './delta.js'
export {
  ExecutionIndeterminateError,
  StepExecutionError,
  StepNotAvailableError,
  stepLabel,
} from './errors.js'
export type {
  ExecuteOptions,
  ExecutionEnvironment,
  ExecutionResult,
  SystemCommit,
  SystemRunOptions,
  SystemRunOutcome,
  SystemSettled,
} from './execute.js'
export {
  executeStep,
  runAsSystem,
  settleSystemRun,
} from './execute.js'
export type {
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
  StartedEntryInput,
  StartedJournalEntry,
} from './journal.js'
export {
  foldExecutions,
  isStartedEntry,
  projectEntry,
} from './journal.js'
export type {
  AtomicCasePort,
  AtomicCaseSession,
  CompletionEvidence,
  CompletionMetadata,
} from './port.js'
export type { GuardReplay } from './replay.js'
export { replayGuard } from './replay.js'

/** Database-independent exclusive, atomic case execution. */
import type { CorrelationRegistration } from '../ingestion/correlation.js'
import type { Dormancy, StoredCase } from '../store/store.js'
import type { CompletedEntryInput, StartedEntryInput } from './journal.js'
export interface CompletionEvidence {
  readonly started: StartedEntryInput
  readonly completed: CompletedEntryInput
  readonly dormancy: Dormancy | null
  readonly correlations: readonly CorrelationRegistration[]
}
export interface CompletionMetadata {
  readonly seq: number
  readonly endedAt: string | null
  readonly startedAt: string
  readonly committedAt: string
}
export interface AtomicCaseSession<R> {
  readonly repos: R
  loadCase(): Promise<StoredCase>
  /** Stages evidence and metadata within this operation; does not commit separately. */
  persistCompletion(evidence: CompletionEvidence): Promise<CompletionMetadata>
}
export interface AtomicCasePort<R> {
  /** Protect all state read by guards against cooperating domain writers.
   * Invoke callback once. Resolve only after confirmed commit. Throw
   * ExecutionIndeterminateError when commit cannot be confirmed or ruled out.
   * No network calls or hidden retries inside the callback.
   */
  withCase<T>(
    caseId: string,
    executionId: string,
    run: (session: AtomicCaseSession<R>) => Promise<T>,
  ): Promise<T>
}

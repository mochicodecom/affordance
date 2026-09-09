/** Storage mechanics for claim → run → commit, implemented by each adapter.
 * Claims are exclusive per case. Expiry is judged by storage's authoritative clock.
 * Commit checks ownership, so an expired but unreplaced claim may still commit.
 * State, effects, completed evidence and claim removal share one atomic operation.
 */
import type { CommitEffect } from '../model/handler.js'
import type { Dormancy, StoredCase } from '../store/store.js'
import type { JournalEntry, JournalEntryInput } from './journal.js'

/** The claim sitting on a case, as the lifecycle needs to judge it. */
export interface HeldClaim {
  readonly executionId: string
  readonly step: string
  readonly scopeKey: string | null
  readonly attempt: number
  readonly expiresAt: string
  /** True when the lease has lapsed — the next claimant may take the case over. */
  readonly expired: boolean
}

/** What the lifecycle asks of storage inside one case-locked transaction. */
export interface LifecycleTx<TCommit = unknown> {
  /** Read unvalidated state inside the case's atomic operation. */
  readonly loadCase: () => Promise<StoredCase>
  /** The claim on the case, `null` when nobody holds it. */
  readonly currentClaim: () => Promise<HeldClaim | null>
  readonly insertClaim: (
    executionId: string,
    step: string,
    scopeKey: string | null,
    ttlMs: number,
  ) => Promise<{ readonly claimedAt: string }>
  readonly deleteClaim: (executionId: string) => Promise<void>
  readonly appendEntry: (input: JournalEntryInput) => Promise<JournalEntry>
  /** Write the next Case State, bump `seq`, apply the dormancy transition. */
  readonly updateCaseState: (
    state: unknown,
    dormancy: Dormancy | null,
  ) => Promise<{ readonly seq: number; readonly endedAt: string | null }>
  /** The app's own `ctx.onCommit` writes, riding the same transaction. */
  readonly applyEffects: (
    writes: readonly CommitEffect<TCommit>[],
  ) => Promise<void>
}

/** The verbs the execution lifecycle needs from storage. */
export interface LifecyclePort<TCommit = unknown> {
  /** Serialize this case and commit all writes on return; roll everything back on throw.
   * The callback runs once. Serialization conflicts must throw, not replay callbacks.
   * No operation spans a handler. Missing cases throw CaseNotFoundError. */
  readonly withCase: <T>(
    caseId: string,
    fn: (tx: LifecycleTx<TCommit>) => Promise<T>,
  ) => Promise<T>
  /** Journal outside any transaction — `attempt-failed` / `failed` entries. */
  readonly appendEntry: (input: JournalEntryInput) => Promise<JournalEntry>
  /** Refresh the lease. Best-effort: a failed beat just lets the claim age. */
  readonly heartbeat: (
    caseId: string,
    executionId: string,
    ttlMs: number,
  ) => Promise<void>
  /** Keep the lease's attempt counter current across retries. Best-effort. */
  readonly bumpAttempt: (
    caseId: string,
    executionId: string,
    attempt: number,
  ) => Promise<void>
  /** Delete this Execution's claim — scoped to `executionId`, so releasing a lease we no longer hold is a no-op. */
  readonly releaseClaim: (caseId: string, executionId: string) => Promise<void>
}

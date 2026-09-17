import type { JournalDisposition } from './run.js'

export type LaunchStatus = 'running' | 'completed' | 'unresolved' | 'resolved'
export type UnresolvedReason =
  | 'startup'
  | 'expired'
  | 'handler-error'
  | 'finalization'
export interface LaunchedExecution {
  readonly executionId: string
  readonly caseId: string
  readonly step: string
  readonly scopeKey: string | null
  /** Safe attribution only; never a copy of the authentication object. */
  readonly actor: string | null
  readonly status: LaunchStatus
  readonly claimedAt: string
  readonly startedAt: string | null
  readonly expiresAt: string
  readonly completedAt: string | null
  readonly journal: JournalDisposition | null
  readonly reason: UnresolvedReason | null
  readonly resolution: {
    readonly actor: string | null
    readonly reason: string
    readonly resolvedAt: string
  } | null
}
export interface LaunchClaim {
  readonly executionId: string
  readonly caseId: string
  readonly step: string
  readonly scopeKey: string | null
  readonly actor: string | null
  readonly leaseMs: number
}

/** All transitions use the adapter clock and atomically compare ownership identity.
 * Expiration never clears ownership. No method invokes domain code. */
export interface LaunchPort {
  claim(claim: LaunchClaim): Promise<void>
  /** False if ownership has expired or been resolved. */
  start(executionId: string): Promise<boolean>
  /** Only before start was attempted. Delete a known-safe preparation claim. */
  release(executionId: string): Promise<void>
  complete(executionId: string, journal: JournalDisposition): Promise<boolean>
  /** Must not overwrite completed/resolved records or another owner's record. */
  fail(
    executionId: string,
    reason: 'handler-error' | 'finalization' | 'startup',
  ): Promise<void>
  get(executionId: string): Promise<LaunchedExecution | null>
  /** Only unresolved records; clear exactly this record's ownership atomically. */
  resolve(
    executionId: string,
    actor: string | null,
    reason: string,
  ): Promise<LaunchedExecution>
}
export class LaunchBlockedError extends Error {
  constructor(readonly caseId: string) {
    super(`case '${caseId}' has an unresolved launched execution`)
    this.name = 'LaunchBlockedError'
  }
}
export class LaunchUnresolvedError extends Error {
  constructor(
    readonly executionId: string,
    options?: ErrorOptions,
  ) {
    super(
      `execution '${executionId}' requires inspection and reconciliation`,
      options,
    )
    this.name = 'LaunchUnresolvedError'
  }
}

export class ExecutionNotResolvableError extends Error {
  constructor(readonly executionId: string) {
    super(`execution '${executionId}' is not found or not unresolved`)
    this.name = 'ExecutionNotResolvableError'
  }
}

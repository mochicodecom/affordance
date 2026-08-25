/**
 * The ways an Execution can be refused or fail.
 *
 * Each is a distinct answer to "why didn't this run", and callers are
 * expected to branch on them: {@link StepNotAvailableError} is a client-facing
 * *no* with reasons attached; {@link CaseBusyError} is "not now, try again";
 * {@link ClaimLostError} and {@link StepExecutionError} are failures of a run
 * that did start.
 */

import { AffordanceError, thrownMessage } from '../errors.js'
import type { ConditionResult, GuardEvaluation } from '../guards/index.js'
import { describeUnmet, unmetConditions } from '../guards/index.js'

/**
 * How a step (× scope element) is named in prose: `'close-purchase'`, or
 * `'request-re-sign' (buyer_7)` when scoped. One spelling, because refusal
 * messages and adapter renderings must name the same affordance identically.
 */
export const stepLabel = (stepName: string, scopeKey: string | null): string =>
  scopeKey === null ? `'${stepName}'` : `'${stepName}' (${scopeKey})`

/**
 * The claim's transactional guard re-evaluation said no — the enforcement
 * moment. Guards advise; handlers enforce: an affordance computed
 * for a render is advice, and by the time the execute request arrives, state
 * may have moved (another Execution committed) or the definitions may have
 * (a deploy tightened the guard — definition drift is handled by the
 * same mechanism as state races).
 *
 * The unmet conditions carried here are the *current* ones, evaluated inside
 * the claim transaction, so a rejection is self-explaining: hand `unmet`
 * straight back to the caller.
 */
export class StepNotAvailableError extends AffordanceError {
  readonly caseId: string
  readonly stepName: string
  readonly scopeKey: string | null
  /** False when a `requires` condition is unmet: not possible on this case, for anyone. */
  readonly possible: boolean
  /** False when a `permits` condition is unmet: possible, but not for this actor. */
  readonly permitted: boolean
  /** The failed condition results, verbatim from the claim-time evaluation. */
  readonly unmet: readonly ConditionResult[]
  /** The full evaluation record, for journaling or `explain`-style rendering. */
  readonly evaluation: GuardEvaluation

  constructor(
    caseId: string,
    stepName: string,
    scopeKey: string | null,
    evaluation: GuardEvaluation,
  ) {
    const unmet = unmetConditions(evaluation)
    const target = stepLabel(stepName, scopeKey)
    super(
      'step-not-available',
      `step ${target} is not available on case ${caseId}: ${
        describeUnmet(evaluation) || '(no unmet conditions reported)'
      }`,
    )
    this.name = 'StepNotAvailableError'
    this.caseId = caseId
    this.stepName = stepName
    this.scopeKey = scopeKey
    this.possible = evaluation.possible
    this.permitted = evaluation.permitted
    this.unmet = unmet
    this.evaluation = evaluation
  }
}

/**
 * Another Execution is already in flight on this case and its claim has not
 * expired. Executions are serialized per case in v1 — cases advance at human
 * pace, so one Execution at a time costs no real throughput — which makes
 * this "not now", not "never": retry after
 * {@link CaseBusyError.expiresAt} at the latest.
 */
export class CaseBusyError extends AffordanceError {
  readonly caseId: string
  /** The in-flight Execution holding the case. */
  readonly executionId: string
  readonly stepName: string
  readonly scopeKey: string | null
  /** When the in-flight claim lapses if its handler stops heartbeating (ISO-8601 UTC). */
  readonly expiresAt: string

  constructor(
    caseId: string,
    holder: {
      executionId: string
      stepName: string
      scopeKey: string | null
      expiresAt: string
    },
  ) {
    super(
      'case-busy',
      `case ${caseId} is busy: execution ${holder.executionId} is running step ${stepLabel(
        holder.stepName,
        holder.scopeKey,
      )}, claim expires ${holder.expiresAt}`,
    )
    this.name = 'CaseBusyError'
    this.caseId = caseId
    this.executionId = holder.executionId
    this.stepName = holder.stepName
    this.scopeKey = holder.scopeKey
    this.expiresAt = holder.expiresAt
  }
}

/**
 * The claim was gone (or belonged to someone else) when this Execution tried
 * to commit: its lease expired mid-handler and another claimant took the case
 * over. The handler's effects on the outside world already happened — they are
 * at-least-once by contract and deduplicated on `executionId` — but
 * its Case State write is refused, because the state it computed from is stale.
 */
export class ClaimLostError extends AffordanceError {
  readonly caseId: string
  readonly executionId: string
  /** The Execution now holding the case, if any. */
  readonly heldBy: string | null

  constructor(caseId: string, executionId: string, heldBy: string | null) {
    super(
      // The case moved on under this Execution: somebody else holds it now,
      // and the state this Execution computed from is stale. That is the
      // same "not now" answer a busy case gives, so it reuses 'case-busy' —
      // a code an adapter already knows how to render.
      'case-busy',
      `execution ${executionId} lost its claim on case ${caseId}${
        heldBy === null
          ? ' (claim expired and was released)'
          : ` (now held by ${heldBy})`
      } — its state write was refused`,
    )
    this.name = 'ClaimLostError'
    this.caseId = caseId
    this.executionId = executionId
    this.heldBy = heldBy
  }
}

/**
 * The Execution ran and failed: the handler threw on every allowed attempt,
 * or it returned a Case State the case type's schema rejects (a deterministic
 * defect, failed without retry). A `failed` journal entry records it and the
 * case is released.
 */
export class StepExecutionError extends AffordanceError {
  readonly caseId: string
  readonly executionId: string
  readonly stepName: string
  readonly scopeKey: string | null
  /** How many attempts ran before the Execution was given up on. */
  readonly attempts: number

  constructor(
    caseId: string,
    executionId: string,
    stepName: string,
    scopeKey: string | null,
    attempts: number,
    cause: unknown,
  ) {
    const reason = thrownMessage(cause)
    super(
      'execution-failed',
      `step ${stepLabel(stepName, scopeKey)} failed on case ${caseId} after ${attempts} attempt${
        attempts === 1 ? '' : 's'
      }: ${reason}`,
      { cause },
    )
    this.name = 'StepExecutionError'
    this.caseId = caseId
    this.executionId = executionId
    this.stepName = stepName
    this.scopeKey = scopeKey
    this.attempts = attempts
  }
}

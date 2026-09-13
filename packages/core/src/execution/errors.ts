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
 * The execution's transactional guard re-evaluation said no — the enforcement
 * moment. Guards advise; handlers enforce: an affordance computed
 * for a render is advice, and by the time the execute request arrives, state
 * may have moved (another Execution committed) or the definitions may have
 * (a deploy tightened the guard — definition drift is handled by the
 * same mechanism as state races).
 *
 * The unmet conditions carried here are the *current* ones, evaluated inside
 * the execution transaction, so a rejection is self-explaining: hand `unmet`
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
  /** The failed condition results, verbatim from the enforcement-time evaluation. */
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

/** A domain handler or its completion failed; the atomic operation is aborted. */
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

/** The database may have committed; never classify this as a definite failure. */
export class ExecutionIndeterminateError extends Error {
  constructor(
    readonly caseId: string,
    readonly executionId: string,
    options?: ErrorOptions,
  ) {
    super(
      `execution ${executionId} on case ${caseId} has an unknown commit outcome; reconcile before retrying`,
      options,
    )
    this.name = 'ExecutionIndeterminateError'
  }
}

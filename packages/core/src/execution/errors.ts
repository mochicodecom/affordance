import { AffordanceError } from '../errors.js'
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
 * The execution's current Guard evaluation said no — the enforcement
 * moment. Guards advise; handlers enforce: an affordance computed
 * for a render is advice, and by the time the execute request arrives, state
 * may have moved (another Execution committed) or the definitions may have
 * (a deploy tightened the guard — definition drift is handled by the
 * same mechanism as state races).
 *
 * The unmet conditions carried here are the *current* ones, evaluated before
 * handler invocation, so a rejection is self-explaining: hand `unmet`
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

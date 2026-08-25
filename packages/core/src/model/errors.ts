/**
 * Addressing failures: naming a step, or an element of one, that the
 * definitions do not offer.
 *
 * These belong to the model rather than to any one consumer, because
 * addressing is a fact about a step definition and a state — the claim,
 * `explain` and audit replay all ask the same question
 * and get the same two answers back.
 */

import { AffordanceError } from '../errors.js'

/** The named step does not exist on the case's case type. */
export class UnknownStepError extends AffordanceError {
  readonly caseTypeName: string
  readonly stepName: string

  constructor(
    caseTypeName: string,
    stepName: string,
    known: readonly string[],
  ) {
    super(
      'bad-request',
      `case type '${caseTypeName}' has no step '${stepName}' — steps: ${
        known.length > 0 ? known.join(', ') : '(none)'
      }`,
    )
    this.name = 'UnknownStepError'
    this.caseTypeName = caseTypeName
    this.stepName = stepName
  }
}

/**
 * A scope-key problem: an element's derived key is invalid or duplicated
 * (identity corruption — scope keys are half of an affordance's identity,
 * so this fails loudly rather than degrading), or a caller addressed a
 * scoped step without a key / with an unknown key / gave a key for an
 * unscoped step.
 */
export class ScopeKeyError extends AffordanceError {
  readonly stepName: string
  readonly scopeKey: string | null

  constructor(stepName: string, scopeKey: string | null, message: string) {
    super('bad-request', `step '${stepName}': ${message}`)
    this.name = 'ScopeKeyError'
    this.stepName = stepName
    this.scopeKey = scopeKey
  }
}

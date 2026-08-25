import type { StandardSchemaV1 } from '@standard-schema/spec'
import { AffordanceError } from '../errors.js'

/**
 * A Case State document failed validation against the provided state schema —
 * either an invalid initial state on `createCase`, or a stored state that no
 * longer satisfies the schema on `loadCase` (loud by design: cases float to
 * the latest definitions, so a load-time mismatch is an app bug,
 * never something to paper over).
 */
export class CaseStateValidationError extends AffordanceError {
  readonly issues: readonly StandardSchemaV1.Issue[]

  constructor(context: string, issues: readonly StandardSchemaV1.Issue[]) {
    super(
      'invalid-state',
      `invalid ${context}: ${issues.map((issue) => issue.message).join('; ')}`,
    )
    this.name = 'CaseStateValidationError'
    this.issues = issues
  }
}

/** No case row exists for the given case id. */
export class CaseNotFoundError extends AffordanceError {
  readonly caseId: string

  constructor(caseId: string) {
    super('not-found', `case not found: ${caseId}`)
    this.name = 'CaseNotFoundError'
    this.caseId = caseId
  }
}

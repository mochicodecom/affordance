import { AffordanceError } from '../errors.js'

/** A loaded case's `case_type` names no case type registered with the engine. */
export class UnknownCaseTypeError extends AffordanceError {
  readonly caseTypeName: string

  constructor(caseTypeName: string, registered: readonly string[]) {
    super(
      'not-found',
      `unknown case type '${caseTypeName}' — registered case types: ${
        registered.length > 0 ? registered.join(', ') : '(none)'
      }`,
    )
    this.name = 'UnknownCaseTypeError'
    this.caseTypeName = caseTypeName
  }
}

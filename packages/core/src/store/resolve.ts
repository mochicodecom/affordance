import type { AnyCaseType } from '../model/index.js'
import type { CaseHandle } from './store.js'
import { validateAgainstSchema } from './store.js'

/** Resolve a persisted `case_type` name to its registered definition; throws if unknown. */
export type CaseTypeLookup = (caseTypeName: string) => AnyCaseType

/** Case metadata, its Case Type definition, and validated domain state. */
export interface ResolvedCase {
  readonly definition: AnyCaseType
  /** Metadata and unvalidated loaded domain state; prefer {@link ResolvedCase.state}. */
  readonly handle: CaseHandle<unknown>
  /** The loaded Case State, validated against the definition's schema (defaults applied). */
  readonly state: unknown
}

/**
 * Validate a Case State document against a Case Type's schema, loudly.
 *
 * `context` identifies the load in validation errors, such as an ordinary
 * case read or the state reloaded after a domain operation.
 */
export const validateCaseState = async (
  definition: AnyCaseType,
  value: unknown,
  context = 'loaded domain state',
): Promise<unknown> => validateAgainstSchema(definition.state, value, context)

export const resolveCase = async (
  handle: CaseHandle<unknown>,
  caseTypeFor: CaseTypeLookup,
): Promise<ResolvedCase> => {
  const definition = caseTypeFor(handle.caseTypeName)
  return {
    definition,
    handle,
    state: await validateCaseState(
      definition,
      handle.state,
      `loaded domain state for case '${handle.id}'`,
    ),
  }
}

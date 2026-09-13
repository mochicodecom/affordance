import type { AnyCaseType } from '../model/index.js'
import type { CaseHandle } from './store.js'
import { validateAgainstSchema } from './store.js'

/** Resolve a persisted `case_type` name to its registered definition; throws if unknown. */
export type CaseTypeLookup<TRepos = unknown> = (
  caseTypeName: string,
) => AnyCaseType<TRepos>

/** A case row, its Case Type definition, and its validated Case State. */
export interface ResolvedCase<TRepos = unknown> {
  readonly definition: AnyCaseType<TRepos>
  /** The row as persisted. Its `state` is the raw document; prefer {@link ResolvedCase.state}. */
  readonly handle: CaseHandle<unknown>
  /** The stored Case State, validated against the definition's schema (defaults applied). */
  readonly state: unknown
}

/**
 * Validate a Case State document against a Case Type's schema, loudly.
 *
 * `context` names what is being validated, and lands in the error message:
 * `'stored state'` for a document read back, `"state returned by step 'x'"`
 * for a handler's return. One function, because "does this document satisfy
 * the case type" is one question however the document was obtained.
 */
export const validateCaseState = async <TRepos>(
  definition: AnyCaseType<TRepos>,
  value: unknown,
  context = 'stored state',
): Promise<unknown> => validateAgainstSchema(definition.state, value, context)

export const resolveCase = async <TRepos>(
  handle: CaseHandle<unknown>,
  caseTypeFor: CaseTypeLookup<TRepos>,
): Promise<ResolvedCase<TRepos>> => {
  const definition = caseTypeFor(handle.caseTypeName)
  return {
    definition,
    handle,
    state: await validateCaseState(
      definition,
      handle.state,
      `stored state for case '${handle.id}'`,
    ),
  }
}

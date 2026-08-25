/**
 * Where the registry and the store meet: turning a case row into a Case Type
 * definition and a Case State that can be trusted.
 *
 * Every read path needs the same three moves, in the same order — load the
 * row, resolve `case_type` against the registered definitions, validate the
 * stored document against that definition's schema — because the schema to
 * validate against is only knowable *from* the row. What to do with a
 * document that fails validation is a real decision, so it is expressed
 * here as the interface rather than left to each caller:
 *
 * - {@link resolveCase} / {@link resolveCaseForUpdate} are **loud**. Their
 *   callers were handed a case id by somebody and owe them an answer about
 *   *that* case; a document that no longer validates is an app bug and says
 *   so ({@link CaseStateValidationError}).
 * - {@link resolveStoredState} is **lenient**. Its callers sweep — a
 *   migration scanning a case type — and one
 *   unreadable case must not take the sweep down.
 *
 * The same lenient/loud pair the model draws around scope selection
 * (`addressTarget`'s value vs `resolveTarget`'s throw), for the same reason.
 */

import type { AnyCaseType } from '../model/index.js'
import { CaseStateValidationError } from './errors.js'
import type { Queryable, Transaction } from './queryable.js'
import type { CaseHandle } from './store.js'
import {
  selectCaseForUpdate,
  selectCaseUntyped,
  validateAgainstSchema,
} from './store.js'

/** Resolve a persisted `case_type` name to its registered definition; throws if unknown. */
export type CaseTypeLookup = (caseTypeName: string) => AnyCaseType

/** A case row, its Case Type definition, and its validated Case State. */
export interface ResolvedCase {
  readonly definition: AnyCaseType
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
export const validateCaseState = async (
  definition: AnyCaseType,
  value: unknown,
  context = 'stored state',
): Promise<unknown> => validateAgainstSchema(definition.state, value, context)

/**
 * Validate a Case State document already in hand, leniently: `null` when it
 * no longer satisfies its Case Type's schema.
 *
 * The lenient twin of {@link validateCaseState} — literally: the same single
 * Standard-Schema invocation (`validateAgainstSchema`), with the loud
 * verdict absorbed. Only the validation verdict is absorbed; a schema whose
 * `validate` itself throws is a definition bug and stays loud.
 *
 * Wrapped in an object rather than returned bare, because a valid Case State
 * may legitimately *be* `null` and a sweep must not confuse the two.
 */
export const resolveStoredState = async (
  definition: AnyCaseType,
  value: unknown,
): Promise<{ readonly state: unknown } | null> => {
  try {
    return { state: await validateCaseState(definition, value) }
  } catch (error) {
    if (error instanceof CaseStateValidationError) return null
    throw error
  }
}

const resolved = async (
  handle: CaseHandle<unknown>,
  caseTypeFor: CaseTypeLookup,
): Promise<ResolvedCase> => {
  const definition = caseTypeFor(handle.caseTypeName)
  return {
    definition,
    handle,
    state: await validateCaseState(definition, handle.state),
  }
}

/** Load a case and resolve it against the registered definitions. Loud — see this module's note. */
export const resolveCase = async (
  db: Queryable,
  caseTypeFor: CaseTypeLookup,
  caseId: string,
): Promise<ResolvedCase> =>
  resolved(await selectCaseUntyped(db, caseId), caseTypeFor)

/**
 * {@link resolveCase} taking the case row's lock — the execution lifecycle's
 * serialization point.
 */
export const resolveCaseForUpdate = async (
  tx: Transaction,
  caseTypeFor: CaseTypeLookup,
  caseId: string,
): Promise<ResolvedCase> =>
  resolved(await selectCaseForUpdate(tx, caseId), caseTypeFor)

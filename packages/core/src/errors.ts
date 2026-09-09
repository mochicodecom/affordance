/**
 * The framework's error taxonomy.
 *
 * Every way the framework refuses or fails carries a **code**: a stable,
 * wire-safe name for the *kind* of refusal, distinct from the message (which
 * is prose, and which an adapter may have to rewrite for the audience it is
 * answering — see the HTTP contract's visibility rule).
 *
 * The code lives here, on the error, rather than in a mapping table at each
 * edge. An adapter that turns framework errors into responses then translates
 * a closed set of codes instead of enumerating error classes it has to be
 * told about: adding an error class cannot silently produce a 500, because
 * the class cannot be constructed without declaring what it is.
 *
 * Anything not an {@link AffordanceError} is not the framework's refusal —
 * it is a bug or an infrastructure failure, and edges should let it through
 * rather than dress it up as an answer.
 */

/** The closed set of deliberate engine refusal codes. */
export const REFUSAL_CODES = [
  /** A guard said no. Carries the unmet conditions. */
  'step-not-available',
  /** Another Execution holds the case — "not now", not "never". */
  'case-busy',
  /** A step's input failed its declared schema. */
  'invalid-input',
  /** No such case, or no such case type. */
  'not-found',
  /** The caller addressed something that cannot be addressed: unknown step, bad scope key. */
  'bad-request',
  /** A handler ran and failed. */
  'execution-failed',
  /** A stored Case State no longer satisfies its schema. */
  'invalid-state',
] as const

export type AffordanceErrorCode = (typeof REFUSAL_CODES)[number]

/**
 * The base of every error the framework raises deliberately. Subclasses
 * declare their {@link AffordanceErrorCode} at construction — there is no
 * default, so the taxonomy cannot be extended by accident.
 */
export class AffordanceError extends Error {
  readonly code: AffordanceErrorCode

  constructor(
    code: AffordanceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AffordanceError'
    this.code = code
  }
}

/** Narrow an unknown throw to a deliberate framework refusal. */
export const isAffordanceError = (error: unknown): error is AffordanceError =>
  error instanceof AffordanceError

/**
 * The human-readable message of whatever was thrown — Error or not. The one
 * spelling of a conversion that guards, targets, and the lifecycle all need,
 * because app code can throw anything.
 */
export const thrownMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Convert an unknown throw into an `Error`, preserving one that already is. */
export const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(thrownMessage(error))

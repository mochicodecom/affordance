/**
 * Per-step retry policy.
 *
 * Handlers are short-lived, at-least-once and idempotent, so a
 * failed attempt is retried in place: same Execution, same `ctx.executionId`
 * (the idempotency key), same claim. Retries are bounded — "exhausted retries
 * journal a *failed* execution and release the case" — so a permanently
 * failing handler can never hold a case hostage.
 *
 * Only *indeterminate* failures are retried: a handler that threw. A
 * deterministic failure (the returned Case State does not satisfy the case
 * type's schema) fails the Execution immediately — retrying is guaranteed to
 * produce the same defect.
 */

/** A normalized retry policy, as held on a {@link StepDefinition}. */
export interface RetryPolicy {
  /** Total attempts, including the first — 1 disables retry. */
  readonly maxAttempts: number
  /** Delay before the attempt *after* the given (1-based) failed attempt, in milliseconds. */
  readonly delayMs: (attempt: number) => number
}

/** Retry configuration as authored on a step; every field optional. */
export interface RetryOptions {
  /** Total attempts, including the first. Integer ≥ 1; defaults to 3. */
  readonly maxAttempts?: number
  /**
   * Delay between attempts: a fixed number of milliseconds, or a function of
   * the (1-based) attempt that just failed. Defaults to exponential backoff
   * (100ms, 200ms, 400ms …) capped at 5s.
   */
  readonly delayMs?: number | ((attempt: number) => number)
}

/** Exponential backoff from 100ms, capped at 5s. */
const defaultDelayMs = (attempt: number): number =>
  Math.min(5_000, 100 * 2 ** (attempt - 1))

/** The policy a step gets when it declares none: three attempts, exponential backoff. */
export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  delayMs: defaultDelayMs,
}

/**
 * Normalize authored retry options into a {@link RetryPolicy}, validating
 * loudly (definition-time validation: a malformed policy should fail the
 * deploy, not an execution).
 */
export const normalizeRetry = (
  stepName: string,
  options: RetryOptions | undefined,
): RetryPolicy => {
  if (options === undefined) return DEFAULT_RETRY
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new TypeError(
      `step '${stepName}': retry must be { maxAttempts?, delayMs? }`,
    )
  }
  const { maxAttempts = DEFAULT_RETRY.maxAttempts, delayMs = defaultDelayMs } =
    options
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError(
      `step '${stepName}': retry.maxAttempts must be an integer >= 1`,
    )
  }
  if (typeof delayMs === 'number') {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new TypeError(
        `step '${stepName}': retry.delayMs must be a non-negative number or a function`,
      )
    }
    const fixed = delayMs
    return { maxAttempts, delayMs: () => fixed }
  }
  if (typeof delayMs !== 'function') {
    throw new TypeError(
      `step '${stepName}': retry.delayMs must be a non-negative number or a function`,
    )
  }
  return { maxAttempts, delayMs }
}

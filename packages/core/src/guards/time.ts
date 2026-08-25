/**
 * Instant normalization.
 *
 * Conditions never read the clock. Evaluation takes an explicit `asOf`
 * instant, so "evaluate this guard as of T" is always well-defined and the
 * evaluation record can state the instant it was made as of. The helpers
 * here normalize the forms callers and case state plausibly hold an instant
 * in.
 */

/**
 * An instant in time, in any of the forms case state and callers plausibly
 * hold one: a `Date`, an ISO-8601 (or otherwise `Date.parse`-able) string,
 * or epoch milliseconds. Normalized internally; evaluation records always
 * report instants as ISO-8601 UTC strings.
 */
export type Instant = Date | string | number

/**
 * Normalize any {@link Instant} form to epoch milliseconds; `null` when the
 * value is absent or not a determinable instant. **Total** by design — never
 * throws, because absence and rubbish in historical Case State are ordinary
 * and mean "not determinable", not "error".
 */
export const toEpochMs = (value: unknown): number | null => {
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isNaN(ms) ? null : ms
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? null : ms
  }
  return null
}

/**
 * Normalize any {@link Instant} to ISO-8601 UTC, **loudly** — every record
 * the framework emits reports instants as strings.
 *
 * The loud counterpart of {@link toEpochMs}: this one reads *caller input*
 * (an `asOf`, a dormancy marker), where a value that is not an instant is a
 * caller bug rather than a pending fact.
 */
export const toIso = (value: Instant): string => {
  const ms = toEpochMs(value)
  if (ms === null) {
    throw new TypeError(
      'asOf/endedAt must be a Date, ISO-8601 string, or epoch milliseconds',
    )
  }
  return new Date(ms).toISOString()
}

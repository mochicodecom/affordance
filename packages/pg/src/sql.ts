/**
 * The one idiom behind every filtered read in the package: a `where` clause
 * assembled from a list of AND-ed conditions and a positional values array.
 * The journal, the dead-letter surface, and the migration candidate query
 * each read a different table, but they all number their placeholders and
 * join their conditions the same way — stated once here, so a new filter
 * cannot number a placeholder wrong.
 */

/** A `where` clause under assembly. */
export interface SqlWhere {
  /** The AND-ed conditions; push to add one. */
  readonly conditions: string[]
  /** The bound values, positionally matching the `$n` placeholders. */
  readonly values: unknown[]
  /** Append a value and return its `$n` placeholder. */
  readonly bind: (value: unknown) => string
  /** The conditions joined with ` and ` — the body of the `where` clause. */
  readonly where: () => string
}

/**
 * Start a `where` clause. Fixed conditions and their values are the seed —
 * a seeded condition may spell its own `$n` as long as it matches the
 * value's position — and optional conditions are pushed with placeholders
 * from `bind`.
 */
export const sqlWhere = (
  conditions: string[] = [],
  values: unknown[] = [],
): SqlWhere => ({
  conditions,
  values,
  bind: (value: unknown): string => `$${values.push(value)}`,
  where: () => conditions.join(' and '),
})

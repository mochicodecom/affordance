/**
 * @affordance/testkit — the pg-test plumbing every package's suites share,
 * stated once: the test database's address, the per-suite pool, and the
 * serializability assertion. The global-setup half lives in
 * `@affordance/testkit/global-setup`, importable outside a test context.
 */

import pg from 'pg'
import { afterAll, expect } from 'vitest'
import { TEST_DATABASE_URL } from './database-url.js'

export { TEST_DATABASE_URL }

/**
 * A pool for one suite, closed after it.
 *
 * Every pg suite used to declare its own connection string, pool and
 * `afterAll(pool.end)` — many copies of the same three lines, each a place
 * a connection change has to visit. The suites' *engines* stay their own
 * (clocks and lease timings genuinely differ per area); how a pool is
 * opened and closed does not.
 */
export const testPool = (options: { readonly max?: number } = {}): pg.Pool => {
  const pool = new pg.Pool({
    connectionString: TEST_DATABASE_URL,
    max: options.max ?? 10,
  })
  afterAll(async () => {
    await pool.end()
  })
  return pool
}

/**
 * Assert that JSON evidence, such as an encoded document or a delta, survives
 * storage unchanged. Decoded runtime values require the core serializer first.
 */
export const expectJsonRoundTrips = (value: unknown): void => {
  expect(JSON.parse(JSON.stringify(value))).toEqual(value)
}

/**
 * The vitest global-setup shared by every package's pg project: create the
 * test database if missing, then run the framework's DDL bootstrap once,
 * before any suite opens a pool.
 *
 * Once, because every `*.pg.test.ts` file used to do this itself, which
 * meant DDL running concurrently with another file's Executions — and
 * `create index if not exists` takes a lock whether or not it has anything
 * to do, so a bootstrap and a running commit could deadlock each other.
 * Bootstrapping before any suite models what an app actually does: DDL at
 * start-up, then traffic.
 *
 * The bootstrap itself is *passed in* by each package's one-line
 * `test/global-setup.ts` shim rather than imported here, so this package
 * depends on nothing but pg — core's own shim hands it core's bootstrap
 * straight from `src/`.
 */

import pg from 'pg'
import { TEST_DATABASE_URL } from './database-url.js'

export { TEST_DATABASE_URL }

/** Tests get their own database — never the demo's. Create it if missing. */
export const ensureTestDatabase = async (): Promise<void> => {
  const url = new URL(TEST_DATABASE_URL)
  const name = url.pathname.slice(1)
  url.pathname = '/postgres'
  const admin = new pg.Client({ connectionString: url.toString() })
  await admin.connect()
  try {
    const { rowCount } = await admin.query(
      'select 1 from pg_database where datname = $1',
      [name],
    )
    if (!rowCount) await admin.query(`create database "${name}"`)
  } finally {
    await admin.end()
  }
}

/** Build a package's globalSetup entry from its DDL bootstrap. */
export const createGlobalSetup =
  (bootstrap: (db: pg.Pool) => Promise<void>) => async (): Promise<void> => {
    await ensureTestDatabase()
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 })
    try {
      await bootstrap(pool)
    } finally {
      await pool.end()
    }
  }

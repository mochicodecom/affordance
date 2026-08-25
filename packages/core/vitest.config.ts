import { defineConfig } from 'vitest/config'

// Two projects, split on the *.pg.test.ts suffix: `core` (pure — no
// database, no globalSetup) and `core-pg` (Postgres suites behind the one
// DDL bootstrap). The lifecycle port exists so the claim state machine's
// tests can stand on a seam instead of a database; a globalSetup that
// provisions Postgres for the whole package would defeat exactly that.
export default defineConfig({
  test: {
    projects: ['./vitest.unit.config.ts', './vitest.pg.config.ts'],
  },
})

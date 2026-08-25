import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'core-pg',
    environment: 'node',
    // The Postgres half: every *.pg.test.ts suite.
    // DDL once, before any suite opens a pool — see test/global-setup.ts.
    include: ['test/**/*.pg.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
  },
})

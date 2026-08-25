import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Core is listed as its two split configs (pure vs. Postgres) because a
    // project cannot nest projects of its own; see packages/core/vitest.config.ts.
    projects: [
      'packages/core/vitest.unit.config.ts',
      'packages/core/vitest.pg.config.ts',
      'packages/http',
      'packages/reference-app',
    ],
  },
})

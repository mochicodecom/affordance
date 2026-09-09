import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'packages/core/vitest.unit.config.ts',
      'packages/pg',
      'packages/reference-app',
    ],
  },
})

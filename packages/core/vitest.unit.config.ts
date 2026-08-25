import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'core',
    environment: 'node',
    // The pure half of the package: guards, model, delta, the lifecycle
    // against the in-memory port. No globalSetup — these suites must run
    // without a database, which is the point of the seams they stand on.
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.pg.test.ts'],
  },
})

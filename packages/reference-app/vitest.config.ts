import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'reference-app',
    environment: 'node',
    // DDL once, before any suite opens a pool — see test/global-setup.ts.
    globalSetup: ['./test/global-setup.ts'],
  },
})

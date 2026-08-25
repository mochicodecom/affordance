import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'http',
    environment: 'node',
    // DDL once, before any suite opens a pool — see test/global-setup.ts.
    globalSetup: ['./test/global-setup.ts'],
  },
})

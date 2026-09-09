import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@affordance\/core$/,
        replacement: fileURLToPath(
          new URL('../core/src/index.ts', import.meta.url),
        ),
      },
      {
        find: /^@affordance\/core\/storage$/,
        replacement: fileURLToPath(
          new URL('../core/src/storage.ts', import.meta.url),
        ),
      },
    ],
  },
  test: {
    name: 'pg',
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
  },
})

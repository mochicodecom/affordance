/**
 * Serve the reference app: the affordance contract under `/api`, the demo
 * console at `/`, the operator surface under `/dev`. Nothing is seeded —
 * a case exists only when someone creates one through the API; the test
 * suites stage their own.
 *
 * Run it with `pnpm --filter @affordance/reference-app serve` (a Postgres
 * must be up: `pnpm db:up`). The console at `/` is the built UI, so this
 * refuses to start without a prior `ui:build` rather than serve something
 * stale or fall back silently.
 */

import { existsSync } from 'node:fs'
import { serve } from '@hono/node-server'
import pg from 'pg'
import { createPurchaseApp } from './app.js'

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/affordance'
const PORT = Number(process.env.PORT ?? 8787)

const main = async (): Promise<void> => {
  if (!existsSync(new URL('../ui/dist/index.html', import.meta.url))) {
    console.error(
      'ui/dist is missing — build the console first:\n' +
        '  pnpm --filter @affordance/reference-app ui:build\n' +
        '(serve never builds it for you.)',
    )
    process.exitCode = 1
    return
  }

  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 })
  const app = await createPurchaseApp({ db: { pool }, basePath: '/api' })
  serve({ fetch: app.http.fetch, port: PORT })
  console.log(`House-purchase reference app on http://localhost:${PORT}/api`)
  console.log(`Demo console: http://localhost:${PORT}/`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

import { bootstrap } from '@affordance/pg'
import { bootstrapPurchases } from '../src/repository.js'
/**
 * This package's globalSetup: the shared testkit sequence (create the test
 * database, then DDL once, before any suite opens a pool).
 */

import { createGlobalSetup } from '@affordance/testkit/global-setup'

export const setup = createGlobalSetup(async (db) => {
  await bootstrap(db)
  await bootstrapPurchases(db)
})

/**
 * This package's globalSetup: the shared testkit sequence (create the test
 * database, then DDL once, before any suite opens a pool), handed core's
 * own bootstrap straight from `src/`.
 */

import { createGlobalSetup } from '@affordance/testkit/global-setup'
import { bootstrap } from '../src/store/index.js'

export const setup = createGlobalSetup(bootstrap)

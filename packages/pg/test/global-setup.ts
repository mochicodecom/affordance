import { createGlobalSetup } from '@affordance/testkit/global-setup'
import { bootstrap } from '../src/index.js'
export const setup = createGlobalSetup(bootstrap)

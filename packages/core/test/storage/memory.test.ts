import { storageContract } from './contract.js'
import { memoryAdapter } from './memory.js'

storageContract('Memory', memoryAdapter)

import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { caseType, createEngine } from '../../src/index.js'

it('validates a fetched page without individual case reloads', async () => {
  const { storage } = memoryAdapter()
  const definition = caseType({
    name: 'listing',
    state: z.object({ count: z.number().default(0) }),
    steps: [],
  })
  await storage.cases.create(definition.name, {})
  const get = vi.fn(storage.cases.get)
  const engine = createEngine({
    storage: { ...storage, cases: { ...storage.cases, get } },
    caseTypes: [definition],
  })
  expect((await engine.listCases()).cases[0]?.state).toEqual({ count: 0 })
  expect(get).not.toHaveBeenCalled()
})

import { actor, caseType, stepsOf } from '@affordance/core'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { createPgStorage, type Queryable } from '../src/index.js'

it('binds authoritative domain reads without transaction repositories', () => {
  const state = z.object({ count: z.number() })
  const step = stepsOf(state, actor<{ id: string }>())
  const definition = caseType({
    name: 'typed',
    state,
    steps: [
      step({
        name: 'change',
        handler: async (c) => ({ ...c.state, count: 1 }),
      }),
    ],
  })
  const q: Queryable = {
    query: async () => {
      throw new Error('not called')
    },
  }
  const storage = createPgStorage({ db: { client: q } })
  const binding = storage.bindCase(definition, {
    load: async () => ({ count: 0 }),
  })
  expect(binding.definition.name).toBe('typed')
})

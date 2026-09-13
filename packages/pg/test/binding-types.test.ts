import { actor, caseType, repositories, stepsOf } from '@affordance/core'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { createPgStorage, type Queryable } from '../src/index.js'

it('pairs the definition repository requirements with the adapter at binding time', () => {
  const state = z.object({ count: z.number() })
  const step = stepsOf(
    state,
    actor<{ id: string }>(),
    repositories<{ setCount(n: number): Promise<void> }>(),
  )
  const definition = caseType({
    name: 'typed',
    state,
    steps: [
      step({
        name: 'update',
        handler: async (ctx) => {
          await ctx.repos.setCount(ctx.state.count + 1)
          // @ts-expect-error the repository parameter is numeric
          await ctx.repos.setCount('wrong')
        },
      }),
    ],
  })
  const q: Queryable = {
    query: async () => {
      throw new Error('not called')
    },
  }
  const storage = createPgStorage({ db: { client: q } })
  const invalidBinding = () => {
    storage.bindCase(definition, {
      load: async () => ({ count: 0 }),
      protect: async () => {},
      // @ts-expect-error a missing domain operation is not a valid binding
      repositories: () => ({ unrelated: () => {} }),
    })
  }
  void invalidBinding
  const binding = storage.bindCase(definition, {
    load: async () => ({ count: 0 }),
    protect: async () => {},
    repositories: () => ({ setCount: async (_n) => {} }),
  })
  expect(binding.definition.name).toBe('typed')
})

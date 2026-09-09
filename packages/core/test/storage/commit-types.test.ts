import { expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import type { AnyCaseType, HandlerContext } from '../../src/index.js'
import {
  actor,
  caseType,
  commitContext,
  createEngine,
  stepsOf,
} from '../../src/index.js'
import type { EngineStorage } from '../../src/storage.js'
import type { TestCommit } from './contract.js'
import { memoryAdapter } from './memory.js'

it('retains the commit context through scoped steps, case definitions and engine binding', () => {
  const state = z.object({ items: z.array(z.object({ id: z.string() })) })
  const step = stepsOf(
    state,
    actor<{ id: string }>(),
    commitContext<TestCommit>(),
  )
  const definition = caseType({
    name: 'typed',
    state,
    steps: [
      step({
        name: 'record',
        scope: { select: (s) => s.items, key: (item) => item.id },
        handler: async (s, ctx) => {
          expectTypeOf(ctx.actor).toEqualTypeOf<{ id: string }>()
          expectTypeOf(ctx.input).toEqualTypeOf<undefined>()
          expectTypeOf(ctx.scope).toEqualTypeOf<{ id: string }>()
          ctx.onCommit(async (repo) => {
            expectTypeOf(repo).toEqualTypeOf<TestCommit>()
            await repo.record(ctx.scopeKey)
          })
          return s
        },
      }),
    ],
  })
  expectTypeOf(definition).toMatchTypeOf<AnyCaseType<TestCommit>>()
  createEngine({ storage: memoryAdapter().storage, caseTypes: [definition] })
  const incompatible = (storage: EngineStorage<{ unrelated: string }>) =>
    createEngine({
      storage,
      // @ts-expect-error A case requiring TestCommit cannot run against unrelated repositories.
      caseTypes: [definition],
    })
  expectTypeOf(incompatible).toBeFunction()
  expectTypeOf<HandlerContext['onCommit']>()
    .parameter(0)
    .parameter(0)
    .toBeUnknown()
})

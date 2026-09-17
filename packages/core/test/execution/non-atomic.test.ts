import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  actor,
  caseType,
  createEngine,
  repositories,
  StepNotAvailableError,
  stepsOf,
} from '../../src/index.js'
import { createMemoryStorage } from '../storage/memory.js'

async function fixture() {
  const state = z.object({
    ready: z.boolean(),
    items: z.array(z.object({ id: z.string() })),
  })
  interface Operations {
    submit(value: number, actor: string, scope?: string): Promise<void>
  }
  const step = stepsOf(
    state,
    actor<{ id: string; allowed: boolean }>(),
    repositories<Operations>(),
  )
  const definition = caseType({
    name: 'existing-operations',
    state,
    steps: [
      step({
        name: 'submit',
        input: z.object({ value: z.number().positive() }),
        requires: { ready: (s) => s.ready },
        permits: { allowed: (_s, ctx) => ctx.actor.allowed },
        handler: async (ctx) => {
          await ctx.repos.submit(ctx.input.value, ctx.actor.id)
        },
      }),
      step({
        name: 'scoped',
        input: z.object({ value: z.number() }),
        scope: { select: (s) => s.items, key: (item) => item.id },
        handler: async (ctx) => {
          await ctx.repos.submit(ctx.input.value, ctx.actor.id, ctx.scope.id)
        },
      }),
      step({
        name: 'end',
        handler: async (ctx) => {
          ctx.end()
        },
      }),
    ],
  })
  const memory = createMemoryStorage()
  const binding = memory.bindCase(definition, () => ({
    submit: async () => {
      throw new Error('atomic repository used')
    },
  }))
  await memory.seed('domain', { ready: true, items: [{ id: 'first' }] })
  const engine = createEngine({ storage: memory.storage, caseTypes: [binding] })
  const { id } = await engine.attachCase(definition.name, {
    reference: 'domain',
  })
  const submit = vi.fn<Operations['submit']>().mockResolvedValue(undefined)
  const options = {
    actor: { id: 'admin', allowed: true },
    input: { value: 3 },
    repos: { submit },
  }
  return { engine, memory, id, submit, options }
}

describe('non-atomic execution', () => {
  it('calls the registered handler with caller operations and leaves the atomic port and journal untouched', async () => {
    const { engine, memory, id, submit, options } = await fixture()
    const atomic = vi.spyOn(memory.storage.execution, 'withCase')
    const load = vi.spyOn(memory.storage.cases, 'get')
    const result = await engine.executeNonAtomic(id, 'submit', options)
    expect(submit).toHaveBeenCalledExactlyOnceWith(3, 'admin')
    expect(load).toHaveBeenCalledTimes(1)
    expect(atomic).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      mode: 'non-atomic',
      caseId: id,
      step: 'submit',
      guard: { available: true },
    })
    for (const field of ['delta', 'state', 'seq', 'committedAt'])
      expect(result).not.toHaveProperty(field)
    expect(await engine.journal(id)).toEqual([])
  })

  it('resolves the canonical scoped step before invocation', async () => {
    const { engine, id, submit, options } = await fixture()
    const result = await engine.executeNonAtomic(id, 'scoped', {
      ...options,
      scopeKey: 'first',
    })
    expect(result.scopeKey).toBe('first')
    expect(submit).toHaveBeenCalledExactlyOnceWith(3, 'admin', 'first')
  })

  it('reevaluates current state and refuses before the handler', async () => {
    const { engine, memory, id, submit, options } = await fixture()
    await memory.seed('domain', { ready: false, items: [] })
    await expect(
      engine.executeNonAtomic(id, 'submit', options),
    ).rejects.toBeInstanceOf(StepNotAvailableError)
    expect(submit).not.toHaveBeenCalled()
  })

  it('enforces actor permissions before the handler', async () => {
    const { engine, id, submit, options } = await fixture()
    await expect(
      engine.executeNonAtomic(id, 'submit', {
        ...options,
        actor: { id: 'denied', allowed: false },
      }),
    ).rejects.toBeInstanceOf(StepNotAvailableError)
    expect(submit).not.toHaveBeenCalled()
  })

  it.each(['input', 'scope', 'step', 'case'])(
    'rejects invalid %s without invoking operations',
    async (problem) => {
      const { engine, id, submit, options } = await fixture()
      await expect(
        engine.executeNonAtomic(
          problem === 'case' ? 'missing' : id,
          problem === 'step'
            ? 'missing'
            : problem === 'scope'
              ? 'scoped'
              : 'submit',
          {
            ...options,
            ...(problem === 'input' ? { input: { value: -1 } } : {}),
            ...(problem === 'scope' ? { scopeKey: 'missing' } : {}),
          },
        ),
      ).rejects.toThrow()
      expect(submit).not.toHaveBeenCalled()
    },
  )

  it('does not reload state after a successful operation or fail because its result no longer fits the schema', async () => {
    const { engine, memory, id, submit, options } = await fixture()
    submit.mockImplementation(async () => {
      await memory.seed('domain', { removed: true })
    })
    await expect(
      engine.executeNonAtomic(id, 'submit', options),
    ).resolves.toMatchObject({ mode: 'non-atomic' })
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('preserves the original error and partial effects without retry or a rollback claim', async () => {
    const { engine, id, submit, options } = await fixture()
    const error = new Error('second transaction failed')
    let committed = 0
    submit.mockImplementation(async () => {
      committed++
      throw error
    })
    await expect(engine.executeNonAtomic(id, 'submit', options)).rejects.toBe(
      error,
    )
    expect(committed).toBe(1)
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('refuses atomic metadata helpers explicitly', async () => {
    const { engine, id, options } = await fixture()
    await expect(
      engine.executeNonAtomic(id, 'end', { ...options, input: undefined }),
    ).rejects.toThrow('Non-atomic handlers cannot stage')
    expect((await engine.case(id)).endedAt).toBeNull()
  })
})

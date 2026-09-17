import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { z } from 'zod'
import {
  actor,
  type BackgroundRuntime,
  caseType,
  createBackgroundRuntime,
  createEngine,
  type HandlerContext,
  type JournalDisposition,
  type RunResult,
  stepsOf,
} from '../../src/index.js'
import { createMemoryStorage } from '../storage/memory.js'

const State = z.object({
  count: z.number(),
  at: z.date(),
  tags: z.set(z.string()),
  large: z.bigint(),
})
type State = z.output<typeof State>
const initial = (): State => ({
  count: 0,
  at: new Date('2026-01-01'),
  tags: new Set(['a']),
  large: 1n,
})
const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
const runtimes: ReturnType<typeof createBackgroundRuntime>[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const r of runtimes.splice(0)) await r.drain()
  vi.restoreAllMocks()
})
async function fixture(
  handler: (
    ctx: HandlerContext<State, { id: string }>,
    // biome-ignore lint/suspicious/noConfusingVoidType: Accept async handlers that intentionally return no value.
  ) => Promise<State | void>,
  runtime?: BackgroundRuntime,
) {
  let now = Date.now()
  const memory = createMemoryStorage(() => now)
  const owned = createBackgroundRuntime()
  runtimes.push(owned)
  const step = stepsOf(State, actor<{ id: string }>())
  const definition = caseType({
    name: 'run',
    state: State,
    steps: [step({ name: 'work', handler })],
  })
  const binding = memory.bindCase(definition)
  await memory.seed('one', initial())
  await memory.seed('two', initial())
  const engine = createEngine({
    storage: memory.storage,
    caseTypes: [binding],
    operations: { journalTimeoutMs: 20 },
    launch: { runtime: runtime ?? owned, leaseMs: 100 },
  })
  const { id } = await engine.attachCase('run', { reference: 'one' })
  const other = await engine.attachCase('run', { reference: 'two' })
  return {
    engine,
    memory,
    id,
    other: other.id,
    runtime: owned,
    advance: () => {
      now += 101
    },
    args: { actor: { id: 'a' } },
  }
}
describe('run evidence', () => {
  it('waits for completion and snapshots before accidental in-place mutations', async () => {
    const gate = deferred()
    let entered = false
    const f = await fixture(async (c) => {
      entered = true
      await gate.promise
      c.state.count = 9
      c.state.at.setUTCFullYear(2030)
      c.state.tags.add('b')
      c.state.large = 2n
      return c.state
    })
    let done = false
    const pending = f.engine.run(f.id, 'work', f.args).then((r) => {
      done = true
      return r
    })
    await vi.waitFor(() => expect(entered).toBe(true))
    expect(done).toBe(false)
    gate.resolve()
    expect((await pending).journal.status).toBe('recorded')
    const [entry] = await f.engine.journal(f.id)
    expect(entry!.state).toEqual(initial())
    expect(entry!.delta).toContainEqual({
      op: 'replace',
      path: '/json/count',
      value: 9,
    })
    expect((await f.engine.case(f.id)).state).toEqual(initial())
  })
  it('journals unchanged state and never reloads after handler entry', async () => {
    const f = await fixture(async (c) => c.state)
    const load = vi.spyOn(f.memory.storage.cases, 'get')
    await f.engine.run(f.id, 'work', f.args)
    expect(load).toHaveBeenCalledTimes(1)
    expect((await f.engine.journal(f.id))[0]!.delta).toEqual([])
  })
  it('treats invalid returned evidence as known business success', async () => {
    let calls = 0
    const f = await fixture(async () => {
      calls++
      return { count: 'invalid' } as never
    })
    expect((await f.engine.run(f.id, 'work', f.args)).journal).toEqual({
      status: 'failed',
      reason: 'evidence',
    })
    expect(calls).toBe(1)
    expect(await f.engine.journal(f.id)).toEqual([])
  })
  it('reports serialization errors safely after handler success', async () => {
    const f = await fixture(async (c) => {
      c.state.count = Number.NaN
      return c.state
    })
    expect((await f.engine.run(f.id, 'work', f.args)).journal).toEqual({
      status: 'failed',
      reason: 'evidence',
    })
  })
  it('bounds journal acquisition and permits a late identity-preserving write', async () => {
    const f = await fixture(async (c) => ({ ...c.state, count: 1 }))
    const gate = deferred()
    const original = f.memory.storage.journal.observe!
    vi.spyOn(f.memory.storage.journal, 'observe').mockImplementation(
      async (e) => {
        await gate.promise
        await original(e)
      },
    )
    try {
      const result = await f.engine.run(f.id, 'work', f.args)
      expect(result.journal).toEqual({ status: 'failed', reason: 'timeout' })
      expect(await f.engine.journal(f.id)).toEqual([])
      gate.resolve()
      await vi.waitFor(async () =>
        expect(await f.engine.journal(f.id)).toHaveLength(1),
      )
      expect((await f.engine.journal(f.id))[0]!.executionId).toBe(
        result.executionId,
      )
      expect(result.journal.status).toBe('failed')
    } finally {
      gate.resolve()
    }
  })
  it('does not start a write after asynchronous evidence validation times out', async () => {
    const gate = deferred()
    const f = await fixture(async (c) => c.state)
    // Replace the Case schema validator only after preparation validates current state.
    const binding = f.memory.bindCase(
      caseType({
        name: 'slow',
        state: State,
        steps: [
          stepsOf(State)({
            name: 'work',
            handler: async (c) => {
              vi.spyOn(State['~standard'], 'validate').mockImplementation(
                async () => {
                  await gate.promise
                  return { value: initial() }
                },
              )
              return c.state
            },
          }),
        ],
      }),
    )
    const engine = createEngine({
      storage: f.memory.storage,
      caseTypes: [binding],
      operations: { journalTimeoutMs: 20 },
    })
    const { id } = await engine.attachCase('slow', { reference: 'one' })
    const observe = vi.spyOn(f.memory.storage.journal, 'observe')
    try {
      expect((await engine.run(id, 'work', { actor: null })).journal).toEqual({
        status: 'failed',
        reason: 'timeout',
      })
      gate.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(observe).not.toHaveBeenCalled()
    } finally {
      gate.resolve()
    }
  })
  it('does not let diagnostic logging turn journal failure into handler failure', async () => {
    const f = await fixture(async (c) => c.state)
    vi.spyOn(f.memory.storage.journal, 'observe').mockRejectedValue(
      new Error('storage failed'),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('logger failed')
    })
    expect((await f.engine.run(f.id, 'work', f.args)).journal).toEqual({
      status: 'failed',
      reason: 'storage',
    })
  })
  it('requires the journal capability before any business invocation', async () => {
    const handler = vi.fn(async () => {})
    const f = await fixture(handler)
    Reflect.deleteProperty(f.memory.storage.journal, 'observe')
    await expect(f.engine.run(f.id, 'work', f.args)).rejects.toThrow(
      'journal.observe',
    )
    expect(handler).not.toHaveBeenCalled()
  })
  it('uses undefined rather than truthiness for scalar State', async () => {
    const memory = createMemoryStorage()
    const step = stepsOf(z.boolean())
    const def = caseType({
      name: 'boolean',
      state: z.boolean(),
      steps: [step({ name: 'false', handler: async () => false })],
    })
    await memory.seed('bool', true)
    const engine = createEngine({
      storage: memory.storage,
      caseTypes: [memory.bindCase(def)],
    })
    const { id } = await engine.attachCase('boolean', { reference: 'bool' })
    expect(
      (await engine.run(id, 'false', { actor: null })).journal.status,
    ).toBe('recorded')
  })
})
describe('launch lifecycle', () => {
  it('rejects a second concurrent claim but runs different cases independently', async () => {
    const gate = deferred()
    const handler = vi.fn(async () => {
      await gate.promise
    })
    const f = await fixture(handler)
    try {
      const results = await Promise.allSettled([
        f.engine.launch(f.id, 'work', f.args),
        f.engine.launch(f.id, 'work', f.args),
        f.engine.launch(f.other, 'work', f.args),
      ])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
      expect(handler).toHaveBeenCalledTimes(2)
    } finally {
      gate.resolve()
    }
  })
  it('leaves expired work blocked, permits explicit resolution, rejects old callbacks, and does not fence domain effects', async () => {
    const old = deferred()
    const newer = deferred()
    let calls = 0
    let lateEffect = false
    const f = await fixture(async (c) => {
      calls++
      if (calls === 1) {
        await old.promise
        lateEffect = true
      } else await newer.promise
      return { ...c.state, count: calls }
    })
    try {
      const first = await f.engine.launch(f.id, 'work', f.args)
      f.advance()
      expect(await f.engine.getExecution(first.executionId)).toMatchObject({
        status: 'unresolved',
        reason: 'expired',
      })
      await expect(f.engine.launch(f.id, 'work', f.args)).rejects.toThrow(
        'unresolved',
      )
      const resolved = await f.engine.resolveExecution(first.executionId, {
        actor: 'operator',
        reason: 'Reconciled potentially live provider request',
      })
      const next = await f.engine.launch(f.id, 'work', f.args)
      old.resolve()
      await vi.waitFor(() => expect(lateEffect).toBe(true))
      expect(await f.engine.getExecution(first.executionId)).toEqual(resolved)
      expect(await f.engine.getExecution(next.executionId)).toMatchObject({
        status: 'running',
      })
      await expect(
        f.engine.resolveExecution(first.executionId, {
          actor: 'operator',
          reason: 'again',
        }),
      ).rejects.toThrow()
      expect(await f.engine.getExecution(next.executionId)).toMatchObject({
        status: 'running',
      })
    } finally {
      old.resolve()
      newer.resolve()
    }
  })
  it('completes and releases ownership when journal storage fails', async () => {
    const f = await fixture(async (c) => c.state)
    vi.spyOn(f.memory.storage.journal, 'observe').mockRejectedValue(
      new Error('private connection string'),
    )
    const result = await f.engine.launch(f.id, 'work', f.args)
    await f.runtime.drain()
    expect(await f.engine.getExecution(result.executionId)).toMatchObject({
      status: 'completed',
      journal: { status: 'failed', reason: 'storage' },
    })
    expect(
      JSON.stringify(await f.engine.getExecution(result.executionId)),
    ).not.toContain('private')
  })
  it('preserves uncertainty when finalization fails, without replaying handlers', async () => {
    const handler = vi.fn(async () => {})
    const f = await fixture(handler)
    vi.spyOn(f.memory.storage.launches!, 'complete').mockRejectedValue(
      new Error('lost ack'),
    )
    const result = await f.engine.launch(f.id, 'work', f.args)
    await f.runtime.drain()
    expect(await f.engine.getExecution(result.executionId)).toMatchObject({
      status: 'unresolved',
      reason: 'finalization',
    })
    expect(handler).toHaveBeenCalledTimes(1)
  })
  it('lookup reconciles a lost completion acknowledgment', async () => {
    const f = await fixture(async () => {})
    const complete = f.memory.storage.launches!.complete
    vi.spyOn(f.memory.storage.launches!, 'complete').mockImplementation(
      async (id, j) => {
        await complete(id, j)
        throw new Error('lost ack')
      },
    )
    const result = await f.engine.launch(f.id, 'work', f.args)
    await f.runtime.drain()
    expect(await f.engine.getExecution(result.executionId)).toMatchObject({
      status: 'completed',
    })
  })
  it('releases a known-safe failed handoff and prevents a delayed callback from starting', async () => {
    let delayed!: () => Promise<void>
    const f = await fixture(
      vi.fn(async () => {}),
      {
        start: async (task) => {
          delayed = task
          throw new Error('handoff failed')
        },
      },
    )
    await expect(f.engine.launch(f.id, 'work', f.args)).rejects.toThrow(
      'handoff failed',
    )
    await delayed()
    // A second claim reaches the runtime: the first did not retain ownership.
    await expect(f.engine.launch(f.id, 'work', f.args)).rejects.toThrow(
      'handoff failed',
    )
  })
  it('keeps a start with a lost acknowledgment unresolved without entering the handler', async () => {
    const handler = vi.fn(async () => {})
    const f = await fixture(handler)
    const start = f.memory.storage.launches!.start
    vi.spyOn(f.memory.storage.launches!, 'start').mockImplementation(
      async (id) => {
        await start(id)
        throw new Error('lost start ack')
      },
    )
    await expect(f.engine.launch(f.id, 'work', f.args)).rejects.toMatchObject({
      name: 'LaunchUnresolvedError',
    })
    expect(handler).not.toHaveBeenCalled()
    await expect(f.engine.launch(f.id, 'work', f.args)).rejects.toMatchObject({
      name: 'LaunchBlockedError',
    })
  })
  it('releases a preparation refusal', async () => {
    const f = await fixture(async () => {})
    await expect(f.engine.launch(f.id, 'missing', f.args)).rejects.toThrow()
    const result = await f.engine.launch(f.id, 'work', f.args)
    expect(result.executionId).toBeTypeOf('string')
  })
  it('allows ordinary runs while a launch owns the case', async () => {
    const gate = deferred()
    let calls = 0
    const f = await fixture(async () => {
      calls++
      if (calls === 1) await gate.promise
    })
    try {
      await f.engine.launch(f.id, 'work', f.args)
      await f.engine.run(f.id, 'work', f.args)
      expect(calls).toBe(2)
    } finally {
      gate.resolve()
    }
  })
  it('drains tasks independently of a finished caller and refuses new tasks after shutdown', async () => {
    const gate = deferred()
    const f = await fixture(async () => {
      await gate.promise
    })
    const result = await f.engine.launch(f.id, 'work', f.args)
    let drained = false
    const closing = f.runtime.drain().then(() => {
      drained = true
    })
    expect(drained).toBe(false)
    gate.resolve()
    await closing
    expect(await f.engine.getExecution(result.executionId)).toMatchObject({
      status: 'completed',
    })
    await expect(f.engine.launch(f.id, 'work', f.args)).rejects.toThrow(
      'closed',
    )
  })
})
// Compile-time contract: state and void allowed, unrelated output rejected.
const typeChecks = () => {
  const step = stepsOf(State, actor<{ id: string }>())
  step({ name: 'void', handler: async () => {} })
  step({ name: 'state', handler: async (c) => c.state })
  // @ts-expect-error an unrelated shape is not evidence of Case State
  step({ name: 'invalid', handler: async () => ({ unrelated: true }) })
  step({
    name: 'context',
    handler: async (c) => {
      expectTypeOf(c.actor.id).toEqualTypeOf<string>()
      // @ts-expect-error domain transaction repositories are not injected
      void c.repos
    },
  })
  expectTypeOf<RunResult['journal']>().toEqualTypeOf<JournalDisposition>()
}
void typeChecks

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  actor,
  caseType,
  type Engine,
  type EngineStorage,
  type HandlerContext,
  stepsOf,
} from '../../src/index.js'

export const DomainState = z.object({
  count: z.number().int().nonnegative(),
  buyers: z.array(z.object({ id: z.string(), name: z.string() })),
})
export type Domain = z.output<typeof DomainState>
export interface Actor {
  id: string
  allowed: boolean
}
export type Handler = (
  ctx: HandlerContext<Domain, Actor>,
  // biome-ignore lint/suspicious/noConfusingVoidType: Accept async handlers that intentionally return no value.
) => Promise<Domain | void>
export const domainDefinition = (name: string, handler: Handler) => {
  const step = stepsOf(DomainState, actor<Actor>())
  return caseType({
    name,
    state: DomainState,
    steps: [
      step({
        name: 'change',
        permits: { allowed: (_s, c) => c.actor.allowed },
        handler,
      }),
      step({
        name: 'scoped',
        scope: { select: (s) => s.buyers, key: (b) => b.id },
        input: z.object({ name: z.string() }),
        handler: async (c) => ({
          ...c.state,
          buyers: c.state.buyers.map((b) =>
            b.id === c.scopeKey ? { ...b, name: c.input.name } : b,
          ),
        }),
      }),
    ],
  })
}
export type Definition = ReturnType<typeof domainDefinition>
export interface DomainFixture {
  engine: Engine
  storage: EngineStorage
  id: string
  reference: string
  externalCount(n: number): Promise<void>
  drain(): Promise<void>
}
export const domainContract = (
  label: string,
  create: (definition: Definition) => Promise<DomainFixture>,
) => {
  let serial = 0
  const fixture = (handler: Handler) =>
    create(domainDefinition(`${label}-${Date.now()}-${serial++}`, handler))
  const actor = {
    id: 'operator',
    allowed: true,
    credential: 'never-store-this',
  }
  describe(`${label}: handler-owned execution`, () => {
    it('records returned state as evidence without persisting it or advancing domain metadata', async () => {
      const f = await fixture(async (c) => ({ ...c.state, count: 8 }))
      const result = await f.engine.run(f.id, 'change', { actor })
      expect(result.journal).toEqual({ status: 'recorded' })
      expect(await f.engine.case(f.id)).toMatchObject({
        state: { count: 0 },
        seq: 0,
      })
      const entries = await f.engine.journal(f.id)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        entry: 'observed',
        actor: 'operator',
        input: null,
        state: { count: 0 },
        delta: [{ op: 'replace', path: '/json/count', value: 8 }],
      })
      expect(JSON.stringify(entries)).not.toContain('never-store-this')
      expect(await f.engine.getExecution(result.executionId)).toBeNull()
    })
    it('reads subsequent authoritative domain writes and skips void journals', async () => {
      let f: DomainFixture
      f = await fixture(async () => {
        await f.externalCount(4)
      })
      expect((await f.engine.run(f.id, 'change', { actor })).journal).toEqual({
        status: 'skipped',
      })
      expect((await f.engine.case(f.id)).state).toMatchObject({ count: 4 })
      expect(await f.engine.journal(f.id)).toEqual([])
    })
    it('preserves errors after domain commit without success evidence or retries', async () => {
      let f: DomainFixture
      let calls = 0
      const error = new Error('after commit')
      f = await fixture(async () => {
        calls++
        await f.externalCount(5)
        throw error
      })
      await expect(f.engine.run(f.id, 'change', { actor })).rejects.toBe(error)
      expect(calls).toBe(1)
      expect((await f.engine.case(f.id)).state).toMatchObject({ count: 5 })
      expect(await f.engine.journal(f.id)).toEqual([])
    })
    it('refuses guard/input/scope errors before invoking business code', async () => {
      let calls = 0
      const f = await fixture(async () => {
        calls++
      })
      await expect(
        f.engine.run(f.id, 'change', { actor: { ...actor, allowed: false } }),
      ).rejects.toMatchObject({ code: 'step-not-available' })
      await expect(
        f.engine.run(f.id, 'scoped', {
          actor,
          scopeKey: 'missing',
          input: { name: 'X' },
        }),
      ).rejects.toThrow()
      await expect(
        f.engine.run(f.id, 'scoped', {
          actor,
          scopeKey: 'a',
          input: { name: 42 },
        }),
      ).rejects.toThrow()
      expect(calls).toBe(0)
      expect(await f.engine.journal(f.id)).toEqual([])
    })
    it('acknowledges handler entry, excludes same-case launches, and completes without a journal', async () => {
      let finish!: () => void
      let calls = 0
      const blocked = new Promise<void>((r) => {
        finish = r
      })
      const f = await fixture(async () => {
        calls++
        await blocked
      })
      try {
        const launched = await f.engine.launch(f.id, 'change', { actor })
        expect(calls).toBe(1)
        expect(await f.engine.getExecution(launched.executionId)).toMatchObject(
          { status: 'running', actor: 'operator' },
        )
        await expect(
          f.engine.launch(f.id, 'change', { actor }),
        ).rejects.toMatchObject({ name: 'LaunchBlockedError' })
        finish()
        await f.drain()
        expect(await f.engine.getExecution(launched.executionId)).toMatchObject(
          { status: 'completed', journal: { status: 'skipped' } },
        )
        expect(await f.engine.journal(f.id)).toEqual([])
      } finally {
        finish()
        await f.drain()
      }
    })
    it('records late handler errors, resolves explicitly and retains immutable resolution', async () => {
      const f = await fixture(async () => {
        throw new Error('secret provider error')
      })
      const launched = await f.engine.launch(f.id, 'change', { actor })
      await f.drain()
      expect(await f.engine.getExecution(launched.executionId)).toMatchObject({
        status: 'unresolved',
        reason: 'handler-error',
      })
      const resolved = await f.engine.resolveExecution(launched.executionId, {
        actor: { id: 'reconciler', secret: 'hidden' },
        reason: 'Provider confirmed outcome',
      })
      expect(resolved).toMatchObject({
        status: 'resolved',
        resolution: {
          actor: 'reconciler',
          reason: 'Provider confirmed outcome',
        },
      })
      await f.storage.launches!.complete(launched.executionId, {
        status: 'recorded',
      })
      expect(await f.engine.getExecution(launched.executionId)).toEqual(
        resolved,
      )
      expect(JSON.stringify(resolved)).not.toContain('secret provider error')
    })
    it('makes duplicate observation writes idempotent by execution identity', async () => {
      const f = await fixture(async (c) => c.state)
      const result = await f.engine.run(f.id, 'change', { actor })
      const entry = (await f.engine.journal(f.id))[0]!
      const evidence = {
        ...entry,
        entry: 'observed' as const,
        asOf: entry.asOf!,
        observedAt: entry.observedAt!,
        delta: entry.delta!,
      }
      await Promise.all([
        f.storage.journal.observe!(evidence),
        f.storage.journal.observe!(evidence),
      ])
      expect(
        await f.engine.journal(f.id, { executionId: result.executionId }),
      ).toHaveLength(1)
    })
  })
}

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  actor,
  caseType,
  type Engine,
  type EngineStorage,
  foldExecutions,
  isStartedEntry,
  replayGuard,
  repositories,
  stepsOf,
} from '../../src/index.js'

export const DomainState = z.object({
  count: z.number().int().nonnegative(),
  buyers: z.array(z.object({ id: z.string(), name: z.string() })),
})
export type Domain = z.output<typeof DomainState>
export interface Operations {
  setCount(n: number): Promise<void>
  rename(id: string, name: string): Promise<void>
}
export interface Actor {
  allowed: boolean
}
const step = stepsOf(DomainState, actor<Actor>(), repositories<Operations>())
export const domainDefinition = (name: string) =>
  caseType({
    name,
    state: DomainState,
    steps: [
      step({
        name: 'increment',
        permits: { allowed: (_s, c) => c.actor.allowed },
        handler: async (c) => {
          await c.repos.setCount(c.state.count + 1)
        },
      }),
      step({
        name: 'once',
        requires: { initial: (s) => s.count === 0 },
        handler: async (c) => {
          await c.repos.setCount(1)
        },
      }),
      step({
        name: 'fail',
        handler: async (c) => {
          await c.repos.setCount(12)
          c.correlate({ system: 'test', externalId: c.reference })
          c.end()
          throw new Error('application failed')
        },
      }),
      step({
        name: 'invalid',
        handler: async (c) => {
          await c.repos.setCount(-1)
        },
      }),
      step({
        name: 'rename',
        scope: { select: (s) => s.buyers, key: (b) => b.id },
        input: z.object({ name: z.string() }),
        handler: async (c) => {
          await c.repos.rename(c.scopeKey, c.input.name)
        },
      }),
      step({
        name: 'evidence',
        input: z.object({ name: z.string() }),
        handler: async (c) => {
          c.state.count = 999
          c.actor.allowed = false
          c.input.name = 'mutated'
          await c.repos.setCount(5)
          c.correlate({ system: 'test', externalId: c.reference })
          c.end()
        },
      }),
      step({ name: 'reopen', handler: async (c) => c.reopen() }),
    ],
  })
export type Definition = ReturnType<typeof domainDefinition>
export interface DomainFixture {
  engine: Engine
  storage: EngineStorage
  id: string
  reference: string
  externalCount(n: number): Promise<void>
}
export const domainContract = (
  label: string,
  create: (definition: Definition) => Promise<DomainFixture>,
) => {
  let serial = 0
  const fixture = () =>
    create(domainDefinition(`${label}-${Date.now()}-${serial++}`))
  describe(`${label}: domain execution contract`, () => {
    it('attaches idempotently and reads external changes without advancing execution sequence', async () => {
      const f = await fixture()
      const row = await f.engine.case(f.id)
      expect(
        (
          await f.engine.attachCase(row.caseTypeName, {
            reference: f.reference,
          })
        ).id,
      ).toBe(f.id)
      await f.externalCount(7)
      expect((await f.engine.case(f.id)).state).toMatchObject({ count: 7 })
      expect((await f.engine.listCases()).cases[0]?.state).toMatchObject({
        count: 7,
      })
      expect((await f.engine.case(f.id)).seq).toBe(0)
      const offered = await f.engine.affordances(f.id, { allowed: true })
      expect(offered.affordances.some((a) => a.step === 'once')).toBe(false)
      expect((await f.engine.explain(f.id, 'once')).evaluation.possible).toBe(
        false,
      )
    })
    it('serializes concurrent executions, loading fresh state for each handler', async () => {
      const f = await fixture()
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          f.engine.execute(f.id, 'increment', { actor: { allowed: true } }),
        ),
      )
      expect(results.map((r) => r.seq).sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ])
      expect((await f.engine.case(f.id)).state).toMatchObject({ count: 8 })
      expect(await f.engine.journal(f.id)).toHaveLength(16)
    })
    it('rechecks guards under protection so only one competing once-only operation runs', async () => {
      const f = await fixture()
      const results = await Promise.allSettled([
        f.engine.execute(f.id, 'once', { actor: {} }),
        f.engine.execute(f.id, 'once', { actor: {} }),
      ])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect((await f.engine.case(f.id)).seq).toBe(1)
      expect(await f.engine.journal(f.id)).toHaveLength(2)
    })
    it('refuses actors before writes and journals nothing', async () => {
      const f = await fixture()
      await expect(
        f.engine.execute(f.id, 'increment', { actor: { allowed: false } }),
      ).rejects.toMatchObject({ code: 'step-not-available' })
      expect((await f.engine.case(f.id)).state).toMatchObject({ count: 0 })
      expect(await f.engine.journal(f.id)).toEqual([])
    })
    it.each(['fail', 'invalid'])(
      'rolls back domain writes, evidence, correlations, sequence and dormancy on %s',
      async (stepName) => {
        const f = await fixture()
        await expect(
          f.engine.execute(f.id, stepName, { actor: { allowed: true } }),
        ).rejects.toMatchObject({ code: 'execution-failed', attempts: 1 })
        expect(await f.engine.case(f.id)).toMatchObject({
          state: { count: 0 },
          seq: 0,
          endedAt: null,
        })
        expect(await f.engine.journal(f.id)).toEqual([])
        expect(await f.engine.correlations(f.id)).toEqual([])
      },
    )
    it('rolls back even when completion persistence fails after writing evidence', async () => {
      const f = await fixture()
      const withCase = f.storage.execution.withCase
      f.storage.execution.withCase = (id, executionId, run) =>
        withCase(id, executionId, (session) =>
          run({
            ...session,
            persistCompletion: async (evidence) => {
              await session.persistCompletion(evidence)
              throw new Error('journal write failed')
            },
          }),
        )
      await expect(
        f.engine.execute(f.id, 'evidence', {
          actor: { allowed: true },
          input: { name: 'original' },
        }),
      ).rejects.toThrow()
      expect(await f.engine.case(f.id)).toMatchObject({
        seq: 0,
        endedAt: null,
        state: { count: 0 },
      })
      expect(await f.engine.journal(f.id)).toEqual([])
      expect(await f.engine.correlations(f.id)).toEqual([])
    })
    it('updates one scoped record and preserves unrelated facts', async () => {
      const f = await fixture()
      await f.engine.execute(f.id, 'rename', {
        actor: {},
        scopeKey: 'a',
        input: { name: 'Renamed' },
      })
      expect((await f.engine.case(f.id)).state).toEqual({
        count: 0,
        buyers: [
          { id: 'a', name: 'Renamed' },
          { id: 'b', name: 'Bob' },
        ],
      })
      await expect(
        f.engine.execute(f.id, 'rename', {
          actor: {},
          scopeKey: 'missing',
          input: { name: 'x' },
        }),
      ).rejects.toThrow()
    })
    it('records immutable enforcement evidence and replays it after handler mutation', async () => {
      const f = await fixture()
      const actor = { allowed: true }
      const input = { name: 'original' }
      const result = await f.engine.execute(f.id, 'evidence', { actor, input })
      expect(actor).toEqual({ allowed: true })
      expect(input).toEqual({ name: 'original' })
      expect(result.state).toMatchObject({ count: 5 })
      expect(result.endedAt).not.toBeNull()
      const entries = await f.engine.journal(f.id)
      expect(entries.map((e) => e.entry)).toEqual(['started', 'completed'])
      expect(entries[0]).toMatchObject({
        state: { count: 0 },
        actor: { allowed: true },
        input: { name: 'original' },
      })
      expect(entries[1]?.delta).toEqual(result.delta)
      const started = entries[0]!
      if (!isStartedEntry(started))
        throw new Error('missing enforcement evidence')
      expect(
        (
          await replayGuard(
            domainDefinition((await f.engine.case(f.id)).caseTypeName),
            started,
          )
        ).matches,
      ).toBe(true)
      expect(foldExecutions(entries)[0]).toMatchObject({
        status: 'completed',
        startedAt: result.startedAt,
      })
      expect(await f.engine.correlations(f.id)).toHaveLength(1)
      expect((await f.engine.listCases()).cases).toEqual([])
      await f.engine.execute(f.id, 'reopen', { actor: {} })
      expect((await f.engine.case(f.id)).endedAt).toBeNull()
    })
    it('rejects invalid attachment without leaving case metadata', async () => {
      const f = await fixture()
      const type = (await f.engine.case(f.id)).caseTypeName
      await expect(
        f.engine.attachCase(type, { reference: 'missing-domain' }),
      ).rejects.toThrow()
      expect((await f.engine.listCases()).cases).toHaveLength(1)
    })
  })
}

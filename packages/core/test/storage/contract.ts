/** The same behavioral contract runs against a non-SQL adapter and Postgres. */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  CaseBusyError,
  CaseStateValidationError,
  ClaimLostError,
  caseType,
  commitContext,
  createEngine,
  hasMigrated,
  stepsOf,
} from '../../src/index.js'
import type { EngineStorage } from '../../src/storage.js'

export interface TestCommit {
  record(message: string): Promise<void>
  correlated(system: string, externalId: string): Promise<boolean>
}
export interface AdapterFixture {
  readonly storage: EngineStorage<TestCommit>
  records(): Promise<readonly string[]>
  corrupt(caseId: string, state: unknown): Promise<void>
  expire(caseId: string): Promise<void>
}

const State = z.object({
  count: z.number().default(0),
  label: z.string().default('case'),
})
const defineStep = stepsOf(State, undefined, commitContext<TestCommit>())
const define = (
  steps: Parameters<
    typeof caseType<typeof State, unknown, TestCommit>
  >[0]['steps'],
) => caseType({ name: `contract-${randomUUID()}`, state: State, steps })
const gate = () => {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

export const storageContract = (
  name: string,
  factory: () => AdapterFixture | Promise<AdapterFixture>,
) => {
  describe(`${name} storage contract`, () => {
    it('lists registered cases with stable paging, filtering and the same validation as addressed reads', async () => {
      const f = await factory()
      const type = define([
        defineStep({
          name: 'end',
          handler: async (s, ctx) => {
            ctx.end()
            return s
          },
        }),
      ])
      const other = define([])
      const engine = createEngine({
        storage: f.storage,
        caseTypes: [type, other],
      })
      const first = await engine.createCase(type.name, {})
      const second = await engine.createCase(type.name, { label: 'second' })
      const dormant = await engine.createCase(type.name, { label: 'dormant' })
      await engine.execute(dormant.id, 'end', { actor: null })
      await engine.createCase(other.name, {})
      await f.storage.cases.create('unregistered', {})
      const page = await engine.listCases({ caseTypeName: type.name, limit: 1 })
      expect(page.cases).toHaveLength(1)
      expect(page.nextCursor).not.toBeNull()
      const next = await engine.listCases({
        caseTypeName: type.name,
        limit: 1,
        cursor: page.nextCursor!,
      })
      expect(next.nextCursor).toBeNull()
      expect(new Set([...page.cases, ...next.cases].map((c) => c.id))).toEqual(
        new Set([first.id, second.id]),
      )
      expect(
        (
          await engine.listCases({
            caseTypeName: type.name,
            includeEnded: true,
          })
        ).cases,
      ).toHaveLength(3)
      expect((await engine.listCases()).cases).toHaveLength(3)
      expect(page.cases[0]).toEqual(await engine.case(page.cases[0]!.id))
      await f.corrupt(first.id, { label: 'old' })
      expect((await engine.case(first.id)).state).toEqual({
        count: 0,
        label: 'old',
      })
      expect(
        (await engine.listCases()).cases.find((c) => c.id === first.id)?.state,
      ).toEqual({ count: 0, label: 'old' })
      await f.corrupt(first.id, { count: 'invalid' })
      await expect(engine.case(first.id)).rejects.toThrow(
        CaseStateValidationError,
      )
      await expect(engine.listCases()).rejects.toThrow(CaseStateValidationError)
      await expect(engine.listCases({ limit: 0 })).rejects.toThrow(TypeError)
    })

    it('excludes concurrent claimants and refuses a displaced handler commit', async () => {
      const f = await factory()
      const entered = gate()
      const finish = gate()
      const type = define([
        defineStep({
          name: 'wait',
          handler: async (s) => {
            entered.open()
            await finish.promise
            return { ...s, count: 100 }
          },
        }),
        defineStep({
          name: 'increment',
          handler: async (s) => ({ ...s, count: s.count + 1 }),
        }),
      ])
      const engine = createEngine({
        storage: f.storage,
        caseTypes: [type],
        heartbeatMs: 3_600_000,
      })
      const created = await engine.createCase(type.name, {})
      const held = engine.execute(created.id, 'wait', { actor: null })
      try {
        await entered.promise
        await expect(
          engine.execute(created.id, 'increment', { actor: null }),
        ).rejects.toThrow(CaseBusyError)
        await f.expire(created.id)
        await engine.execute(created.id, 'increment', { actor: null })
      } finally {
        finish.open()
      }
      await expect(held).rejects.toThrow(ClaimLostError)
      expect((await engine.case(created.id)).state).toMatchObject({ count: 1 })
      expect(
        (await engine.journal(created.id)).filter(
          (e) => e.entry === 'completed',
        ),
      ).toHaveLength(1)
    })

    it('rolls state, dormancy, correlations and repository effects back together', async () => {
      const f = await factory()
      const system = randomUUID()
      const type = define([
        defineStep({
          name: 'poison',
          retry: { maxAttempts: 1 },
          handler: async (s, ctx) => {
            ctx.end()
            ctx.onCommit(async (repo) => {
              expect(await repo.correlated(system, 'a')).toBe(false)
              await repo.record('before')
            })
            ctx.correlate({ system, externalId: 'a' })
            ctx.onCommit(async (repo) => {
              expect(await repo.correlated(system, 'a')).toBe(true)
              await repo.record('after')
              throw new Error('abort commit')
            })
            return { ...s, count: 1 }
          },
        }),
      ])
      const engine = createEngine({ storage: f.storage, caseTypes: [type] })
      const created = await engine.createCase(type.name, {})
      await expect(
        engine.execute(created.id, 'poison', { actor: null }),
      ).rejects.toThrow('abort commit')
      expect(await engine.case(created.id)).toMatchObject({
        seq: 0,
        endedAt: null,
        state: { count: 0 },
      })
      expect(await engine.correlationOf(system, 'a')).toBeNull()
      expect(await f.records()).toEqual([])
      expect(
        (await engine.journal(created.id)).some((e) => e.entry === 'completed'),
      ).toBe(false)
    })

    it('discards failed attempt effects and preserves mixed registration order on retry', async () => {
      const f = await factory()
      const system = randomUUID()
      const type = define([
        defineStep({
          name: 'retry',
          retry: { maxAttempts: 2, delayMs: 0 },
          handler: async (s, ctx) => {
            const id = String(ctx.attempt)
            ctx.onCommit(async (repo) => {
              await repo.record(`before-${id}`)
            })
            ctx.correlate({ system, externalId: id })
            ctx.onCommit(async (repo) => {
              expect(await repo.correlated(system, id)).toBe(true)
              if (ctx.attempt === 1) throw new Error('retry commit')
              await repo.record(`after-${id}`)
            })
            return { ...s, count: s.count + 1 }
          },
        }),
      ])
      const engine = createEngine({ storage: f.storage, caseTypes: [type] })
      const created = await engine.createCase(type.name, {})
      const result = await engine.execute(created.id, 'retry', { actor: null })
      expect(result).toMatchObject({ attempts: 2, seq: 1, state: { count: 1 } })
      expect(await engine.correlationOf(system, '1')).toBeNull()
      expect(await engine.correlationOf(system, '2')).toMatchObject({
        caseId: created.id,
      })
      expect(await f.records()).toEqual(['before-2', 'after-2'])
      expect((await engine.journal(created.id)).map((e) => e.entry)).toEqual([
        'claimed',
        'attempt-failed',
        'completed',
      ])
    })

    it('routes events, deduplicates concurrent deliveries and reopens transient failures', async () => {
      const f = await factory()
      let fail = true
      const type = define([
        defineStep({
          name: 'receive',
          retry: { maxAttempts: 1 },
          handler: async (s) => {
            if (fail) throw new Error('transient')
            return { ...s, count: s.count + 1 }
          },
        }),
      ])
      const engine = createEngine({ storage: f.storage, caseTypes: [type] })
      const created = await engine.createCase(type.name, {})
      const system = randomUUID()
      const mapping = await engine.correlate({
        caseId: created.id,
        system,
        externalId: 'a',
        step: 'receive',
      })
      expect(
        await engine.correlate({
          caseId: created.id,
          system,
          externalId: 'a',
          step: 'receive',
        }),
      ).toMatchObject({ id: mapping.id, createdAt: mapping.createdAt })
      expect(await engine.correlations(created.id)).toHaveLength(1)
      const event = { system, externalId: 'a', type: 'ready', eventId: '1' }
      expect(await engine.ingest(event)).toMatchObject({
        status: 'dead-lettered',
        reason: 'execution-failed',
      })
      expect(await engine.deadLetters({ system })).toHaveLength(1)
      fail = false
      const outcomes = await Promise.all([
        engine.ingest(event),
        engine.ingest(event),
        engine.ingest(event),
      ])
      expect(outcomes.map((o) => o.status).sort()).toEqual([
        'duplicate',
        'duplicate',
        'executed',
      ])
      expect((await engine.case(created.id)).state).toMatchObject({ count: 1 })
      expect(await engine.deadLetters({ system })).toEqual([])
    })

    it('uses adapter migration pages and preserves completed markers when resuming', async () => {
      const f = await factory()
      const type = define([])
      const engine = createEngine({ storage: f.storage, caseTypes: [type] })
      const cases = await Promise.all([
        engine.createCase(type.name, {}),
        engine.createCase(type.name, {}),
        engine.createCase(type.name, {}),
      ])
      const transform = (s: z.output<typeof State>) => ({
        ...s,
        count: s.count + 1,
      })
      expect(
        await engine.migrate(type.name, 'upgrade', transform, {
          dryRun: true,
          batchSize: 1,
        }),
      ).toMatchObject({ scanned: 3, migrated: 3 })
      expect(
        await engine.migrate(type.name, 'upgrade', transform, {
          limit: 1,
          batchSize: 1,
        }),
      ).toMatchObject({ scanned: 1, migrated: 1 })
      expect(
        await engine.migrate(type.name, 'upgrade', transform, { batchSize: 1 }),
      ).toMatchObject({ scanned: 2, migrated: 2 })
      expect(
        await engine.migrate(type.name, 'upgrade', transform),
      ).toMatchObject({ scanned: 0 })
      for (const c of cases) {
        expect((await engine.case(c.id)).state).toMatchObject({ count: 1 })
        expect(await hasMigrated(f.storage, c.id, 'upgrade')).toBe(true)
      }
    })
  })
}

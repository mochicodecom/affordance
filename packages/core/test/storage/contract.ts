/** The same behavioral contract runs against a non-SQL adapter and Postgres. */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  actor,
  CaseBusyError,
  CaseStateValidationError,
  ClaimLostError,
  caseType,
  commitContext,
  createEngine,
  hasMigrated,
  isClaimedEntry,
  replayGuard,
  SerializationError,
  StepExecutionError,
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
    it('stores complete typed state, claim snapshots, actor and input independently of deltas', async () => {
      const f = await factory()
      const Details = z.object({
        when: z.date(),
        members: z.set(z.string()),
        amount: z.bigint(),
      })
      const TypedState = z
        .object({
          details: Details,
          nullable: z.null(),
          unset: z.undefined().optional(),
        })
        .refine(async (s) => s.details.amount >= 0n)
      type TypedActor = { since: Date; roles: Set<string>; id: bigint }
      const typedStep = stepsOf(
        TypedState,
        actor<TypedActor>(),
        commitContext<TestCommit>(),
      )
      const next = {
        when: new Date(20),
        members: new Set(['c', 'a']),
        amount: 2n,
      }
      const type = caseType({
        name: `typed-${randomUUID()}`,
        state: TypedState,
        steps: [
          typedStep({
            name: 'change',
            input: Details,
            requires: {
              original: (s) =>
                s.details.when.getTime() === 10 && s.details.amount === 1n,
              ordered: (s) => [...s.details.members][0] === 'b',
            },
            permits: {
              editor: (_s, { actor: a }) =>
                a.since.getTime() === 0 && a.roles.has('editor') && a.id === 7n,
            },
            handler: async (s, ctx) => {
              expect(s.details.members).toBeInstanceOf(Set)
              expect(ctx.input).toEqual(next)
              expect(ctx.actor.since).toBeInstanceOf(Date)
              return { ...s, details: Details.parse(ctx.input) }
            },
          }),
        ],
      })
      const engine = createEngine({ storage: f.storage, caseTypes: [type] })
      const initial = {
        details: {
          when: new Date(10),
          members: new Set(['b', 'a']),
          amount: 1n,
        },
        nullable: null,
        unset: undefined,
      }
      const who = { since: new Date(0), roles: new Set(['editor']), id: 7n }
      const created = await engine.createCase(type.name, initial)
      expect((await engine.case(created.id)).state).toStrictEqual(initial)
      const result = await engine.execute(created.id, 'change', {
        actor: who,
        input: next,
      })
      const current = { ...initial, details: next }
      expect(result.state).toStrictEqual(current)
      expect((await engine.case(created.id)).state).toStrictEqual(current)
      expect((await engine.listCases()).cases[0]?.state).toStrictEqual(current)
      const candidates = await f.storage.migrations.candidates(
        type.name,
        'unused',
        {},
        null,
        10,
      )
      expect(candidates.cases[0]?.state).toStrictEqual(current)

      const entries = await engine.journal(created.id)
      const claim = entries.find(isClaimedEntry)!
      const completed = entries.find((entry) => entry.entry === 'completed')!
      expect(claim.state).toStrictEqual(initial)
      expect(claim.actor).toStrictEqual(who)
      expect(claim.input).toStrictEqual(next)
      expect(claim.delta).toBeNull()
      expect(completed.state).toBeNull()
      expect(completed.actor).toStrictEqual(who)
      expect(completed.delta).toEqual(result.delta)
      expect(JSON.parse(JSON.stringify(result.delta))).toEqual([
        { op: 'replace', path: '/json/details/amount', value: '2' },
        { op: 'replace', path: '/json/details/members/1', value: 'c' },
        {
          op: 'replace',
          path: '/json/details/when',
          value: '1970-01-01T00:00:00.020Z',
        },
      ])
      const replay = await replayGuard(type, claim)
      expect(replay.matches).toBe(true)
      expect(replay.reproduced).toEqual(claim.guard)
      const invalid = await replayGuard(type, {
        ...claim,
        state: { details: {} },
      })
      expect(invalid.reproduced).toBeNull()
      expect(invalid.unaddressable?.reason).toMatch(/state schema/)

      await f.corrupt(created.id, { details: { ...next, when: 'invalid' } })
      await expect(engine.case(created.id)).rejects.toThrow(
        CaseStateValidationError,
      )
    })

    it('preserves null and undefined complete snapshots and recorded values', async () => {
      const f = await factory()
      const Any = z.unknown()
      const step = stepsOf(Any, undefined, commitContext<TestCommit>())
      const type = caseType({
        name: `nullable-${randomUUID()}`,
        state: Any,
        steps: [
          step({
            name: 'to-undefined',
            input: Any,
            handler: async () => undefined,
          }),
        ],
      })
      const engine = createEngine({ storage: f.storage, caseTypes: [type] })
      const created = await engine.createCase(type.name, null)
      expect((await engine.case(created.id)).state).toBeNull()
      await engine.execute(created.id, 'to-undefined', {
        actor: undefined,
        input: null,
      })
      expect((await engine.case(created.id)).state).toBeUndefined()
      await engine.execute(created.id, 'to-undefined', { actor: null })
      const claims = (await engine.journal(created.id)).filter(isClaimedEntry)
      expect(claims[0]).toMatchObject({
        state: null,
        actor: undefined,
        input: null,
      })
      expect(claims[1]).toMatchObject({
        state: undefined,
        actor: null,
        input: undefined,
      })
      expect((await replayGuard(type, claims[1]!)).matches).toBe(true)
    })

    it('rejects unsupported values without partial writes or retrying deterministic serialization failures', async () => {
      const f = await factory()
      const Any = z.unknown()
      const step = stepsOf(Any, undefined, commitContext<TestCommit>())
      let runs = 0
      const type = caseType({
        name: `unsupported-${randomUUID()}`,
        state: Any,
        steps: [
          step({
            name: 'bad',
            input: Any,
            handler: async (_s, ctx) => {
              runs += 1
              ctx.onCommit(async (tx) => {
                await tx.record('must not commit')
              })
              return { bad: () => {} }
            },
          }),
        ],
      })
      const engine = createEngine({ storage: f.storage, caseTypes: [type] })
      await expect(
        engine.createCase(type.name, { bad: Symbol('bad') }),
      ).rejects.toThrow(SerializationError)
      expect((await engine.listCases()).cases).toHaveLength(0)
      const created = await engine.createCase(type.name, { ok: true })
      for (const options of [
        { actor: () => {} },
        { actor: null, input: new Map() },
      ]) {
        await expect(
          engine.execute(created.id, 'bad', options),
        ).rejects.toThrow(SerializationError)
        expect(await engine.journal(created.id)).toEqual([])
      }
      expect(runs).toBe(0)
      await expect(
        engine.execute(created.id, 'bad', { actor: null }),
      ).rejects.toThrow(StepExecutionError)
      expect(runs).toBe(1)
      expect((await engine.case(created.id)).state).toEqual({ ok: true })
      expect((await engine.case(created.id)).seq).toBe(0)
      expect(await f.records()).toEqual([])
      expect((await engine.journal(created.id)).map((e) => e.entry)).toEqual([
        'claimed',
        'failed',
      ])
      // A second execution can claim immediately after failure.
      await expect(
        engine.execute(created.id, 'bad', { actor: null }),
      ).rejects.toThrow(StepExecutionError)
      expect(runs).toBe(2)
    })

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

/** Independent in-memory domain adapter; real snapshots, exclusion, rollback and evidence. */
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type {
  CaseTypeDefinition,
  Correlation,
  DeadLetter,
  ExternalEvent,
  JournalEntry,
  JournalEntryInput,
} from '../../src/index.js'
import { CaseNotFoundError } from '../../src/index.js'
import type {
  DeliveryRecord,
  DeliverySettlement,
  EngineStorage,
  StoredCase,
} from '../../src/storage.js'
import {
  boundCase,
  deserializeValue,
  mintId,
  projectEntry,
  serializeValue,
} from '../../src/storage.js'

const copy = <T>(v: T): T => deserializeValue(serializeValue(v)) as T
export const createMemoryStorage = () => {
  let data = {
    cases: new Map<string, StoredCase>(),
    domains: new Map<string, unknown>(),
    journal: [] as JournalEntry[],
    correlations: new Map<string, Correlation>(),
    deliveries: new Map<
      string,
      DeliveryRecord &
        Omit<DeliverySettlement, 'status'> & { event: ExternalEvent }
    >(),
  }
  const factories = new Map<
    string,
    (read: () => unknown, write: (v: unknown) => void) => unknown
  >()
  let tail = Promise.resolve()
  const atomic = async <T>(fn: () => Promise<T>): Promise<T> => {
    const previous = tail
    let release!: () => void
    tail = new Promise<void>((r) => {
      release = r
    })
    await previous
    const before = structuredClone(data)
    try {
      return await fn()
    } catch (e) {
      data = before
      throw e
    } finally {
      release()
    }
  }
  const get = (id: string): StoredCase => {
    const row = data.cases.get(id)
    if (!row) throw new CaseNotFoundError(id)
    if (!data.domains.has(row.reference))
      throw new Error('domain record missing')
    return { ...copy(row), state: copy(data.domains.get(row.reference)) }
  }
  const key = (s: string, id: string) => JSON.stringify([s, id])
  const correlation: EngineStorage['correlations']['register'] = async (r) => {
    const previous = data.correlations.get(key(r.system, r.externalId))
    const value: Correlation = {
      ...r,
      id: previous?.id ?? mintId('correlation'),
      scopeKey: r.scopeKey ?? null,
      step: r.step ?? null,
      metadata: r.metadata ?? null,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
    }
    data.correlations.set(key(r.system, r.externalId), copy(value))
    return copy(value)
  }
  const append = async (input: JournalEntryInput) => {
    const value: JournalEntry = {
      ...copy(projectEntry(input)),
      id: mintId('journal'),
      ordinal: data.journal.length + 1,
      recordedAt: new Date().toISOString(),
    }
    data.journal.push(value)
    return copy(value)
  }
  const storage: EngineStorage = {
    cases: {
      attach: (caseTypeName, reference, validate) =>
        atomic(async () => {
          if (!data.domains.has(reference))
            throw new Error('domain record missing')
          const state = await validate(copy(data.domains.get(reference)))
          const found = [...data.cases.values()].find(
            (c) => c.caseTypeName === caseTypeName && c.reference === reference,
          )
          if (found) return { ...copy(found), state }
          const row: StoredCase = {
            id: mintId('case'),
            reference,
            caseTypeName,
            state: undefined,
            seq: 0,
            endedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }
          data.cases.set(row.id, row)
          return { ...copy(row), state }
        }),
      get: (id) => atomic(async () => get(id)),
      list: (opts) =>
        atomic(async () => {
          const all = [...data.cases.values()]
            .filter(
              (c) =>
                opts.caseTypeNames.includes(c.caseTypeName) &&
                (opts.includeEnded || c.endedAt === null),
            )
            .sort(
              (a, b) =>
                b.createdAt.getTime() - a.createdAt.getTime() ||
                b.id.localeCompare(a.id),
            )
          const filter = JSON.stringify([
            opts.caseTypeNames.slice().sort(),
            opts.includeEnded === true,
          ])
          let after: { time: number; id: string; filter: string } | null = null
          if (opts.cursor) {
            after = JSON.parse(opts.cursor)
            if (after?.filter !== filter) throw new TypeError('changed filters')
          }
          const remaining = all.filter(
            (c) =>
              !after ||
              c.createdAt.getTime() < after.time ||
              (c.createdAt.getTime() === after.time && c.id < after.id),
          )
          const selected = remaining.slice(0, opts.limit)
          const last = selected.at(-1)
          return {
            cases: selected.map((c) => get(c.id)),
            nextCursor:
              remaining.length > opts.limit && last
                ? JSON.stringify({
                    time: last.createdAt.getTime(),
                    id: last.id,
                    filter,
                  })
                : null,
          }
        }),
    },
    execution: {
      withCase: (id, _executionId, run) =>
        atomic(async () => {
          const row = get(id)
          const factory = factories.get(row.caseTypeName)
          if (!factory) throw new Error('missing binding')
          const repos = factory(
            () => copy(data.domains.get(row.reference)),
            (value) => {
              data.domains.set(row.reference, copy(value))
            },
          )
          return run({
            repos,
            loadCase: async () => get(id),
            persistCompletion: async (e) => {
              const metadata = data.cases.get(id)!
              metadata.seq++
              metadata.updatedAt = new Date()
              if (e.dormancy === 'ended') metadata.endedAt = new Date()
              if (e.dormancy === 'reopened') metadata.endedAt = null
              for (const c of e.correlations) await correlation(c)
              const started = await append(e.started)
              const completed = await append(e.completed)
              return {
                seq: metadata.seq,
                endedAt: metadata.endedAt?.toISOString() ?? null,
                startedAt: started.recordedAt,
                committedAt: completed.recordedAt,
              }
            },
          })
        }),
    },
    journal: {
      read: (id, filter = {}) =>
        atomic(async () =>
          structuredClone(
            data.journal
              .filter(
                (e) =>
                  e.caseId === id &&
                  (filter.scopeKey === undefined ||
                    e.scopeKey === filter.scopeKey) &&
                  (filter.step === undefined || e.step === filter.step) &&
                  (filter.executionId === undefined ||
                    e.executionId === filter.executionId) &&
                  (filter.since === undefined || e.ordinal > filter.since) &&
                  (filter.entry === undefined ||
                    (Array.isArray(filter.entry)
                      ? filter.entry.includes(e.entry)
                      : filter.entry === e.entry)),
              )
              .slice(0, filter.limit),
          ),
        ),
    },
    correlations: {
      register: (r) => atomic(() => correlation(r)),
      lookup: (system, id) =>
        atomic(async () =>
          structuredClone(data.correlations.get(key(system, id)) ?? null),
        ),
      list: (id, scope) =>
        atomic(async () =>
          structuredClone(
            [...data.correlations.values()].filter(
              (r) =>
                r.caseId === id &&
                (scope === undefined || r.scopeKey === scope),
            ),
          ),
        ),
    },
    deliveries: {
      acquire: (event, idempotencyKey, reopenable) =>
        atomic(async () => {
          const previous = data.deliveries.get(idempotencyKey)
          if (
            previous &&
            !(
              previous.status === 'dead-lettered' &&
              previous.reason &&
              reopenable.includes(previous.reason)
            )
          )
            return { row: structuredClone(previous), fresh: false }
          // Internal pending representation is widened below; settlement only accepts terminal states.
          const row = {
            id: previous?.id ?? mintId('event'),
            system: event.system,
            externalId: event.externalId,
            idempotencyKey,
            status: 'pending' as const,
            reason: null,
            receivedAt: new Date().toISOString(),
            event,
          }
          data.deliveries.set(idempotencyKey, structuredClone(row))
          return { row, fresh: true }
        }),
      settle: (id, fields) =>
        atomic(async () => {
          const row = [...data.deliveries.values()].find((r) => r.id === id)
          if (!row) throw new Error('Unknown delivery')
          Object.assign(row, fields)
        }),
      deadLetters: (filter = {}) =>
        atomic(async () =>
          [...data.deliveries.values()]
            .filter(
              (r) =>
                r.status === 'dead-lettered' &&
                (filter.system === undefined || r.system === filter.system) &&
                (filter.caseId === undefined || r.caseId === filter.caseId) &&
                (filter.reason === undefined || r.reason === filter.reason),
            )
            .reverse()
            .slice(0, filter.limit)
            .map(
              (r): DeadLetter => ({
                id: r.id,
                system: r.system,
                externalId: r.externalId,
                type: r.event.type,
                idempotencyKey: r.idempotencyKey,
                caseId: r.caseId ?? null,
                scopeKey: r.scopeKey ?? null,
                step: r.step ?? null,
                reason: r.reason!,
                detail: r.detail ?? null,
                event: structuredClone(r.event),
                receivedAt: r.receivedAt,
              }),
            ),
        ),
    },
  }
  return {
    storage,
    bindCase<S extends StandardSchemaV1, A, R>(
      definition: CaseTypeDefinition<S, A, R>,
      factory: (
        read: () => StandardSchemaV1.InferOutput<S>,
        write: (value: StandardSchemaV1.InferOutput<S>) => void,
      ) => NoInfer<R>,
    ) {
      factories.set(
        definition.name,
        factory as (
          read: () => unknown,
          write: (v: unknown) => void,
        ) => unknown,
      )
      return boundCase(definition, storage)
    },
    seed: async (reference: string, state: unknown) =>
      atomic(async () => {
        data.domains.set(reference, copy(state))
      }),
    domain: async (reference: string) =>
      atomic(async () => copy(data.domains.get(reference))),
  }
}

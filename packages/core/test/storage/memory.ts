/** A test adapter with real rollback, serialization and repository commit effects.
 * Its maps never escape; reads return copies. No SQL-shaped test doubles.
 */

import type {
  Correlation,
  DeadLetter,
  ExternalEvent,
  JournalEntry,
} from '../../src/index.js'
import { CaseNotFoundError } from '../../src/index.js'
import type {
  DeliveryRecord,
  DeliverySettlement,
  EngineStorage,
  HeldClaim,
  StoredCase,
} from '../../src/storage.js'
import {
  deserializeValue,
  mintId,
  projectEntry,
  serializeValue,
} from '../../src/storage.js'
import type { AdapterFixture, TestCommit } from './contract.js'

const recordedCopy = (value: unknown): unknown =>
  deserializeValue(JSON.parse(JSON.stringify(serializeValue(value))))

export const memoryAdapter = (): AdapterFixture => {
  let data = {
    cases: new Map<string, StoredCase>(),
    claims: new Map<
      string,
      { -readonly [K in keyof Omit<HeldClaim, 'expired'>]: HeldClaim[K] }
    >(),
    journal: [] as JournalEntry[],
    correlations: new Map<string, Correlation>(),
    deliveries: new Map<
      string,
      DeliveryRecord &
        Omit<DeliverySettlement, 'status'> & { event: ExternalEvent }
    >(),
    records: [] as string[],
  }
  // Serialize atomic operations (handlers run outside this queue).
  let tail = Promise.resolve()
  const atomic = async <T>(fn: () => Promise<T>): Promise<T> => {
    const previous = tail
    let release!: () => void
    tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    const before = structuredClone(data)
    try {
      return await fn()
    } catch (error) {
      data = before
      throw error
    } finally {
      release()
    }
  }
  const get = (id: string) => {
    const row = data.cases.get(id)
    if (row === undefined) throw new CaseNotFoundError(id)
    return structuredClone(row)
  }
  const key = (system: string, externalId: string) =>
    JSON.stringify([system, externalId])
  const correlation: EngineStorage<TestCommit>['correlations']['register'] =
    async (r) => {
      const address = key(r.system, r.externalId)
      const previous = data.correlations.get(address)
      const stored: Correlation = {
        id: previous?.id ?? mintId('correlation'),
        system: r.system,
        externalId: r.externalId,
        caseId: r.caseId,
        scopeKey: r.scopeKey ?? null,
        step: r.step ?? null,
        metadata: r.metadata ?? null,
        createdAt: previous?.createdAt ?? new Date().toISOString(),
      }
      data.correlations.set(address, structuredClone(stored))
      return structuredClone(stored)
    }
  const append: EngineStorage<TestCommit>['execution']['appendEntry'] = async (
    input,
  ) => {
    const projected = projectEntry(input)
    const entry: JournalEntry = {
      ...projected,
      actor: recordedCopy(projected.actor),
      input: recordedCopy(projected.input),
      state: recordedCopy(projected.state),
      id: mintId('journal'),
      ordinal: data.journal.length + 1,
      recordedAt: new Date().toISOString(),
    }
    data.journal.push(structuredClone(entry))
    return entry
  }
  const context: TestCommit = {
    record: async (message) => {
      data.records.push(message)
    },
    correlated: async (system, externalId) =>
      data.correlations.has(key(system, externalId)),
  }
  const storage: EngineStorage<TestCommit> = {
    cases: {
      create: (caseTypeName, state) =>
        atomic(async () => {
          const row: StoredCase = {
            id: mintId('case'),
            caseTypeName,
            state: recordedCopy(state),
            seq: 0,
            endedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }
          data.cases.set(row.id, row)
          return structuredClone(row)
        }),
      get: (id) => atomic(async () => get(id)),
      list: (options) =>
        atomic(async () => {
          const all = [...data.cases.values()]
            .filter(
              (c) =>
                options.caseTypeNames.includes(c.caseTypeName) &&
                (options.includeEnded || c.endedAt === null),
            )
            .sort(
              (a, b) =>
                b.createdAt.getTime() - a.createdAt.getTime() ||
                (a.id < b.id ? 1 : -1),
            )
          const after =
            options.cursor === undefined
              ? null
              : (JSON.parse(options.cursor) as { time: number; id: string })
          const rows = all.filter(
            (c) =>
              after === null ||
              c.createdAt.getTime() < after.time ||
              (c.createdAt.getTime() === after.time && c.id < after.id),
          )
          const selected = rows.slice(0, options.limit)
          const last = selected.at(-1)
          return {
            cases: structuredClone(selected),
            nextCursor:
              rows.length > options.limit && last
                ? JSON.stringify({
                    time: last.createdAt.getTime(),
                    id: last.id,
                  })
                : null,
          }
        }),
    },
    execution: {
      withCase: (id, fn) =>
        atomic(async () => {
          get(id)
          return fn({
            loadCase: async () => get(id),
            currentClaim: async () => {
              const claim = data.claims.get(id)
              return claim
                ? {
                    ...claim,
                    expired: Date.parse(claim.expiresAt) <= Date.now(),
                  }
                : null
            },
            insertClaim: async (executionId, step, scopeKey, ttl) => {
              data.claims.set(id, {
                executionId,
                step,
                scopeKey,
                attempt: 1,
                expiresAt: new Date(Date.now() + ttl).toISOString(),
              })
              return { claimedAt: new Date().toISOString() }
            },
            deleteClaim: async (executionId) => {
              if (data.claims.get(id)?.executionId === executionId)
                data.claims.delete(id)
            },
            appendEntry: append,
            updateCaseState: async (state, dormancy) => {
              const row = get(id)
              row.state = recordedCopy(state)
              row.seq += 1
              row.updatedAt = new Date()
              if (dormancy === 'ended') row.endedAt = new Date()
              if (dormancy === 'reopened') row.endedAt = null
              data.cases.set(id, row)
              return {
                seq: row.seq,
                endedAt: row.endedAt?.toISOString() ?? null,
              }
            },
            applyEffects: async (effects) => {
              for (const effect of effects) {
                if (effect.kind === 'write') await effect.write(context)
                else await correlation(effect.registration)
              }
            },
          })
        }),
      appendEntry: (input) => atomic(() => append(input)),
      heartbeat: (id, executionId, ttl) =>
        atomic(async () => {
          const claim = data.claims.get(id)
          if (claim?.executionId === executionId)
            claim.expiresAt = new Date(Date.now() + ttl).toISOString()
        }),
      bumpAttempt: (id, executionId, attempt) =>
        atomic(async () => {
          const claim = data.claims.get(id)
          if (claim?.executionId === executionId) claim.attempt = attempt
        }),
      releaseClaim: (id, executionId) =>
        atomic(async () => {
          if (data.claims.get(id)?.executionId === executionId)
            data.claims.delete(id)
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
    migrations: {
      candidates: (type, marker, options, cursor, limit) =>
        atomic(async () => {
          const all = [...data.cases.values()]
            .filter(
              (c) =>
                c.caseTypeName === type &&
                (options.includeEnded || c.endedAt === null) &&
                (options.caseIds === undefined ||
                  options.caseIds.includes(c.id)) &&
                (cursor === null || c.id > cursor) &&
                !data.journal.some(
                  (e) =>
                    e.caseId === c.id &&
                    e.step === marker &&
                    e.entry === 'completed',
                ),
            )
            .sort((a, b) => (a.id < b.id ? -1 : 1))
          const cases = all
            .slice(0, limit)
            .map((c) => ({ id: c.id, state: structuredClone(c.state) }))
          return {
            cases,
            nextCursor: all.length > limit ? (cases.at(-1)?.id ?? null) : null,
          }
        }),
      hasCompleted: (id, marker) =>
        atomic(async () =>
          data.journal.some(
            (e) =>
              e.caseId === id && e.step === marker && e.entry === 'completed',
          ),
        ),
    },
  }
  return {
    storage,
    records: async () => [...data.records],
    corrupt: async (id, state) => {
      data.cases.set(id, { ...get(id), state })
    },
    expire: async (id) => {
      const claim = data.claims.get(id)
      if (claim) claim.expiresAt = new Date(0).toISOString()
    },
  }
}

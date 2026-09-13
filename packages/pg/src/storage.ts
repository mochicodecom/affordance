import type {
  CaseBinding,
  CaseTypeDefinition,
  EngineStorage,
  StoredCase,
} from '@affordance/core'
import { ExecutionIndeterminateError, foldExecutions } from '@affordance/core'
import { boundCase, validateAgainstSchema } from '@affordance/core/storage'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import {
  correlationsFor,
  lookupCorrelation,
  registerCorrelation,
} from './correlation.js'
import { claimDelivery, readDeadLetters, settle } from './delivery.js'
import { appendEntry, readJournal } from './journal.js'
import { listCases } from './listing.js'
import type { DatabaseAccess, Queryable, Transaction } from './queryable.js'
import { queryableOf } from './queryable.js'
import {
  advanceCase,
  attachMetadata,
  type CaseRow,
  selectMetadata,
  toHandle,
} from './store.js'
import { CommitOutcomeUnknownError, withTransaction } from './transaction.js'

/** All loads must be deterministic. protect must cover child writes too;
 * every external writer must use the same domain concurrency protocol. */
export interface PgDomainBinding<S, R> {
  load(q: Queryable, reference: string): Promise<S>
  protect(tx: Transaction, reference: string): Promise<void>
  repositories(tx: Transaction, reference: string): R
}
export interface PgStorage extends EngineStorage {
  /** Join an application-owned transaction when creating a domain record. */
  attachCase(
    tx: Transaction,
    binding: CaseBinding,
    reference: string,
  ): Promise<StoredCase>
  bindCase<S extends StandardSchemaV1, A, R>(
    definition: CaseTypeDefinition<S, A, R>,
    binding: PgDomainBinding<StandardSchemaV1.InferOutput<S>, NoInfer<R>>,
  ): CaseBinding
  /** Fence against a still-running transaction before declaring non-commit.
   * Failure to reach the database still throws; it is not evidence of rollback. */
  reconcileExecution(
    caseId: string,
    executionId: string,
  ): Promise<'completed' | 'not-committed'>
}
export interface PgStorageOptions {
  readonly db: DatabaseAccess
}
export const createPgStorage = ({ db }: PgStorageOptions): PgStorage => {
  const q = queryableOf(db)
  const bindings = new Map<string, PgDomainBinding<unknown, unknown>>()
  const bindingFor = (name: string) => {
    const binding = bindings.get(name)
    if (!binding)
      throw new TypeError(`no domain binding for case type '${name}'`)
    return binding
  }
  const hydrate = async (tx: Queryable, row: CaseRow): Promise<StoredCase> =>
    toHandle(row, await bindingFor(row.case_type).load(tx, row.reference))
  const read = <T>(fn: (tx: Transaction) => Promise<T>) =>
    withTransaction(db, async (tx) => {
      await tx.query(
        'set transaction isolation level repeatable read, read only',
      )
      return fn(tx)
    })
  const attach = async (
    tx: Transaction,
    name: string,
    reference: string,
    validate: (state: unknown) => Promise<unknown>,
  ) => {
    if (typeof reference !== 'string' || reference.length === 0)
      throw new TypeError('reference must be a non-empty string')
    const binding = bindingFor(name)
    const row = await attachMetadata(tx, name, reference)
    await binding.protect(tx, reference)
    return toHandle(row, await validate(await binding.load(tx, reference)))
  }
  const registered = new Set<CaseBinding>()
  const storage: PgStorage = {
    attachCase: (tx, binding, reference) => {
      if (!registered.has(binding))
        throw new TypeError('case binding belongs to a different adapter')
      return attach(tx, binding.definition.name, reference, (state) =>
        validateAgainstSchema(binding.definition.state, state, 'domain state'),
      )
    },
    bindCase: (definition, binding) => {
      if (bindings.has(definition.name))
        throw new TypeError(`duplicate domain binding '${definition.name}'`)
      bindings.set(definition.name, binding)
      const result = boundCase(definition, storage)
      registered.add(result)
      return result
    },
    cases: {
      attach: (name, reference, validate) =>
        withTransaction(db, (tx) => attach(tx, name, reference, validate)),
      get: (id) =>
        read(async (tx) => hydrate(tx, await selectMetadata(tx, id))),
      list: (options) =>
        read((tx) => listCases(tx, options, (row) => hydrate(tx, row))),
    },
    execution: {
      withCase: async (id, executionId, run) => {
        try {
          return await withTransaction(db, async (tx) => {
            const row = await selectMetadata(tx, id, true)
            const binding = bindingFor(row.case_type)
            await binding.protect(tx, row.reference)
            let active = true
            let completed = false
            const requireActive = () => {
              if (!active) throw new Error('case session is closed')
            }
            try {
              const result = await run({
                repos: binding.repositories(tx, row.reference),
                loadCase: () => {
                  requireActive()
                  return hydrate(tx, row)
                },
                persistCompletion: async (evidence) => {
                  requireActive()
                  if (
                    completed ||
                    evidence.started.executionId !== executionId ||
                    evidence.completed.executionId !== executionId ||
                    evidence.started.caseId !== id ||
                    evidence.completed.caseId !== id
                  )
                    throw new Error(
                      'invalid completion identity or repeated completion',
                    )
                  completed = true
                  const updated = await advanceCase(tx, id, evidence.dormancy)
                  for (const registration of evidence.correlations)
                    await registerCorrelation(tx, registration)
                  const started = await appendEntry(tx, evidence.started)
                  const finished = await appendEntry(tx, evidence.completed)
                  return {
                    seq: Number(updated.seq),
                    endedAt: updated.ended_at?.toISOString() ?? null,
                    startedAt: started.recordedAt,
                    committedAt: finished.recordedAt,
                  }
                },
              })
              if (!completed)
                throw new Error('case operation omitted completion evidence')
              return result
            } finally {
              active = false
            }
          })
        } catch (cause) {
          if (cause instanceof CommitOutcomeUnknownError)
            throw new ExecutionIndeterminateError(id, executionId, { cause })
          throw cause
        }
      },
    },
    reconcileExecution: (id, executionId) =>
      withTransaction(db, async (tx) => {
        await selectMetadata(tx, id, true)
        const entries = await readJournal(tx, id, { executionId })
        return foldExecutions(entries).some((e) => e.status === 'completed')
          ? 'completed'
          : 'not-committed'
      }),
    journal: { read: (id, filter) => readJournal(q, id, filter) },
    correlations: {
      register: (r) => registerCorrelation(q, r),
      lookup: (s, id) => lookupCorrelation(q, s, id),
      list: (id, scope) => correlationsFor(q, id, scope),
    },
    deliveries: {
      acquire: (event, key, reopenable) =>
        claimDelivery(q, event, key, reopenable),
      settle: (id, outcome) => settle(q, id, outcome),
      deadLetters: (filter) => readDeadLetters(q, filter),
    },
  }
  return storage
}

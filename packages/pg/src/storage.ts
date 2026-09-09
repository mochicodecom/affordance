import type { EngineStorage } from '@affordance/core'
import {
  correlationsFor,
  lookupCorrelation,
  registerCorrelation,
} from './correlation.js'
import { claimDelivery, readDeadLetters, settle } from './delivery.js'
import { pgLifecyclePort } from './execution.js'
import { readJournal } from './journal.js'
import { listCases } from './listing.js'
import { findCandidates, hasCompleted } from './migration.js'
import type { DatabaseAccess, Transaction } from './queryable.js'
import { queryableOf } from './queryable.js'
import { insertStoredCase, selectCaseUntyped } from './store.js'

export interface PgStorageOptions<TCommit> {
  readonly db: DatabaseAccess
  /** Bind application repositories to the framework's open commit transaction. */
  readonly commitContext: (tx: Transaction) => TCommit
}

export function createPgStorage<TCommit>(
  options: PgStorageOptions<TCommit>,
): EngineStorage<TCommit>
export function createPgStorage(options: {
  readonly db: DatabaseAccess
  readonly commitContext?: undefined
}): EngineStorage<Transaction>
export function createPgStorage<TCommit>(options: {
  readonly db: DatabaseAccess
  readonly commitContext?: (tx: Transaction) => TCommit
}) {
  return options.commitContext === undefined
    ? bindStorage(options.db, (tx: Transaction) => tx)
    : bindStorage(options.db, options.commitContext)
}

const bindStorage = <TCommit>(
  db: DatabaseAccess,
  context: (tx: Transaction) => TCommit,
): EngineStorage<TCommit> => {
  const q = queryableOf(db)
  return {
    cases: {
      create: (type, state) => insertStoredCase(q, type, state),
      get: (id) => selectCaseUntyped(q, id),
      list: (options) => listCases(q, options),
    },
    execution: pgLifecyclePort(db, context),
    journal: { read: (id, filter) => readJournal(q, id, filter) },
    correlations: {
      register: (registration) => registerCorrelation(q, registration),
      lookup: (system, externalId) => lookupCorrelation(q, system, externalId),
      list: (id, scope) => correlationsFor(q, id, scope),
    },
    deliveries: {
      acquire: (event, key, reopenable) =>
        claimDelivery(q, event, key, reopenable),
      settle: (id, outcome) => settle(q, id, outcome),
      deadLetters: (filter) => readDeadLetters(q, filter),
    },
    migrations: {
      candidates: (type, marker, options, cursor, limit) =>
        findCandidates(q, type, marker, options, cursor, limit),
      hasCompleted: (id, marker) => hasCompleted(q, id, marker),
    },
  }
}

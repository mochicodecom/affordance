/**
 * Public interface for storage adapters. Every member belongs to one coordinated store.
 * Methods exchange runtime values. Adapters encode complete case state and journal
 * actor/input/claimed state with serializeValue, and decode with deserializeValue
 * on every read, including transactional loads, listings and migration candidates.
 * Core validates decoded state against the case type's schema. Deltas are already
 * JSON-safe evidence and are stored verbatim, separately from complete state.
 * Migration pages isolate row decoding failures as MigrationCandidate.error;
 * other reads and storage-wide failures throw.
 */
import type { JournalEntry, JournalFilter } from './execution/journal.js'
import type { LifecyclePort } from './execution/port.js'
import type {
  Correlation,
  CorrelationRegistration,
} from './ingestion/correlation.js'
import type {
  DeadLetter,
  DeadLetterFilter,
  DeadLetterReason,
  ExternalEvent,
} from './ingestion/ingest.js'
import type { MigrationOptions } from './migration/migrate.js'
import type { SerializationError } from './serialization.js'
import type { StoredCase } from './store/store.js'

export interface CaseListOptions {
  readonly caseTypeName?: string
  /** Active cases by default. */
  readonly includeEnded?: boolean
  /** Default 100; integer between 1 and 1000. */
  readonly limit?: number
  /** Opaque continuation returned by this adapter for the same filters. */
  readonly cursor?: string
}

export interface CasePage {
  readonly cases: readonly StoredCase[]
  readonly nextCursor: string | null
}

export interface CaseRepository {
  /** State is already schema-validated by core. */
  create(caseTypeName: string, state: unknown): Promise<StoredCase>
  /** Throws CaseNotFoundError for an unknown id; state is unvalidated. */
  get(caseId: string): Promise<StoredCase>
  /** Newest first, with a stable tie breaker. No duplicate records across pages. */
  list(
    options: CaseListOptions & {
      readonly caseTypeNames: readonly string[]
      readonly limit: number
    },
  ): Promise<CasePage>
}

export interface CorrelationRepository {
  /** Register or replace by (system, externalId), preserving id and createdAt. */
  register(registration: CorrelationRegistration): Promise<Correlation>
  lookup(system: string, externalId: string): Promise<Correlation | null>
  list(caseId: string, scopeKey?: string): Promise<readonly Correlation[]>
}

export interface DeliveryRecord {
  readonly id: string
  readonly system: string
  readonly externalId: string
  readonly idempotencyKey: string
  readonly status: 'pending' | 'executed' | 'dead-lettered'
  readonly reason: DeadLetterReason | null
  readonly receivedAt: string
}

export interface DeliverySettlement {
  readonly status: 'executed' | 'dead-lettered'
  readonly caseId?: string | null
  readonly scopeKey?: string | null
  readonly step?: string | null
  readonly reason?: DeadLetterReason | null
  readonly detail?: string | null
  readonly executionId?: string | null
}

export interface DeliveryRepository {
  /** Exactly one concurrent caller acquires a new or eligible dead-lettered delivery. */
  acquire(
    event: ExternalEvent,
    key: string,
    reopenable: readonly DeadLetterReason[],
  ): Promise<{ row: DeliveryRecord; fresh: boolean }>
  /** Delivery bookkeeping is separate from the case execution's atomic commit. */
  settle(id: string, outcome: DeliverySettlement): Promise<void>
  deadLetters(filter?: DeadLetterFilter): Promise<readonly DeadLetter[]>
}

/** A decoded candidate, or a failure isolated to that row. Storage outages still throw. */
export type MigrationCandidate =
  | { readonly id: string; readonly state: unknown; readonly error?: never }
  | {
      readonly id: string
      readonly state?: never
      readonly error: SerializationError
    }

export interface MigrationPage {
  readonly cases: readonly MigrationCandidate[]
  readonly nextCursor: string | null
}

export interface MigrationRepository {
  /** Excludes cases with a completed marker; pagination order is adapter-owned. */
  candidates(
    caseTypeName: string,
    marker: string,
    options: MigrationOptions,
    cursor: string | null,
    limit: number,
  ): Promise<MigrationPage>
  hasCompleted(caseId: string, marker: string): Promise<boolean>
}

export interface EngineStorage<TCommit = unknown> {
  readonly cases: CaseRepository
  readonly execution: LifecyclePort<TCommit>
  readonly journal: {
    read(
      caseId: string,
      filter?: JournalFilter,
    ): Promise<readonly JournalEntry[]>
  }
  readonly correlations: CorrelationRepository
  readonly deliveries: DeliveryRepository
  readonly migrations: MigrationRepository
}

export { projectEntry } from './execution/journal.js'
export type { HeldClaim, LifecyclePort, LifecycleTx } from './execution/port.js'
export type { CommitEffect } from './model/handler.js'
export type { JsonObject, JsonValue, SerializedValue } from './serialization.js'
export {
  deserializeValue,
  SerializationError,
  serializeValue,
} from './serialization.js'
export { mintId } from './store/ids.js'
export type { StoredCase } from './store/store.js'
export { validateAgainstSchema } from './store/store.js'

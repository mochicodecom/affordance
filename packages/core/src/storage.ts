import type { StandardSchemaV1 } from '@standard-schema/spec'
import type {
  JournalEntry,
  JournalFilter,
  ObservedEntryInput,
} from './execution/journal.js'
import type { LaunchPort } from './execution/launch-port.js'
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
import type { AnyCaseType, CaseTypeDefinition } from './model/casetype.js'
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
  /** Attach under domain protection; validate before committing metadata. */
  attach(
    caseTypeName: string,
    reference: string,
    validate: (state: unknown) => Promise<unknown>,
  ): Promise<StoredCase>
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
  /** Delivery bookkeeping is separate from handler effects and evidence. */
  settle(id: string, outcome: DeliverySettlement): Promise<void>
  deadLetters(filter?: DeadLetterFilter): Promise<readonly DeadLetter[]>
}

export interface EngineStorage {
  readonly cases: CaseRepository
  readonly launches?: LaunchPort
  readonly journal: {
    /** Idempotent by executionId. Independent from domain commits and lease status.
     * Core bounds its wait including acquisition; an in-flight write may finish late. */
    observe(entry: ObservedEntryInput): Promise<void>
    read(
      caseId: string,
      filter?: JournalFilter,
    ): Promise<readonly JournalEntry[]>
  }
  readonly correlations: CorrelationRepository
  readonly deliveries: DeliveryRepository
}

export { projectEntry } from './execution/journal.js'
export type { JsonObject, JsonValue, SerializedValue } from './serialization.js'
export {
  deserializeValue,
  SerializationError,
  serializeValue,
} from './serialization.js'
export { mintId } from './store/ids.js'
export type { StoredCase } from './store/store.js'
export { validateAgainstSchema } from './store/store.js'

/** Definitions are bound to one coordinated adapter before engine construction. */
export interface CaseBinding {
  readonly definition: AnyCaseType
  readonly storage: EngineStorage
}
/** Adapter helper: erase definitions only after their typed read binding was checked. */
export const boundCase = <S extends StandardSchemaV1, A>(
  definition: CaseTypeDefinition<S, A>,
  storage: EngineStorage,
): CaseBinding => ({
  definition: definition as unknown as AnyCaseType,
  storage,
})

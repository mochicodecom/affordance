/**
 * The two integration primitives that live in core.
 *
 * - **Correlation** — external identifier ↔ (case, scope element). Written
 *   by the handler that initiates the external interaction.
 * - **Ingestion** — `ingest(event)`: dedup, correlate, then an ordinary
 *   Execution with the external system as the actor (materialize-on-event).
 *
 * Deliberately absent, permanently: connectors. Nothing in this module knows
 * what a DocuSign webhook looks like, and nothing in it ever will — the app
 * owns payload shapes, the framework owns routing and exactly-once.
 */

export type { Correlation, CorrelationRegistration } from './correlation.js'
export {
  correlationsFor,
  lookupCorrelation,
  registerCorrelation,
} from './correlation.js'
export type {
  DeadLetter,
  DeadLetterFilter,
  DeadLetterReason,
  ExternalActor,
  ExternalEvent,
  IngestionEnvironment,
  IngestionOptions,
  IngestionResult,
  IngestionSettings,
  IngestionStatus,
} from './ingest.js'
export {
  classifyDeadLetter,
  externalActor,
  idempotencyKeyFor,
  ingest,
  normalizeIngestion,
  REOPENS_ON_REDELIVERY,
  readDeadLetters,
  routedStep,
} from './ingest.js'

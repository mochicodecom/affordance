import type { CorrelationRequest } from '../model/handler.js'

/**
 * A handler's {@link CorrelationRequest} with the case made explicit — what
 * the registry actually stores. `step` is the step an event on this
 * identifier should execute when the event does not name one itself:
 * typically the materializing step, "record what the provider said".
 */
export interface CorrelationRegistration extends CorrelationRequest {
  /** The case the answer belongs to. */
  readonly caseId: string
}

/** A registered correlation as stored. */
export interface Correlation {
  readonly id: string
  readonly system: string
  readonly externalId: string
  readonly caseId: string
  readonly scopeKey: string | null
  readonly step: string | null
  readonly metadata: unknown
  readonly createdAt: string
}

/**
 * Correlation: the mapping from an external identifier to a case (and a
 * scope element within it) — CONTEXT.md.
 *
 * An e-sign provider knows envelope `env_9f2`; it does not know case
 * `4b0e…` or that the envelope is buyer #7's agreement. Something has
 * to hold that mapping, and it has to be the framework, because it is the
 * framework that has to route the resulting webhook to a step. This is that
 * something — one of exactly two integration primitives in core (the other
 * is {@link ingest}). There are no service-specific connectors here, and
 * there never will be: DocuSign's payload shape is the app's business.
 *
 * The registration is written by the handler that *initiates* the external
 * interaction, in the same commit that records having initiated it —
 * `ctx.correlate(...)` rides the commit seam, so a case can never be
 * left having sent an envelope it cannot route the answer for.
 */

import type { CorrelationRequest } from '../model/handler.js'
import type { Queryable } from '../store/index.js'
import { FRAMEWORK_SCHEMA, mintId } from '../store/index.js'

const CORRELATIONS = `${FRAMEWORK_SCHEMA}.correlations`

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

type CorrelationRow = {
  id: string
  system: string
  external_id: string
  case_id: string
  scope_key: string | null
  step: string | null
  metadata: unknown
  created_at: Date
}

const toCorrelation = (row: CorrelationRow): Correlation => ({
  id: row.id,
  system: row.system,
  externalId: row.external_id,
  caseId: row.case_id,
  scopeKey: row.scope_key,
  step: row.step,
  metadata: row.metadata,
  createdAt: row.created_at.toISOString(),
})

/**
 * Register (or re-register) an external identifier against a case.
 *
 * Upserts on `(system, externalId)` — insert, or update the row already
 * there: a retried handler attempt registering the same envelope again is
 * not an error, it is the same fact. Pass any
 * {@link Queryable} — from a handler this is the commit transaction, via
 * `ctx.correlate` or `ctx.onCommit`.
 */
export const registerCorrelation = async (
  db: Queryable,
  registration: CorrelationRegistration,
): Promise<Correlation> => {
  const { rows } = await db.query<CorrelationRow>(
    `insert into ${CORRELATIONS} (id, system, external_id, case_id, scope_key, step, metadata)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)
     on conflict (system, external_id) do update
       set case_id = excluded.case_id,
           scope_key = excluded.scope_key,
           step = excluded.step,
           metadata = excluded.metadata
     returning id, system, external_id, case_id, scope_key, step, metadata, created_at`,
    [
      mintId('correlation'),
      registration.system,
      registration.externalId,
      registration.caseId,
      registration.scopeKey ?? null,
      registration.step ?? null,
      registration.metadata === undefined
        ? null
        : JSON.stringify(registration.metadata),
    ],
  )
  const row = rows[0]
  if (!row) throw new Error(`insert into ${CORRELATIONS} returned no row`)
  return toCorrelation(row)
}

/** Look up where an external identifier routes; `null` when nothing has claimed it. */
export const lookupCorrelation = async (
  db: Queryable,
  system: string,
  externalId: string,
): Promise<Correlation | null> => {
  const { rows } = await db.query<CorrelationRow>(
    `select id, system, external_id, case_id, scope_key, step, metadata, created_at
     from ${CORRELATIONS} where system = $1 and external_id = $2`,
    [system, externalId],
  )
  const row = rows[0]
  return row === undefined ? null : toCorrelation(row)
}

/** Every identifier registered against a case — the "what is this case waiting on" view. */
export const correlationsFor = async (
  db: Queryable,
  caseId: string,
  scopeKey?: string,
): Promise<readonly Correlation[]> => {
  const { rows } = await db.query<CorrelationRow>(
    `select id, system, external_id, case_id, scope_key, step, metadata, created_at
     from ${CORRELATIONS}
     where case_id = $1 ${scopeKey === undefined ? '' : 'and scope_key = $2'}
     order by created_at asc`,
    scopeKey === undefined ? [caseId] : [caseId, scopeKey],
  )
  return rows.map(toCorrelation)
}

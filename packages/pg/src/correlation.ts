import type { Correlation, CorrelationRegistration } from '@affordance/core'
import { mintId } from '@affordance/core/storage'
import { FRAMEWORK_SCHEMA } from './bootstrap.js'
import type { Queryable } from './queryable.js'

const CORRELATIONS = `${FRAMEWORK_SCHEMA}.correlations`

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

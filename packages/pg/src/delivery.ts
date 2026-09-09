import type {
  DeadLetter,
  DeadLetterFilter,
  DeadLetterReason,
  ExternalEvent,
} from '@affordance/core'
import type { DeliveryRecord } from '@affordance/core/storage'
import { mintId } from '@affordance/core/storage'
import { FRAMEWORK_SCHEMA } from './bootstrap.js'
import type { Queryable } from './queryable.js'
import { sqlWhere } from './sql.js'

const EVENTS = `${FRAMEWORK_SCHEMA}.ingested_events`
type EventRow = {
  id: string
  system: string
  external_id: string
  type: string
  idempotency_key: string
  case_id: string | null
  scope_key: string | null
  step: string | null
  status: string
  reason: string | null
  detail: string | null
  execution_id: string | null
  event: ExternalEvent
  received_at: Date
}

/**
 * The dedup gate. Inserts the event's row and reports whether this delivery
 * is the one that got it.
 *
 * `on conflict do nothing` is the whole mechanism: exactly one of N
 * concurrent deliveries inserts, and the losers read what the winner wrote.
 * A previous delivery that ended `dead-lettered` for a *transient* reason is
 * reopened rather than deduplicated — a provider retry after "the case was
 * busy" should get its chance, which is precisely what provider retries are
 * for.
 */
export const claimDelivery = async (
  db: Queryable,
  event: ExternalEvent,
  idempotencyKey: string,
  reopenable: readonly DeadLetterReason[],
): Promise<{ row: DeliveryRecord; fresh: boolean }> => {
  const inserted = await db.query<EventRow>(
    `insert into ${EVENTS} (id, system, external_id, type, idempotency_key, status, event)
     values ($1, $2, $3, $4, $5, 'pending', $6::jsonb)
     on conflict (idempotency_key) do nothing
     returning *`,
    [
      mintId('event'),
      event.system,
      event.externalId,
      event.type,
      idempotencyKey,
      JSON.stringify(event),
    ],
  )
  const row = inserted.rows[0]
  if (row) return { row: toDelivery(row), fresh: true }

  const retried = await db.query<EventRow>(
    `update ${EVENTS}
     set status = 'pending', reason = null, detail = null, received_at = now(), event = $2::jsonb
     where idempotency_key = $1 and status = 'dead-lettered' and reason = any($3)
     returning *`,
    [idempotencyKey, JSON.stringify(event), reopenable],
  )
  const reopened = retried.rows[0]
  if (reopened) return { row: toDelivery(reopened), fresh: true }

  const existing = await db.query<EventRow>(
    `select * from ${EVENTS} where idempotency_key = $1`,
    [idempotencyKey],
  )
  const previous = existing.rows[0]
  if (!previous)
    throw new Error(
      `${EVENTS}: delivery neither inserted nor found — key ${idempotencyKey}`,
    )
  return { row: toDelivery(previous), fresh: false }
}

/** Record how a delivery ended. The row is the dead-letter surface, so this is the only settle path. */
export const settle = async (
  db: Queryable,
  id: string,
  fields: {
    status: 'executed' | 'dead-lettered'
    caseId?: string | null
    scopeKey?: string | null
    step?: string | null
    reason?: DeadLetterReason | null
    detail?: string | null
    executionId?: string | null
  },
): Promise<void> => {
  await db.query(
    `update ${EVENTS}
     set status = $2, case_id = $3, scope_key = $4, step = $5, reason = $6, detail = $7, execution_id = $8
     where id = $1`,
    [
      id,
      fields.status,
      fields.caseId ?? null,
      fields.scopeKey ?? null,
      fields.step ?? null,
      fields.reason ?? null,
      fields.detail ?? null,
      fields.executionId ?? null,
    ],
  )
}

const toDelivery = (row: EventRow): DeliveryRecord => ({
  id: row.id,
  system: row.system,
  externalId: row.external_id,
  idempotencyKey: row.idempotency_key,
  status: row.status as DeliveryRecord['status'],
  reason: row.reason as DeadLetterReason | null,
  receivedAt: row.received_at.toISOString(),
})
const toDeadLetter = (row: EventRow): DeadLetter => ({
  id: row.id,
  system: row.system,
  externalId: row.external_id,
  type: row.type,
  idempotencyKey: row.idempotency_key,
  caseId: row.case_id,
  scopeKey: row.scope_key,
  step: row.step,
  reason: row.reason as DeadLetterReason,
  detail: row.detail,
  event: row.event,
  receivedAt: row.received_at.toISOString(),
})

/** Read the dead-letter surface, newest first — the ops view of "arrived, did nothing". */
export const readDeadLetters = async (
  db: Queryable,
  filter: DeadLetterFilter = {},
): Promise<readonly DeadLetter[]> => {
  const { conditions, values, bind, where } = sqlWhere([
    `status = 'dead-lettered'`,
  ])

  if (filter.system !== undefined)
    conditions.push(`system = ${bind(filter.system)}`)
  if (filter.caseId !== undefined)
    conditions.push(`case_id = ${bind(filter.caseId)}`)
  if (filter.reason !== undefined)
    conditions.push(`reason = ${bind(filter.reason)}`)
  const limit = filter.limit === undefined ? '' : ` limit ${bind(filter.limit)}`

  const { rows } = await db.query<EventRow>(
    `select * from ${EVENTS} where ${where()} order by received_at desc${limit}`,
    values,
  )
  return rows.map(toDeadLetter)
}

/**
 * Ingestion: external events become Executions.
 *
 * A webhook arrives. Three things have to happen, in this order, and each of
 * them has to be visible afterwards:
 *
 * 1. **Dedup.** Providers retry; "at least once" is the delivery guarantee
 *    every one of them offers. The gate is a unique insert into
 *    `ingested_events` — not a lookup-then-insert, which races itself — so
 *    three concurrent deliveries of one event produce exactly one Execution
 *    and two `duplicate` results.
 * 2. **Correlate.** The external identifier is resolved to (case, scope,
 *    step) through the registry the initiating handler wrote.
 * 3. **Execute.** Through the ordinary claim → run → commit, with the
 *    external system as the journaled actor. Ingestion has no privileged
 *    path: the guard still decides, transactionally.
 *
 * What is *not* allowed is a quiet drop. An event nothing can route, an event
 * whose step the guard refuses, an event whose case is busy — each lands in
 * the same table with a status and a reason, which is the dead-letter
 * surface. "The webhook definitely arrived, so why is the case still waiting"
 * is a question this table answers without anyone reading a log file.
 */

import { createHash } from 'node:crypto'
import type {
  DeadLetterReason as ContractDeadLetterReason,
  IngestionStatus as ContractIngestionStatus,
} from '@affordance/contract'
import { isAffordanceError } from '../errors.js'
import type {
  ExecutionEnvironment,
  ExecutionResult,
  SystemSettled,
} from '../execution/index.js'
import { runAsSystem } from '../execution/index.js'
import type { Queryable } from '../store/index.js'
import {
  FRAMEWORK_SCHEMA,
  mintId,
  queryableOf,
  sqlWhere,
} from '../store/index.js'
import type { Correlation } from './correlation.js'
import { lookupCorrelation } from './correlation.js'

const EVENTS = `${FRAMEWORK_SCHEMA}.ingested_events`

/** An event as an external system delivered it. */
export interface ExternalEvent {
  /** The system that emitted it, matching the correlation's `system`. */
  readonly system: string
  /** The identifier that routes it — the one the initiating handler registered. */
  readonly externalId: string
  /** What happened, in the provider's own words: `'envelope.completed'`. */
  readonly type: string
  /** The provider's delivery id, when it has one — the strongest dedup key. */
  readonly eventId?: string
  /** The payload, passed to the target step as its input (validated by the step's schema). */
  readonly payload?: unknown
  /** Execute this step instead of the correlation's registered one. */
  readonly step?: string
  /** Override the derived idempotency key — for a provider whose retries are not identical. */
  readonly idempotencyKey?: string
  /** When the external system says it happened (ISO-8601); recorded, never used as `asOf`. */
  readonly occurredAt?: string
}

/**
 * How an ingested event ended up: `executed` (the target step ran and
 * committed), `duplicate` (already seen — this delivery changed nothing, by
 * design), or `dead-lettered` (nothing could be done with it, and it is
 * sitting in the dead-letter surface). Wire vocabulary, so the contract
 * declares it and this is the same closed set.
 */
export type IngestionStatus = ContractIngestionStatus

/**
 * Why an event was dead-lettered — the operator's first question, answered.
 *
 * Two reasons are ingestion's own (`unrouted`: no correlation claims the
 * identifier; `no-step`: routed, but neither the event nor the correlation
 * names a step); every other reason **is** the `AffordanceErrorCode`
 * the refused Execution already declared at its raise site. Ingestion does
 * not re-derive the kind of a Refusal — it projects the code the error
 * carries, so a new refusal class can never misroute here. Wire vocabulary,
 * declared once by the contract; this is the same closed set.
 */
export type DeadLetterReason = ContractDeadLetterReason

/**
 * Whether a provider redelivery of the same event deserves another attempt.
 *
 * Total over {@link DeadLetterReason}, so a new code cannot be added without
 * deciding its reopen policy. `true` marks the outcomes that another delivery
 * could genuinely cure — the case was busy, the handler crashed. Everything
 * deterministic (a payload its schema rejects, an address that does not
 * resolve, a guard that said no) stays dead-lettered: it will be refused the
 * same way on every retry, so reopening it would only invite endless
 * redelivery.
 */
export const REOPENS_ON_REDELIVERY: Record<DeadLetterReason, boolean> = {
  unrouted: false,
  'no-step': false,
  'step-not-available': false,
  'case-busy': true,
  'invalid-input': false,
  'not-found': false,
  'bad-request': false,
  'execution-failed': true,
  'invalid-state': false,
}

const REOPENABLE = Object.entries(REOPENS_ON_REDELIVERY)
  .filter(([, reopens]) => reopens)
  .map(([reason]) => reason)

/** What {@link ingest} resolves to — always a record, never a throw. */
export interface IngestionResult {
  readonly id: string
  readonly status: IngestionStatus
  readonly system: string
  readonly externalId: string
  readonly idempotencyKey: string
  /** Where it routed, when it routed. */
  readonly correlation: Correlation | null
  /** The Execution it produced, on `executed`. */
  readonly execution: ExecutionResult | null
  /** Why it is in the dead-letter surface, on `dead-lettered`. */
  readonly reason: DeadLetterReason | null
  /** Human-readable detail: the unmet conditions, the failure message. */
  readonly detail: string | null
  readonly receivedAt: string
}

/** A row of the dead-letter surface. */
export interface DeadLetter {
  readonly id: string
  readonly system: string
  readonly externalId: string
  readonly type: string
  readonly idempotencyKey: string
  readonly caseId: string | null
  readonly scopeKey: string | null
  readonly step: string | null
  readonly reason: DeadLetterReason
  readonly detail: string | null
  readonly event: ExternalEvent
  readonly receivedAt: string
}

/** Filters for {@link readDeadLetters}; all optional, all AND-ed. */
export interface DeadLetterFilter {
  readonly system?: string
  readonly caseId?: string
  readonly reason?: DeadLetterReason
  readonly limit?: number
}

/** How ingestion presents the external system to guards and the journal. */
export interface ExternalActor {
  readonly kind: 'external'
  readonly system: string
  readonly externalId: string
  readonly eventType: string
}

/** Engine-level ingestion settings. */
export interface IngestionOptions {
  /**
   * Map an event to the Actor its Execution runs as. Defaults to an
   * {@link ExternalActor}; an app whose `permits` conditions read its own
   * actor shape supplies a mapping instead of bending that shape.
   */
  readonly actor?: (event: ExternalEvent) => unknown
}

/** The normalized settings the environment carries. */
export interface IngestionSettings {
  readonly actor: (event: ExternalEvent) => unknown
}

/**
 * What {@link ingest} needs from its caller: the execution environment plus
 * ingestion's own settings. This is the widest environment any subsystem
 * asks for, so it is also the shape the engine builds once and hands to all
 * of them — named here so that contract is a type, not a coincidence of an
 * object literal.
 */
export interface IngestionEnvironment extends ExecutionEnvironment {
  readonly ingestion: IngestionSettings
}

export const externalActor = (event: ExternalEvent): ExternalActor => ({
  kind: 'external',
  system: event.system,
  externalId: event.externalId,
  eventType: event.type,
})

export const normalizeIngestion = (
  options: IngestionOptions = {},
): IngestionSettings => ({
  actor: options.actor ?? externalActor,
})

/**
 * The idempotency key an event dedups on.
 *
 * `(system, externalId, type)` is the key's fixed prefix, so the *same*
 * notification about the *same* envelope produces the same key however many
 * times it is delivered — and, because an external id resolves to one (case,
 * scope element), the key is scoped exactly as far as the correlation is. The
 * tail is the provider's own delivery id where there is one, and a hash of
 * the payload where there is not: a provider that cannot tell you which
 * delivery this is gets content-addressed dedup, which is the best anyone
 * can do.
 */
export const idempotencyKeyFor = (event: ExternalEvent): string => {
  if (event.idempotencyKey !== undefined) return event.idempotencyKey
  const tail =
    event.eventId ??
    createHash('sha256')
      .update(JSON.stringify(event.payload ?? null))
      .digest('hex')
      .slice(0, 32)
  return `${event.system}/${event.externalId}/${event.type}/${tail}`
}

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
const claimDelivery = async (
  db: Queryable,
  event: ExternalEvent,
  idempotencyKey: string,
): Promise<{ row: EventRow; fresh: boolean }> => {
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
  if (row) return { row, fresh: true }

  const retried = await db.query<EventRow>(
    `update ${EVENTS}
     set status = 'pending', reason = null, detail = null, received_at = now(), event = $2::jsonb
     where idempotency_key = $1 and status = 'dead-lettered' and reason = any($3)
     returning *`,
    [idempotencyKey, JSON.stringify(event), REOPENABLE],
  )
  const reopened = retried.rows[0]
  if (reopened) return { row: reopened, fresh: true }

  const existing = await db.query<EventRow>(
    `select * from ${EVENTS} where idempotency_key = $1`,
    [idempotencyKey],
  )
  const previous = existing.rows[0]
  if (!previous)
    throw new Error(
      `${EVENTS}: delivery neither inserted nor found — key ${idempotencyKey}`,
    )
  return { row: previous, fresh: false }
}

/** Record how a delivery ended. The row is the dead-letter surface, so this is the only settle path. */
const settle = async (
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

const result = (
  row: EventRow,
  status: IngestionStatus,
  extra: Partial<IngestionResult> = {},
): IngestionResult => ({
  id: row.id,
  status,
  system: row.system,
  externalId: row.external_id,
  idempotencyKey: row.idempotency_key,
  correlation: null,
  execution: null,
  reason: null,
  detail: null,
  receivedAt: row.received_at.toISOString(),
  ...extra,
})

/**
 * Which step an ingested event executes: the event's own naming wins,
 * falling back to what the correlation registered. The precedence is stated
 * once so any surface that *previews* routing (a dev console's world panel)
 * asks the same question `ingest` will answer.
 */
export const routedStep = (
  event: { readonly step?: string },
  correlation: { readonly step: string | null },
): string | null => event.step ?? correlation.step ?? null

/**
 * Ingest one external event: dedup, correlate, execute — or dead-letter it
 * with a reason.
 *
 * Never throws for an event's own sake: a webhook endpoint that 500s because
 * a guard said no teaches the provider to retry something that will never
 * succeed. Infrastructure failures (the database is gone) do still throw,
 * because those the caller must not acknowledge.
 */
export const ingest = async (
  env: IngestionEnvironment,
  event: ExternalEvent,
): Promise<IngestionResult> => {
  const db = queryableOf(env.db)
  const idempotencyKey = idempotencyKeyFor(event)
  const { row, fresh } = await claimDelivery(db, event, idempotencyKey)
  if (!fresh) {
    return result(row, 'duplicate', {
      reason: (row.reason as DeadLetterReason | null) ?? null,
      detail: `already ingested as ${row.status} at ${row.received_at.toISOString()}`,
    })
  }

  // Settle the row and answer the caller with the same reason/detail pair —
  // one helper, so a branch cannot record one thing and report another.
  const deadLetter = async (fields: {
    readonly reason: DeadLetterReason
    readonly detail: string
    readonly correlation?: Correlation
    readonly step?: string
  }): Promise<IngestionResult> => {
    await settle(db, row.id, {
      status: 'dead-lettered',
      reason: fields.reason,
      detail: fields.detail,
      ...(fields.correlation !== undefined && {
        caseId: fields.correlation.caseId,
        scopeKey: fields.correlation.scopeKey,
      }),
      ...(fields.step !== undefined && { step: fields.step }),
    })
    return result(row, 'dead-lettered', {
      reason: fields.reason,
      detail: fields.detail,
      ...(fields.correlation !== undefined && {
        correlation: fields.correlation,
      }),
    })
  }

  const correlation = await lookupCorrelation(
    db,
    event.system,
    event.externalId,
  )
  if (correlation === null) {
    return deadLetter({
      reason: 'unrouted',
      detail: `no correlation registered for ${event.system}/${event.externalId}`,
    })
  }

  const stepName = routedStep(event, correlation)
  if (stepName === null) {
    return deadLetter({
      correlation,
      reason: 'no-step',
      detail: `correlation ${event.system}/${event.externalId} names no step, and the event does not either`,
    })
  }

  const ran = await runAsSystem(env, correlation.caseId, stepName, {
    actor: env.ingestion.actor(event),
    ...(correlation.scopeKey !== null && { scopeKey: correlation.scopeKey }),
    ...(event.payload !== undefined && { input: event.payload }),
  })
  if (ran.outcome === 'committed') {
    await settle(db, row.id, {
      status: 'executed',
      caseId: correlation.caseId,
      scopeKey: correlation.scopeKey,
      step: stepName,
      executionId: ran.result.executionId,
    })
    return result(row, 'executed', { correlation, execution: ran.result })
  }
  const [reason, detail] = classifyDeadLetter(ran)
  return deadLetter({ correlation, step: stepName, reason, detail })
}

/**
 * Project a settled system run onto the reason an operator needs to see —
 * the one place that asks whether what settled was a Refusal.
 *
 * A framework Refusal already names its own kind and explains itself — the
 * reason is its code, the detail its message (a refused guard's message
 * carries the unmet conditions, addressed). Anything else is a bug, not a
 * Refusal; it lands as `execution-failed` so the event is kept, never
 * silently dropped, with the crash's own words as the detail.
 */
export const classifyDeadLetter = (
  ran: SystemSettled,
): [DeadLetterReason, string] =>
  isAffordanceError(ran.error)
    ? [ran.error.code, ran.error.message]
    : ['execution-failed', ran.error.message]

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

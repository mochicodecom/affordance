import type {
  GuardEvaluation,
  JournalEntry,
  JournalEntryInput,
  JournalEntryType,
  JournalError,
  JournalFilter,
  ObservedEntryInput,
  StateDelta,
} from '@affordance/core'
import {
  deserializeValue,
  mintId,
  projectEntry,
  serializeValue,
} from '@affordance/core/storage'
import { FRAMEWORK_SCHEMA } from './bootstrap.js'
import type { DatabaseAccess, Queryable } from './queryable.js'
import { sqlWhere } from './sql.js'
import { withTransaction } from './transaction.js'

const JOURNAL = `${FRAMEWORK_SCHEMA}.journal`
const JOURNAL_COLUMNS =
  'ordinal, id, case_id, execution_id, entry, attempt, step, scope_key, actor, input, as_of, guard, state, delta, dormancy, error, recorded_at, observed_at'

/** Bound journal SQL so it releases shared connection capacity after timeout. */
export const observeEntry = async (
  db: DatabaseAccess,
  entry: ObservedEntryInput,
  timeoutMs: number,
): Promise<void> => {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647
  )
    throw new TypeError('journal timeoutMs must be a positive 32-bit integer')
  const expiresAt = performance.now() + timeoutMs
  await withTransaction(db, async (tx) => {
    const remaining = () => {
      const ms = Math.ceil(expiresAt - performance.now())
      if (ms <= 0) throw new Error('journal deadline expired')
      return ms
    }
    const bounded: Queryable = {
      async query(text, values) {
        // SET LOCAL restores the connection's original timeout on commit/rollback.
        // Recompute for each statement, including a duplicate-observation lookup.
        await tx.query("select set_config('statement_timeout', $1, true)", [
          String(remaining()),
        ])
        remaining()
        return tx.query(text, values)
      },
    }
    await appendEntry(bounded, entry)
  })
}

type JournalRow = {
  ordinal: string | number
  id: string
  case_id: string
  execution_id: string
  entry: string
  attempt: number
  step: string
  scope_key: string | null
  actor: unknown
  input: unknown
  as_of: Date | null
  guard: GuardEvaluation | null
  state: unknown
  delta: StateDelta | null
  dormancy: string | null
  error: JournalError | null
  observed_at: Date | null
  recorded_at: Date
}

const toEntry = (row: JournalRow): JournalEntry => {
  const context = `journal '${row.id}' for case '${row.case_id}'`
  return {
    ordinal: Number(row.ordinal),
    id: row.id,
    caseId: row.case_id,
    executionId: row.execution_id,
    entry: row.entry as JournalEntryType,
    attempt: row.attempt,
    step: row.step,
    scopeKey: row.scope_key,
    actor: deserializeValue(row.actor, `${context} actor`),
    input: deserializeValue(row.input, `${context} input`),
    asOf: row.as_of === null ? null : row.as_of.toISOString(),
    guard: row.guard,
    state:
      row.entry === 'started' || row.entry === 'observed'
        ? deserializeValue(row.state, `${context} state`)
        : null,
    delta: row.delta,
    dormancy: row.dormancy as 'ended' | 'reopened' | null,
    error: row.error,
    recordedAt: row.recorded_at.toISOString(),
    ...(row.observed_at ? { observedAt: row.observed_at.toISOString() } : {}),
  }
}

/** Append one entry. Inserts only — journal rows are never updated or deleted. */
export const appendEntry = async (
  db: Queryable,
  input: JournalEntryInput,
): Promise<JournalEntry> => {
  const entry = projectEntry(input)
  const context = `journal '${entry.entry}' for case '${entry.caseId}', step '${entry.step}', execution '${entry.executionId}'`
  const { rows } = await db.query<JournalRow>(
    `insert into ${JOURNAL}
       (id, case_id, execution_id, entry, attempt, step, scope_key, actor, input, as_of, guard, state, delta, dormancy, error, observed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::timestamptz, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15::jsonb, $16::timestamptz)
     on conflict (execution_id) where entry='observed' do nothing
     returning ${JOURNAL_COLUMNS}`,
    [
      mintId('journal'),
      entry.caseId,
      entry.executionId,
      entry.entry,
      entry.attempt,
      entry.step,
      entry.scopeKey,
      JSON.stringify(serializeValue(entry.actor, `${context} actor`)),
      JSON.stringify(serializeValue(entry.input, `${context} input`)),
      entry.asOf,
      JSON.stringify(entry.guard),
      entry.entry === 'started' || entry.entry === 'observed'
        ? JSON.stringify(serializeValue(entry.state, `${context} state`))
        : null,
      JSON.stringify(entry.delta),
      entry.dormancy,
      JSON.stringify(entry.error),
      entry.observedAt ?? null,
    ],
  )
  const row = rows[0]
  if (!row && input.entry === 'observed') {
    const existing = await readJournal(db, input.caseId, {
      executionId: input.executionId,
      entry: 'observed',
    })
    if (existing[0]) return existing[0]
  }
  if (!row) throw new Error(`insert into ${JOURNAL} returned no row`)
  return toEntry(row)
}

/**
 * Read a case's journal in insertion order, oldest first. With no filter this
 * is the whole story of the case; with `scopeKey` it is one track's audit.
 */
export const readJournal = async (
  db: Queryable,
  caseId: string,
  filter: JournalFilter = {},
): Promise<readonly JournalEntry[]> => {
  const { conditions, values, bind, where } = sqlWhere(
    ['case_id = $1'],
    [caseId],
  )

  if (filter.scopeKey !== undefined)
    conditions.push(`scope_key = ${bind(filter.scopeKey)}`)
  if (filter.step !== undefined) conditions.push(`step = ${bind(filter.step)}`)
  if (filter.executionId !== undefined)
    conditions.push(`execution_id = ${bind(filter.executionId)}`)
  if (filter.entry !== undefined) {
    const entries = Array.isArray(filter.entry) ? filter.entry : [filter.entry]
    conditions.push(`entry = any(${bind(entries)}::text[])`)
  }
  if (filter.since !== undefined)
    conditions.push(`ordinal > ${bind(filter.since)}`)

  const limit = filter.limit === undefined ? '' : ` limit ${bind(filter.limit)}`
  const { rows } = await db.query<JournalRow>(
    `select ${JOURNAL_COLUMNS} from ${JOURNAL}
     where ${where()}
     order by ordinal asc${limit}`,
    values,
  )
  return rows.map(toEntry)
}

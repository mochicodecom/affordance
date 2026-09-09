import type {
  GuardEvaluation,
  JournalEntry,
  JournalEntryInput,
  JournalEntryType,
  JournalError,
  JournalFilter,
  StateDelta,
} from '@affordance/core'
import { mintId, projectEntry } from '@affordance/core/storage'
import { FRAMEWORK_SCHEMA } from './bootstrap.js'
import type { Queryable } from './queryable.js'
import { sqlWhere } from './sql.js'

const JOURNAL = `${FRAMEWORK_SCHEMA}.journal`
const JOURNAL_COLUMNS =
  'ordinal, id, case_id, execution_id, entry, attempt, step, scope_key, actor, input, as_of, guard, state, delta, dormancy, error, recorded_at'

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
  recorded_at: Date
}

const toEntry = (row: JournalRow): JournalEntry => ({
  ordinal: Number(row.ordinal),
  id: row.id,
  caseId: row.case_id,
  executionId: row.execution_id,
  entry: row.entry as JournalEntryType,
  attempt: row.attempt,
  step: row.step,
  scopeKey: row.scope_key,
  actor: row.actor,
  input: row.input,
  asOf: row.as_of === null ? null : row.as_of.toISOString(),
  guard: row.guard,
  state: row.state,
  delta: row.delta,
  dormancy: row.dormancy as 'ended' | 'reopened' | null,
  error: row.error,
  recordedAt: row.recorded_at.toISOString(),
})

/**
 * Serialize a value for a jsonb column. Actors and inputs are app-owned
 * shapes, and a journal append must never be the thing that fails an
 * otherwise-good Execution: a value that will not stringify (a cycle, a
 * BigInt) is journaled as a marker string rather than thrown over.
 */
const toJsonb = (value: unknown): string | null => {
  if (value === undefined || value === null) return null
  try {
    const json = JSON.stringify(value)
    return json === undefined ? null : json
  } catch {
    return JSON.stringify({ '~unserializable': String(value) })
  }
}

/** Append one entry. Inserts only — journal rows are never updated or deleted. */
export const appendEntry = async (
  db: Queryable,
  input: JournalEntryInput,
): Promise<JournalEntry> => {
  const entry = projectEntry(input)
  const { rows } = await db.query<JournalRow>(
    `insert into ${JOURNAL}
       (id, case_id, execution_id, entry, attempt, step, scope_key, actor, input, as_of, guard, state, delta, dormancy, error)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::timestamptz, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15::jsonb)
     returning ${JOURNAL_COLUMNS}`,
    [
      mintId('journal'),
      entry.caseId,
      entry.executionId,
      entry.entry,
      entry.attempt,
      entry.step,
      entry.scopeKey,
      toJsonb(entry.actor),
      toJsonb(entry.input),
      entry.asOf,
      toJsonb(entry.guard),
      toJsonb(entry.state),
      toJsonb(entry.delta),
      entry.dormancy,
      toJsonb(entry.error),
    ],
  )
  const row = rows[0]
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

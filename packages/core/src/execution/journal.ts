/**
 * The journal: the immutable, append-only record of a case's Executions
 * (CONTEXT.md).
 *
 * Historical questions are answered from what the system actually believed at
 * the time, never by re-deriving the past through present-day code — so a
 * `claimed` entry stores the guard evaluation *and* the Case State it was
 * evaluated against, and every entry repeats the Execution's identity (step,
 * scope key, actor). Per-track audit — "everything that happened on buyer
 * #7" — is therefore a filter, not a reconstruction.
 *
 * Only inserts exist in this module. There is no update or delete path for a
 * journal row anywhere in the library.
 */

import type { JournalEntryKind } from '@affordance/contract'
import type { GuardEvaluation } from '../guards/index.js'
import type { Queryable } from '../store/index.js'
import { FRAMEWORK_SCHEMA, mintId, sqlWhere } from '../store/index.js'
import type { StateDelta } from './delta.js'

const JOURNAL = `${FRAMEWORK_SCHEMA}.journal`
const JOURNAL_COLUMNS =
  'ordinal, id, case_id, execution_id, entry, attempt, step, scope_key, actor, input, as_of, guard, state, delta, dormancy, error, recorded_at'

/**
 * Which lifecycle moment an entry records.
 *
 * - `claimed` — the claim's transactional guard re-evaluation passed and the
 *   Execution took the case; carries `guard`, `asOf` and `state`
 * - `attempt-failed` — one attempt threw and another will follow
 * - `completed` — the handler's Case State was committed; carries `delta`
 * - `failed` — retries exhausted (or a deterministic defect); case released
 * - `expired` — the claim lapsed without a terminal entry: the handler's
 *   process died, and a later claimant recorded the abandonment
 */
export type JournalEntryType = JournalEntryKind

/** A failure as journaled — the error's identity, not a live Error object. */
export interface JournalError {
  readonly name: string
  readonly message: string
}

/** One journal entry, JSON-serializable throughout (timestamps are ISO-8601 UTC). */
export interface JournalEntry {
  /** Total insertion order across all cases; per-case order is `(caseId, ordinal)`. */
  readonly ordinal: number
  readonly id: string
  readonly caseId: string
  /** The Execution this entry belongs to — several entries share one. */
  readonly executionId: string
  readonly entry: JournalEntryType
  /** 1-based attempt this entry is about. */
  readonly attempt: number
  readonly step: string
  /** The bound scope key, or `null` for an unscoped step. */
  readonly scopeKey: string | null
  /** The acting Actor, as supplied by the app. */
  readonly actor: unknown
  /** The step input, post-validation (schema output), or `null`. */
  readonly input: unknown
  /** The instant the claim's guard re-evaluation was made as of, on `claimed` entries. */
  readonly asOf: string | null
  /** The claim-time guard evaluation — the enforcement moment's full record. */
  readonly guard: GuardEvaluation | null
  /** The Case State the guard was evaluated against, on `claimed` entries. */
  readonly state: unknown
  /** The committed state delta, on `completed` entries. */
  readonly delta: StateDelta | null
  /** `end()` / `reopen()` called by the handler, on `completed` entries. */
  readonly dormancy: 'ended' | 'reopened' | null
  /** The failure, on `attempt-failed` / `failed` / `expired` entries. */
  readonly error: JournalError | null
  readonly recordedAt: string
}

/** The identity every journal entry carries, whatever its kind. */
interface JournalEntryIdentity {
  readonly caseId: string
  readonly executionId: string
  readonly attempt: number
  readonly step: string
  readonly scopeKey?: string | null
  readonly actor?: unknown
  readonly input?: unknown
}

/**
 * A `claimed` entry records the enforcement moment, so the evidence is
 * required: the instant, the guard evaluation, and the Case State it ran
 * against.
 */
export interface ClaimedEntryInput extends JournalEntryIdentity {
  readonly entry: 'claimed'
  readonly asOf: string
  readonly guard: GuardEvaluation
  readonly state: unknown
}

/** A `completed` entry records what the commit changed. */
export interface CompletedEntryInput extends JournalEntryIdentity {
  readonly entry: 'completed'
  readonly delta: StateDelta
  readonly dormancy?: 'ended' | 'reopened' | null
}

/** Every way an Execution stops without committing carries the failure that stopped it. */
export interface FailureEntryInput extends JournalEntryIdentity {
  readonly entry: 'attempt-failed' | 'failed' | 'expired'
  readonly error: JournalError
}

/**
 * What {@link appendEntry} needs — a discriminated union on `entry`, so
 * which fields accompany which lifecycle moment is stated by the type
 * itself rather than re-derived from prose by every reader.
 * `{ entry: 'failed', guard, delta }` is unrepresentable rather than
 * quietly journaled.
 */
export type JournalEntryInput =
  | ClaimedEntryInput
  | CompletedEntryInput
  | FailureEntryInput

/**
 * A `claimed` entry as read back, with the enforcement-moment evidence
 * present — what {@link appendEntry}'s input union guarantees was written.
 */
export type ClaimedJournalEntry = JournalEntry & {
  readonly entry: 'claimed'
  readonly asOf: string
  readonly guard: GuardEvaluation
}

/**
 * Narrow a read entry to the claimed moment. The one predicate every reader
 * of claim-time evidence (`foldExecutions`, audit replay) shares, so what
 * counts as "carries the evidence" is decided once.
 */
export const isClaimedEntry = (
  entry: JournalEntry,
): entry is ClaimedJournalEntry =>
  entry.entry === 'claimed' && entry.guard !== null && entry.asOf !== null

/** Filters for {@link readJournal}; all optional, all AND-ed. */
export interface JournalFilter {
  /** Per-track audit: only entries bound to this scope key. */
  readonly scopeKey?: string
  /** Only entries for this step. */
  readonly step?: string
  /** Only entries belonging to this Execution. */
  readonly executionId?: string
  /** Only these entry types. */
  readonly entry?: JournalEntryType | readonly JournalEntryType[]
  /** Only entries after this ordinal (exclusive) — cursor paging. */
  readonly since?: number
  /** Cap the number of entries returned; the oldest matching entries win. */
  readonly limit?: number
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

/** A stored entry minus what storage assigns: `ordinal`, `id`, `recordedAt`. */
export type JournalEntryColumns = Omit<
  JournalEntry,
  'ordinal' | 'id' | 'recordedAt'
>

/**
 * Project an input onto a stored entry's fields — the one statement of the
 * defaulting and of which fields accompany which lifecycle moment. Every
 * adapter persists exactly this and assigns the rest; an adapter that could
 * disagree with another about what a `failed` entry looks like would be
 * a second, divergent copy of the journal's semantics.
 */
export const projectEntry = (input: JournalEntryInput): JournalEntryColumns => {
  const claimed = input.entry === 'claimed' ? input : null
  const completed = input.entry === 'completed' ? input : null
  const failure =
    input.entry !== 'claimed' && input.entry !== 'completed' ? input : null
  return {
    caseId: input.caseId,
    executionId: input.executionId,
    entry: input.entry,
    attempt: input.attempt,
    step: input.step,
    scopeKey: input.scopeKey ?? null,
    actor: input.actor ?? null,
    input: input.input ?? null,
    asOf: claimed?.asOf ?? null,
    guard: claimed?.guard ?? null,
    state: claimed?.state ?? null,
    delta: completed?.delta ?? null,
    dormancy: completed?.dormancy ?? null,
    error: failure?.error ?? null,
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

/** How an Execution ended up, folded from its entries. */
export type ExecutionStatus = 'in-progress' | 'completed' | 'failed' | 'expired'

/**
 * One Execution as a single record: its identity, the claim-time evidence,
 * and how it settled. This is a fold over entries of the *same* Execution —
 * assembling one record from the moments that constitute it, not deriving
 * state from a log (the design rejects the latter, not the former).
 */
export interface ExecutionRecord {
  readonly executionId: string
  readonly caseId: string
  readonly step: string
  readonly scopeKey: string | null
  readonly actor: unknown
  readonly input: unknown
  readonly status: ExecutionStatus
  /** Attempts observed — the highest attempt number any of its entries carries. */
  readonly attempts: number
  readonly asOf: string | null
  readonly guard: GuardEvaluation | null
  /** The Case State the claim's guard was evaluated against. */
  readonly state: unknown
  readonly delta: StateDelta | null
  readonly dormancy: 'ended' | 'reopened' | null
  readonly error: JournalError | null
  readonly claimedAt: string | null
  /** When the Execution reached a terminal entry; `null` while in progress. */
  readonly settledAt: string | null
}

const TERMINAL: Record<string, ExecutionStatus | undefined> = {
  completed: 'completed',
  failed: 'failed',
  expired: 'expired',
}

/**
 * Fold journal entries into one record per Execution, in first-appearance
 * order. Feed it a filtered read (by scope key, say) to get that track's
 * Executions.
 */
export const foldExecutions = (
  entries: readonly JournalEntry[],
): readonly ExecutionRecord[] => {
  const byExecution = new Map<string, ExecutionRecord>()
  for (const entry of entries) {
    const previous = byExecution.get(entry.executionId)
    const terminal = TERMINAL[entry.entry]
    const claimed = isClaimedEntry(entry) ? entry : null
    const base: ExecutionRecord = previous ?? {
      executionId: entry.executionId,
      caseId: entry.caseId,
      step: entry.step,
      scopeKey: entry.scopeKey,
      actor: entry.actor,
      input: entry.input,
      status: 'in-progress',
      attempts: entry.attempt,
      asOf: null,
      guard: null,
      state: undefined,
      delta: null,
      dormancy: null,
      error: null,
      claimedAt: null,
      settledAt: null,
    }
    byExecution.set(entry.executionId, {
      ...base,
      attempts: Math.max(base.attempts, entry.attempt),
      status: terminal ?? base.status,
      asOf: claimed !== null ? claimed.asOf : base.asOf,
      guard: claimed !== null ? claimed.guard : base.guard,
      state: claimed !== null ? claimed.state : base.state,
      delta: entry.delta ?? base.delta,
      dormancy: entry.dormancy ?? base.dormancy,
      // The terminal error is the one that matters; an attempt-failed error
      // only stands while nothing has superseded it.
      error: entry.error ?? base.error,
      claimedAt: claimed !== null ? claimed.recordedAt : base.claimedAt,
      settledAt: terminal === undefined ? base.settledAt : entry.recordedAt,
    })
  }
  return [...byExecution.values()]
}

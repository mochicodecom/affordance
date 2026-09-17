/**
 * The journal: the immutable, append-only record of a case's Executions
 * (CONTEXT.md).
 *
 * Historical questions are answered from what the system actually believed at
 * the time, never by re-deriving the past through present-day code — so a
 * `started` entry stores the guard evaluation *and* the Case State it was
 * evaluated against, and every entry repeats the Execution's identity (step,
 * scope key, actor). Per-track audit — "everything that happened on buyer
 * #7" — is therefore a filter, not a reconstruction.
 *
 * This module defines journal evidence and its projections. Storage adapters
 * append and read the records; the engine never rewrites historical entries.
 */

import type { GuardEvaluation } from '../guards/index.js'
import type { StateDelta } from './delta.js'

/** Started and completed are persisted together with the domain operation.
 * Failed entries are reserved for explicitly confirmed rollback diagnostics;
 * the ordinary engine records committed operations only. */
export const JOURNAL_ENTRY_KINDS = [
  'started',
  'completed',
  'failed',
  'observed',
] as const

export type JournalEntryType = (typeof JOURNAL_ENTRY_KINDS)[number]

/** A failure as journaled — the error's identity, not a live Error object. */
export interface JournalError {
  readonly name: string
  readonly message: string
}

/** One decoded journal entry. Actor, input and state may contain supported runtime types. */
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
  /**
   * Validated input on engine-written started entries, including explicit undefined.
   * Later lifecycle entries omit input evidence and default this field to null.
   */
  readonly input: unknown
  /** The instant the guard re-evaluation was made as of, on `started` entries. */
  readonly asOf: string | null
  /** The enforcement-time guard evaluation — the enforcement moment's full record. */
  readonly guard: GuardEvaluation | null
  /** The Case State the guard was evaluated against, on `started` entries. */
  readonly state: unknown
  /** The committed state delta, on `completed` entries. */
  readonly delta: StateDelta | null
  /** `end()` / `reopen()` called by the handler, on `completed` entries. */
  readonly dormancy: 'ended' | 'reopened' | null
  /** The failure, on `failed` entries. */
  readonly error: JournalError | null
  /** Handler-return observation time; present only on separately recorded diffs. */
  readonly observedAt?: string | null
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
 * A `started` entry records the enforcement moment, so the evidence is
 * required: the instant, the guard evaluation, and the Case State it ran
 * against.
 */
export interface StartedEntryInput extends JournalEntryIdentity {
  readonly entry: 'started'
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

/** Optional confirmed-rollback diagnostics. Ordinary execution writes no failure entry. */
export interface FailureEntryInput extends JournalEntryIdentity {
  readonly entry: 'failed'
  readonly error: JournalError
}

/**
 * What {@link appendEntry} needs — a discriminated union on `entry`, so
 * which fields accompany which lifecycle moment is stated by the type
 * itself rather than re-derived from prose by every reader.
 * `{ entry: 'failed', guard, delta }` is unrepresentable rather than
 * quietly journaled.
 */
/** A handler-reported diff; no atomic-commit or lease-finalization claim. */
export interface ObservedEntryInput extends JournalEntryIdentity {
  readonly entry: 'observed'
  readonly asOf: string
  readonly observedAt: string
  readonly state: unknown
  readonly delta: StateDelta
}

export type JournalEntryInput =
  | ObservedEntryInput
  | StartedEntryInput
  | CompletedEntryInput
  | FailureEntryInput

/**
 * A `started` entry as read back, with the enforcement-moment evidence
 * present — what {@link appendEntry}'s input union guarantees was written.
 */
export type StartedJournalEntry = JournalEntry & {
  readonly entry: 'started'
  readonly asOf: string
  readonly guard: GuardEvaluation
}

/**
 * Narrow a read entry to the started moment. The one predicate every reader
 * of enforcement-time evidence (`foldExecutions`, audit replay) shares, so what
 * counts as "carries the evidence" is decided once.
 */
export const isStartedEntry = (
  entry: JournalEntry,
): entry is StartedJournalEntry =>
  entry.entry === 'started' && entry.guard !== null && entry.asOf !== null

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
  const started = input.entry === 'started' ? input : null
  const completed = input.entry === 'completed' ? input : null
  const failure = input.entry === 'failed' ? input : null
  const observed = input.entry === 'observed' ? input : null
  return {
    caseId: input.caseId,
    executionId: input.executionId,
    entry: input.entry,
    attempt: input.attempt,
    step: input.step,
    scopeKey: input.scopeKey ?? null,
    actor: Object.hasOwn(input, 'actor') ? input.actor : null,
    input: Object.hasOwn(input, 'input') ? input.input : null,
    asOf: started?.asOf ?? observed?.asOf ?? null,
    guard: started?.guard ?? null,
    state: started !== null ? started.state : (observed?.state ?? null),
    delta: completed?.delta ?? observed?.delta ?? null,
    dormancy: completed?.dormancy ?? null,
    error: failure?.error ?? null,
    ...(observed ? { observedAt: observed.observedAt } : {}),
  }
}

/** How an Execution ended up, folded from its entries. */
export type ExecutionStatus =
  | 'in-progress'
  | 'completed'
  | 'failed'
  | 'observed'

/**
 * One Execution as a single record: its identity, the enforcement-time evidence,
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
  /** The Case State the guard was evaluated against. */
  readonly state: unknown
  readonly delta: StateDelta | null
  readonly dormancy: 'ended' | 'reopened' | null
  readonly error: JournalError | null
  readonly startedAt: string | null
  /** When the Execution reached a terminal entry; `null` while in progress. */
  readonly settledAt: string | null
}

const TERMINAL: Record<string, ExecutionStatus | undefined> = {
  completed: 'completed',
  observed: 'observed',
  failed: 'failed',
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
    const started = isStartedEntry(entry) ? entry : null
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
      startedAt: null,
      settledAt: null,
    }
    byExecution.set(entry.executionId, {
      ...base,
      attempts: Math.max(base.attempts, entry.attempt),
      status: terminal ?? base.status,
      asOf: started !== null ? started.asOf : base.asOf,
      guard: started !== null ? started.guard : base.guard,
      state:
        started !== null
          ? started.state
          : entry.entry === 'observed'
            ? entry.state
            : base.state,
      delta: entry.delta ?? base.delta,
      dormancy: entry.dormancy ?? base.dormancy,
      error: entry.error ?? base.error,
      startedAt: started !== null ? started.recordedAt : base.startedAt,
      settledAt: terminal === undefined ? base.settledAt : entry.recordedAt,
    })
  }
  return [...byExecution.values()]
}

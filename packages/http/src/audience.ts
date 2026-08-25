/**
 * The audience rule — the one module that decides what a caller may be told.
 *
 * `permits` conditions encode internal policy: role names, thresholds,
 * approval hierarchies. Naming the one a caller failed tells them exactly
 * what to fake to pass it, so under `permitted` visibility no `permits`
 * result ever leaves the process — not in a blocked entry, not in an
 * explanation, not in a refusal, and not in a journal entry's recorded
 * guard evaluation.
 *
 * The rule decides whole records as well as individual condition results,
 * and every one of those decisions is made here: which blocked entries an
 * affordance listing keeps ({@link visibleAffordances}), whether a journal
 * entry carries the Case State it was evaluated against
 * ({@link visibleJournalEntry}), and what a refusal's prose may name
 * ({@link visibleRefusal}) — alongside the
 * condition-level filters ({@link visibleConditions}, {@link visibleGuard}).
 * A serializer asks this module for the caller's version of a record; it
 * never knows which *fields* the rule touches. The rule living here, once,
 * is what makes "the fifth read surface forgot to filter" a structural
 * impossibility instead of a review item: a serializer that bypasses this
 * module has to *not import it*, which is visible in a diff, rather than
 * re-implement it slightly wrong, which is not.
 */

import type {
  AnyOfConditionPayload,
  ConditionPayload,
  GuardEvaluationPayload,
  SingleConditionPayload,
  Visibility,
} from '@affordance/contract'
import type {
  CaseAffordances,
  ConditionResult,
  GuardEvaluation,
  JournalEntry,
  StepNotAvailableError,
} from '@affordance/core'
import { stepLabel } from '@affordance/core'

/**
 * One condition result, translated field by field into the contract's leaf
 * type. Core's `ConditionResult` and the contract's `ConditionPayload` are
 * structurally identical today, which is exactly why the translation is
 * spelled out: assignability covers renames but not additions — a field core
 * grows (a timing, a diagnostic) would otherwise pass silently onto every
 * surface this module exists to police.
 */
const toConditionPayload = (condition: ConditionResult): ConditionPayload => {
  const base: SingleConditionPayload = {
    name: condition.name,
    section: condition.section,
    kind: 'condition',
    passed: condition.passed,
    ...(condition.reason !== undefined && { reason: condition.reason }),
  }
  if (condition.kind !== 'anyOf') return base
  const group: AnyOfConditionPayload = {
    ...base,
    kind: 'anyOf',
    arms: condition.arms.map((arm) => ({
      name: arm.name,
      section: arm.section,
      kind: 'condition',
      passed: arm.passed,
      ...(arm.reason !== undefined && { reason: arm.reason }),
    })),
  }
  return group
}

/**
 * Filter condition results for the audience. Under `permitted`, `permits`
 * results never leave the process: the caller learns *that* they are not
 * permitted, never which rule decided it.
 */
export const visibleConditions = (
  conditions: readonly ConditionResult[],
  visibility: Visibility,
): readonly ConditionPayload[] =>
  (visibility === 'all'
    ? conditions
    : conditions.filter((condition) => condition.section !== 'permits')
  ).map(toConditionPayload)

/**
 * A recorded guard evaluation, filtered for the audience. The verdict pair
 * (`possible` / `permitted`) survives — "not you" is an honest answer — but
 * which `permits` rule decided it does not.
 */
export const visibleGuard = (
  guard: GuardEvaluation,
  visibility: Visibility,
): GuardEvaluationPayload => ({
  asOf: guard.asOf,
  possible: guard.possible,
  permitted: guard.permitted,
  available: guard.available,
  conditions: visibleConditions(guard.conditions, visibility),
})

/**
 * An affordance record as the audience may see it. Under the default
 * visibility this is where other actors' tracks disappear: a scoped step
 * fans out over every element, and the blocked entries whose `permits` this
 * actor failed are dropped rather than listed — so a buyer's payload
 * contains their own track and nothing else, without the app writing a
 * filter. The operator (`all`) sees every entry.
 */
export const visibleAffordances = (
  record: CaseAffordances,
  visibility: Visibility,
): CaseAffordances =>
  visibility === 'all'
    ? record
    : { ...record, blocked: record.blocked.filter((entry) => entry.permitted) }

/**
 * A journal entry as the audience may see it: the recorded guard filtered,
 * and the Case State the guard ran against present only for the operator —
 * this contract keeps Case State off the wire everywhere, and the journal is
 * not the exception. `state` is *absent*, not `null`, for everyone else: a
 * `null` would read as "the evidence was empty" where the truth is "not
 * yours to read".
 */
export type VisibleJournalEntry = Omit<JournalEntry, 'guard' | 'state'> & {
  readonly guard: GuardEvaluationPayload | null
  readonly state?: unknown
}

export const visibleJournalEntry = (
  entry: JournalEntry,
  visibility: Visibility,
): VisibleJournalEntry => {
  const { state, guard, ...rest } = entry
  return {
    ...rest,
    guard: guard === null ? null : visibleGuard(guard, visibility),
    ...(visibility === 'all' && { state }),
  }
}

/** A refusal as the audience may hear it: the verdict pair, the visible unmet conditions, and prose that names only them. */
export interface VisibleRefusal {
  readonly message: string
  readonly possible: boolean
  readonly permitted: boolean
  readonly unmet: readonly ConditionPayload[]
}

/**
 * The refusal a caller may see. The framework's own message names every
 * unmet condition, `permits` included — which is right for a server log and
 * wrong for a response body. Under `permitted` visibility the message is
 * rebuilt from the visible conditions only, so "not permitted" is all a
 * rejected caller learns.
 */
export const visibleRefusal = (
  error: StepNotAvailableError,
  visibility: Visibility,
): VisibleRefusal => {
  const unmet = visibleConditions(error.unmet, visibility)
  const base = {
    possible: error.evaluation.possible,
    permitted: error.evaluation.permitted,
    unmet,
  }
  if (visibility === 'all') return { ...base, message: error.message }
  const where = `step ${stepLabel(error.stepName, error.scopeKey)} on case ${error.caseId}`
  if (!error.evaluation.permitted)
    return { ...base, message: `${where} is not permitted for this actor` }
  const named = unmet.map((condition) => condition.name).join(', ')
  return {
    ...base,
    message: `${where} is not available: ${named || 'unmet conditions'}`,
  }
}

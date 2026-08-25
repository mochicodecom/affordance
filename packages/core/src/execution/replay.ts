/**
 * Audit reconstruction.
 *
 * "Why was this affordance available last Tuesday?" is answered from the
 * journaled record of what the system actually believed at the time, never by
 * re-deriving the past through present-day code. A `claimed` entry
 * carries everything that answer needs: the guard evaluation, the instant it
 * was made as of, the Actor, and the Case State it was evaluated against.
 *
 * `replayGuard` re-runs **today's** definition against **that** recorded
 * moment and reports both results side by side. A mismatch is not a bug in
 * the journal — it is the interesting signal: cases float to the latest
 * definitions, so it means the step's guard changed since the
 * Execution ran, and it says exactly how.
 *
 * Replay is a sweep over the Journal, so it is the lenient filter over
 * {@link addressTarget}: a journaled moment today's definitions can no
 * longer address — the step was removed, the element its scope key named no
 * longer selects, the selector throws over the historical document — is
 * itself definition drift, reported as `unaddressable` rather than thrown.
 * One drifted entry must never take down an audit of the rest.
 */

import type { GuardEvaluation } from '../guards/index.js'
import type { AnyCaseType } from '../model/index.js'
import { addressTarget, evaluateTarget } from '../model/index.js'
import { jsonEqual } from './delta.js'
import type { ClaimedJournalEntry } from './journal.js'

/** What today's definitions make of a journaled moment. */
export interface GuardReplay {
  readonly executionId: string
  readonly step: string
  readonly scopeKey: string | null
  /** The instant the recorded evaluation was made as of. */
  readonly asOf: string
  /** The guard results as journaled at the enforcement moment. */
  readonly recorded: GuardEvaluation
  /**
   * The same guard, re-evaluated now against the journaled state, actor and
   * instant — or `null` when today's definitions cannot address the
   * journaled (step × scope key) at all.
   */
  readonly reproduced: GuardEvaluation | null
  /** True when the two agree exactly — the definitions have not drifted for this step. */
  readonly matches: boolean
  /**
   * Why today's definitions could not address the journaled moment, when
   * they could not — the strongest form of drift. `null` when `reproduced`
   * is present.
   */
  readonly unaddressable: { readonly reason: string } | null
}

/**
 * Re-evaluate a `claimed` entry's guard against the state, actor and instant
 * the entry recorded. Only `claimed` entries carry an evaluation to
 * reproduce, and the parameter type says so — narrow a read entry with
 * `isClaimedEntry` first.
 */
export const replayGuard = (
  definition: AnyCaseType,
  entry: ClaimedJournalEntry,
): GuardReplay => {
  const identity = {
    executionId: entry.executionId,
    step: entry.step,
    scopeKey: entry.scopeKey,
    asOf: entry.asOf,
    recorded: entry.guard,
  }
  const address = addressTarget(
    definition,
    entry.state,
    entry.step,
    entry.scopeKey ?? undefined,
  )
  if (address.failure !== null) {
    return {
      ...identity,
      reproduced: null,
      matches: false,
      unaddressable: { reason: address.failure.error.message },
    }
  }
  const reproduced = evaluateTarget(address.target, {
    actor: entry.actor,
    asOf: entry.asOf,
  })
  return {
    ...identity,
    reproduced,
    matches: jsonEqual(entry.guard, reproduced),
    unaddressable: null,
  }
}

/**
 * The execution lifecycle: **claim → run → commit**.
 *
 * ```
 *   ┌── transaction ──────────────┐                    ┌── transaction ──────────────┐
 *   │ lock the case row           │                    │ lock the case row           │
 *   │ take over an expired claim  │   handler runs     │ verify the claim is ours    │
 *   │ re-evaluate the guard  ←────┼── here, outside ───┼→ write state, bump seq      │
 *   │ insert the claim (lease)    │   any transaction  │ run ctx.onCommit writes     │
 *   │ journal `claimed`           │   (heartbeating)   │ journal `completed`         │
 *   └─────────────────────────────┘                    └─────────────────────────────┘
 * ```
 *
 * Three things this shape buys, each load-bearing:
 *
 * 1. **Guards advise, handlers enforce.** The affordance a client rendered is
 *    advice; the claim's transactional re-evaluation is the enforcement
 *    moment. State may have moved (another Execution committed) or the
 *    definitions may have (a deploy — definition drift is the
 *    same race, handled the same way). A claim that fails rejects with the
 *    *current* unmet conditions and writes nothing at all.
 * 2. **No transaction spans a handler.** Handlers call the outside world;
 *    a transaction held across an escrow API call would tie up a pooled
 *    connection and the case row's lock for as long as the external service
 *    takes to answer. The lease (a `claims` row keyed by case id) carries
 *    the exclusivity instead, and a heartbeat keeps it alive.
 * 3. **A crashed handler cannot deadlock a case.** The lease expires. The
 *    next claimant takes the case over, journaling the abandonment; if the
 *    zombie ever comes back to commit, it is refused ({@link ClaimLostError})
 *    — at-least-once effects are the handler's problem to deduplicate on
 *    `ctx.executionId`, but a stale state write is the framework's to refuse.
 */

import { thrownMessage, toError } from '../errors.js'
import type { GuardEvaluation, Instant } from '../guards/index.js'
import { toIso } from '../guards/index.js'
import { registerCorrelation } from '../ingestion/correlation.js'
import type {
  AnyCaseType,
  CommitWrite,
  CorrelationRequest,
  RetryOptions,
  RetryPolicy,
  StepTarget,
} from '../model/index.js'
import {
  evaluateTarget,
  normalizeRetry,
  resolveTarget,
  validateStepInput,
} from '../model/index.js'
import type { DatabaseAccess, Dormancy } from '../store/index.js'
import { mintId, validateCaseState } from '../store/index.js'
import type { StateDelta } from './delta.js'
import { diffState } from './delta.js'
import {
  CaseBusyError,
  ClaimLostError,
  StepExecutionError,
  StepNotAvailableError,
} from './errors.js'
import type { JournalError } from './journal.js'
import type { LifecyclePort, LifecycleTx } from './port.js'
import { pgLifecyclePort } from './port.js'
import type { Timers } from './timers.js'

/** How long a claim survives without a heartbeat, and how often the heartbeat beats. */
export const DEFAULT_CLAIM_TTL_MS = 30_000
export const DEFAULT_HEARTBEAT_MS = 5_000

/** What {@link executeStep} needs from its caller (the engine supplies all of it). */
export interface ExecutionEnvironment {
  readonly db: DatabaseAccess
  /** Resolve a persisted `case_type` name to its registered definition; throws if unknown. */
  readonly caseTypeFor: (caseTypeName: string) => AnyCaseType
  readonly claimTtlMs: number
  readonly heartbeatMs: number
  /**
   * The clock. Conditions never read it; every process-side "as of now"
   * comes through here, so a test can hand the lifecycle a deterministic
   * instant instead of building fixtures around far-future dates. (Lease
   * expiry is judged by the storage adapter's own clock — see
   * {@link LifecyclePort}.)
   */
  readonly now: () => Date
  /** The process timers — retry delays and the heartbeat. See {@link Timers}. */
  readonly timers: Timers
}

/** Options for one execute call. */
export interface ExecuteOptions<TActor = unknown> {
  /** The Actor executing the step; `permits` conditions are evaluated against it. */
  readonly actor: TActor
  /** Required for a scoped step, forbidden otherwise — the element's scope key. */
  readonly scopeKey?: string
  /** The step's input, validated against its declared input schema before the handler runs. */
  readonly input?: unknown
  /** The instant to re-evaluate the guard as of; defaults to now. */
  readonly asOf?: Instant
  /** Override the claim lease for this Execution (long-running handler). */
  readonly claimTtlMs?: number
  /** Override the heartbeat interval for this Execution. */
  readonly heartbeatMs?: number
  /** Override the step's declared retry policy for this Execution. */
  readonly retry?: RetryOptions
}

/** A committed Execution — what `execute` resolves to. */
export interface ExecutionResult<TState = unknown> {
  readonly executionId: string
  readonly caseId: string
  readonly caseTypeName: string
  readonly step: string
  /** Present iff the step is scoped. */
  readonly scopeKey?: string
  /** How many attempts ran, including the one that succeeded. */
  readonly attempts: number
  /** The claim-time guard evaluation — the enforcement moment, as journaled. */
  readonly guard: GuardEvaluation
  /** The committed Case State. */
  readonly state: TState
  /** What changed, as JSON Patch. */
  readonly delta: StateDelta
  /** The case's sequence counter after this Execution. */
  readonly seq: number
  /** `end()` / `reopen()` called by the handler, if either was. */
  readonly dormancy: Dormancy | null
  /** The case's dormancy marker after this Execution (ISO-8601 UTC), `null` while active. */
  readonly endedAt: string | null
  readonly claimedAt: string
  readonly committedAt: string
}

/** A held claim plus everything the run and commit phases need from the claim transaction. */
interface Claim {
  readonly executionId: string
  readonly caseTypeName: string
  readonly definition: AnyCaseType
  readonly target: StepTarget<unknown, unknown>
  readonly state: unknown
  readonly input: unknown
  readonly asOf: string
  readonly guard: GuardEvaluation
  readonly claimedAt: string
  readonly scopeKey: string | null
  readonly actor: unknown
}

/**
 * Wraps a failure that must not be retried because retrying is guaranteed to
 * reproduce it: a handler returning a Case State its schema rejects, or a
 * commit refused because the claim is gone.
 */
class NonRetryable extends Error {
  readonly reason: unknown
  constructor(reason: unknown) {
    super(thrownMessage(reason))
    this.name = 'NonRetryable'
    this.reason = reason
  }
}

const toJournalError = (error: unknown): JournalError =>
  error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'UnknownError', message: String(error) }

/**
 * Resolve whatever claim already sits on this case, inside the claim
 * transaction (the case row is locked, so no two claimants decide this at
 * once): a live claim means the case is busy; an expired one is a crashed
 * handler's abandoned lease — journal the abandonment and take it.
 *
 * Both the `expired` entry and the takeover ride on this transaction, so a
 * claim that goes on to fail its guard rolls the abandonment record back and
 * leaves the dead lease in place. That is deliberate: an expired lease blocks
 * nothing, and the abandonment is only a fact worth recording when somebody
 * actually took the case over.
 */
const clearStaleClaim = async (
  tx: LifecycleTx,
  caseId: string,
  claimant: string,
): Promise<void> => {
  const held = await tx.currentClaim()
  if (!held) return
  if (!held.expired) {
    throw new CaseBusyError(caseId, {
      executionId: held.executionId,
      stepName: held.step,
      scopeKey: held.scopeKey,
      expiresAt: held.expiresAt,
    })
  }
  await tx.appendEntry({
    caseId,
    executionId: held.executionId,
    entry: 'expired',
    attempt: held.attempt,
    step: held.step,
    scopeKey: held.scopeKey,
    error: {
      name: 'ClaimExpiredError',
      message: `claim expired at ${held.expiresAt} with no terminal entry; case taken over by execution ${claimant}`,
    },
  })
  await tx.deleteClaim(held.executionId)
}

/**
 * What the lifecycle core needs besides storage: the clock, the timers, and
 * the lease timings. Definition resolution is the port's own (its `loadCase`
 * returns the case resolved whole), so it is no part of this interface.
 */
export interface LifecycleDeps {
  readonly now: () => Date
  readonly timers: Timers
  readonly claimTtlMs: number
  readonly heartbeatMs: number
}

/**
 * The claim: one short transaction that either takes the case and journals a
 * `claimed` entry, or writes nothing and throws the reason. Loading, guard
 * re-evaluation, and the exclusivity decision all happen under the case row's
 * lock, which is what makes "exactly one of N concurrent attempts claims"
 * true rather than likely.
 */
const claimCase = async (
  port: LifecyclePort,
  deps: LifecycleDeps,
  caseId: string,
  stepName: string,
  options: ExecuteOptions,
  executionId: string,
  claimTtlMs: number,
): Promise<Claim> =>
  port.withCaseLock(caseId, async (tx) => {
    const { definition, handle, state } = await tx.loadCase()

    await clearStaleClaim(tx, caseId, executionId)

    const target = resolveTarget(
      definition,
      state,
      stepName,
      options.scopeKey,
    ) as StepTarget<unknown, unknown>
    const scopeKey = target.binding?.key ?? null
    const input = await validateStepInput(target.step, options.input)

    const asOf = toIso(options.asOf ?? deps.now())
    const guard = evaluateTarget(target, { actor: options.actor, asOf })
    if (!guard.available)
      throw new StepNotAvailableError(caseId, stepName, scopeKey, guard)

    const { claimedAt } = await tx.insertClaim(
      executionId,
      stepName,
      scopeKey,
      claimTtlMs,
    )

    await tx.appendEntry({
      caseId,
      executionId,
      entry: 'claimed',
      attempt: 1,
      step: stepName,
      scopeKey,
      actor: options.actor,
      input,
      asOf,
      guard,
      // The Case State the guard was evaluated against, stored so audit
      // reconstruction is exact rather than approximate.
      state,
    })

    return {
      executionId,
      caseTypeName: handle.caseTypeName,
      definition,
      target,
      state,
      input,
      asOf,
      guard,
      claimedAt,
      scopeKey,
      actor: options.actor,
    }
  })

/**
 * The commit: the new Case State, the app's own writes, and the `completed`
 * journal entry, all in one transaction — or none of them.
 */
const commitExecution = async (
  port: LifecyclePort,
  claim: Claim,
  caseId: string,
  stepName: string,
  nextState: unknown,
  attempt: number,
  dormancy: Dormancy | null,
  writes: readonly CommitWrite[],
): Promise<ExecutionResult> => {
  // Both inputs are fixed before the transaction opens, so the deep diff —
  // pure CPU over the whole state document — runs before the row lock is
  // taken, not while holding it.
  const delta = diffState(claim.state, nextState)
  return port.withCaseLock(caseId, async (tx) => {
    await tx.lockCase()
    // The one check that makes a stale write impossible. Changing Case State
    // requires holding the claim, and taking the claim over replaces this row
    // — so finding our own execution id here means nothing has committed on
    // this case since we claimed it, and the state the handler computed from
    // is still current. An expired-but-undisturbed lease therefore commits
    // quite legitimately: a handler that overran its lease with no contender
    // has raced nobody.
    const holder = (await tx.currentClaim())?.executionId ?? null
    if (holder !== claim.executionId) {
      throw new ClaimLostError(caseId, claim.executionId, holder)
    }

    const updated = await tx.updateCaseState(nextState, dormancy)
    await tx.appWrites(writes)

    const entry = await tx.appendEntry({
      caseId,
      executionId: claim.executionId,
      entry: 'completed',
      attempt,
      step: stepName,
      scopeKey: claim.scopeKey,
      actor: claim.actor,
      delta,
      dormancy,
    })
    await tx.deleteClaim(claim.executionId)

    return {
      executionId: claim.executionId,
      caseId,
      caseTypeName: claim.caseTypeName,
      step: stepName,
      ...(claim.scopeKey !== null && { scopeKey: claim.scopeKey }),
      attempts: attempt,
      guard: claim.guard,
      state: nextState,
      delta,
      seq: updated.seq,
      dormancy,
      endedAt: updated.endedAt,
      claimedAt: claim.claimedAt,
      committedAt: entry.recordedAt,
    }
  })
}

/**
 * The lifecycle core: claim → run → commit against a {@link LifecyclePort}.
 *
 * {@link executeStep} binds this to the pg port; the claim state machine's
 * own tests bind it to an in-memory port instead. Same body either way — the
 * port is the only storage the lifecycle knows.
 */
export const runLifecycle = async (
  port: LifecyclePort,
  deps: LifecycleDeps,
  caseId: string,
  stepName: string,
  options: ExecuteOptions,
): Promise<ExecutionResult> => {
  const executionId = mintId('execution')
  const claimTtlMs = options.claimTtlMs ?? deps.claimTtlMs
  const heartbeatMs = options.heartbeatMs ?? deps.heartbeatMs

  const claim = await claimCase(
    port,
    deps,
    caseId,
    stepName,
    options,
    executionId,
    claimTtlMs,
  )
  const policy: RetryPolicy =
    options.retry === undefined
      ? claim.target.step.retry
      : normalizeRetry(stepName, options.retry)
  // Keep the lease alive while the handler runs. Best-effort: a failed beat
  // just lets the claim age.
  const stopHeartbeat = deps.timers.every(heartbeatMs, () => {
    void port.heartbeat(caseId, executionId, claimTtlMs)
  })

  const journal = (
    entry: 'attempt-failed' | 'failed',
    attempt: number,
    error: JournalError,
  ): Promise<unknown> =>
    port.appendEntry({
      caseId,
      executionId,
      entry,
      attempt,
      step: stepName,
      scopeKey: claim.scopeKey,
      actor: claim.actor,
      error,
    })

  try {
    for (let attempt = 1; ; attempt += 1) {
      // Per-attempt, never carried over: a failed attempt's registered writes
      // and dormancy intent are discarded with the attempt that made them.
      const writes: CommitWrite[] = []
      let dormancy: Dormancy | null = null

      const context = {
        executionId,
        caseId,
        actor: options.actor,
        input: claim.input,
        attempt,
        maxAttempts: policy.maxAttempts,
        onCommit: (write: CommitWrite) => {
          writes.push(write)
        },
        // Correlation is an ordinary commit write: the mapping
        // lands in the same transaction as the state that says the external
        // interaction was started. A scoped step's registration defaults to
        // its own element — an envelope sent for buyer #7 belongs to
        // buyer #7 unless the handler says otherwise.
        correlate: (request: CorrelationRequest) => {
          writes.push(async (tx) => {
            await registerCorrelation(tx, {
              ...request,
              caseId,
              scopeKey:
                request.scopeKey === undefined
                  ? claim.scopeKey
                  : request.scopeKey,
            })
          })
        },
        end: () => {
          dormancy = 'ended'
        },
        reopen: () => {
          dormancy = 'reopened'
        },
        ...(claim.target.binding !== null && {
          scope: claim.target.binding.element,
          scopeKey: claim.target.binding.key,
        }),
      }

      try {
        const returned = await claim.target.step.handler(claim.state, context)
        const nextState = await validateCaseState(
          claim.definition,
          returned,
          `state returned by step '${stepName}'`,
        ).catch((error) => {
          // A handler that returns state its own schema rejects is a
          // deterministic defect: the next attempt would return it again.
          throw new NonRetryable(error)
        })
        return await commitExecution(
          port,
          claim,
          caseId,
          stepName,
          nextState,
          attempt,
          dormancy,
          writes,
        )
      } catch (error) {
        const fatal =
          error instanceof NonRetryable || error instanceof ClaimLostError
        const cause = error instanceof NonRetryable ? error.reason : error
        const journalError = toJournalError(cause)

        if (!fatal && attempt < policy.maxAttempts) {
          // The attempt-failed entry and the lease's attempt counter (kept
          // current so a takeover's `expired` entry names the right attempt)
          // are independent writes — one round trip, not two.
          await Promise.all([
            journal('attempt-failed', attempt, journalError),
            port.bumpAttempt(caseId, executionId, attempt + 1),
          ])
          await deps.timers.sleep(policy.delayMs(attempt))
          continue
        }
        await Promise.all([
          journal('failed', attempt, journalError),
          port.releaseClaim(caseId, executionId),
        ])
        if (cause instanceof ClaimLostError) throw cause
        throw new StepExecutionError(
          caseId,
          executionId,
          stepName,
          claim.scopeKey,
          attempt,
          cause,
        )
      }
    }
  } finally {
    stopHeartbeat()
  }
}

/**
 * Execute one step on one case: claim it, run its handler, commit the result.
 *
 * Rejections before anything runs — {@link StepNotAvailableError} (the guard
 * said no), {@link CaseBusyError} (another Execution holds the case),
 * `UnknownStepError` / `ScopeKeyError` (bad address) — write nothing, not
 * even a journal entry: the journal records Executions, and a refused claim
 * never became one.
 *
 * A handler that throws is retried per the step's retry policy (same
 * `executionId`, same claim, same starting state — nothing else can have
 * moved it), each failure journaled as `attempt-failed`. When the attempts
 * run out, a `failed` entry is journaled, the case is released, and
 * {@link StepExecutionError} is thrown.
 *
 * This is {@link runLifecycle} bound to the pg port.
 */
export const executeStep = async (
  env: ExecutionEnvironment,
  caseId: string,
  stepName: string,
  options: ExecuteOptions,
): Promise<ExecutionResult> =>
  runLifecycle(
    pgLifecyclePort(env.db, env.caseTypeFor),
    env,
    caseId,
    stepName,
    options,
  )

// ── The system runner ──────────────────────────────────────────────────────
//
// `docs/architecture.md` draws a lenient/loud pair wherever the same need
// recurs: loud for an addressed request, lenient for a sweep. For running a
// step, loud is `Engine.execute` — it propagates, because somebody named a
// case and a step and is owed the refusal. The lenient half is here: every
// sweep (ingestion, migration) runs steps *as the system*, with no caller
// an exception could reach, and each would otherwise wrap the lifecycle in
// its own try/catch classification. `runAsSystem` is the lenient half
// stated once — a total, named outcome the sweeps filter, the same way
// listings are filters over `selectTargets`.

/** A committed system run. */
export interface SystemCommit {
  readonly outcome: 'committed'
  readonly result: ExecutionResult
}

/**
 * A system run that did not commit, carrying whatever the lifecycle threw —
 * a Refusal keeps its identity (its code is the answer, projectable by
 * `isAffordanceError`, never re-derived from a class), a bug or an
 * infrastructure failure passes through as itself. One settled variant, not
 * a refused/failed pair: no sweep ever treated the halves differently, and a
 * discriminant nobody branches on is interface without behaviour.
 */
export interface SystemSettled {
  readonly outcome: 'settled'
  readonly error: Error
}

/** How a step the system ran ended — total over every way the lifecycle can answer. */
export type SystemRunOutcome = SystemCommit | SystemSettled

/** What a sweep may ask for beyond the lifecycle's own execute options. */
export interface SystemRunOptions extends ExecuteOptions {
  /**
   * Run against this definition instead of the registry's — how a migration
   * executes its synthetic `migrate:<name>` step. First-class here so no
   * sweep has to smuggle a definition in by rewriting `caseTypeFor`.
   */
  readonly definition?: AnyCaseType
}

/**
 * Turn a throw into the settled value. No classification happens here —
 * "is this a Refusal" is asked exactly once, where a consumer needs the
 * distinction (ingestion's `classifyDeadLetter`), via `isAffordanceError`.
 */
export const settleSystemRun = (error: unknown): SystemSettled => ({
  outcome: 'settled',
  error: toError(error),
})

/**
 * Run one step on behalf of the system and say how it ended. Never throws:
 * a sweep ranges over many cases with no caller waiting on any single one,
 * so the answer is a value — committed (with the result) or settled (with
 * the error) — and each sweep decides what its kind of sweep does with it.
 */
export const runAsSystem = async (
  env: ExecutionEnvironment,
  caseId: string,
  stepName: string,
  options: SystemRunOptions,
): Promise<SystemRunOutcome> => {
  const { definition, ...lifecycleOptions } = options
  const environment: ExecutionEnvironment =
    definition === undefined ? env : { ...env, caseTypeFor: () => definition }
  try {
    return {
      outcome: 'committed',
      result: await executeStep(
        environment,
        caseId,
        stepName,
        lifecycleOptions,
      ),
    }
  } catch (error) {
    return settleSystemRun(error)
  }
}

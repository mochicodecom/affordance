/**
 * The lifecycle port: what claim → run → commit asks of storage, and nothing
 * else.
 *
 * An **internal** seam, deliberately. `docs/architecture.md` stands:
 * Postgres is a hard dependency and there is no public storage-adapter
 * abstraction — an app never sees this interface. It exists because the
 * claim state machine (busy vs. takeover, the holder check, retry
 * classification, per-attempt write discard) upholds more always-true
 * rules in one place than anything else in the package, and testing those
 * rules means staging precise situations — an expired lease, a takeover
 * mid-run — that should not require a running database. Two adapters make
 * the seam real: the pg one below for production, and the in-memory one in
 * `test/execution/memory-port.ts` for the tests.
 *
 * The shape keeps the lifecycle's transactional structure explicit:
 * {@link LifecyclePort.withCaseLock} is "one short transaction holding the
 * case row's lock" — the claim and the commit are each exactly one of those
 * — and everything else deliberately runs outside any transaction, because
 * a handler is running and the lease, not a lock, carries exclusivity.
 */

import type { CommitWrite } from '../model/index.js'
import type {
  CaseTypeLookup,
  DatabaseAccess,
  Dormancy,
  ResolvedCase,
} from '../store/index.js'
import {
  CaseNotFoundError,
  FRAMEWORK_SCHEMA,
  queryableOf,
  resolveCaseForUpdate,
  updateCaseState,
} from '../store/index.js'
import type { JournalEntry, JournalEntryInput } from './journal.js'
import { appendEntry } from './journal.js'
import { withTransaction } from './transaction.js'

const CASES = `${FRAMEWORK_SCHEMA}.cases`
const CLAIMS = `${FRAMEWORK_SCHEMA}.claims`

/** `now() + <ms>` as a SQL expression against a bound millisecond parameter. */
const expiryExpression = (parameter: string): string =>
  `now() + (${parameter}::double precision * interval '1 millisecond')`

/** The claim sitting on a case, as the lifecycle needs to judge it. */
export interface HeldClaim {
  readonly executionId: string
  readonly step: string
  readonly scopeKey: string | null
  readonly attempt: number
  readonly expiresAt: string
  /** True when the lease has lapsed — the next claimant may take the case over. */
  readonly expired: boolean
}

/** What the lifecycle asks of storage inside one case-locked transaction. */
export interface LifecycleTx {
  /**
   * The case, loaded under its lock and resolved whole — definition looked
   * up, stored state validated against its schema — the serialization
   * point. Returning the resolved triple rather than a raw row is what
   * keeps "load, resolve, validate, in that order" spelled once (in
   * `store/resolve.ts`) instead of re-derived by each adapter's caller.
   */
  readonly loadCase: () => Promise<ResolvedCase>
  /**
   * Take the case row's lock without interpreting the row — the commit's
   * serialization point. The commit already holds everything it computed at
   * the claim; what it needs from the row is only the lock (and proof the
   * row exists), never a second read-and-validate of the state document.
   */
  readonly lockCase: () => Promise<void>
  /** The claim on the case, `null` when nobody holds it. */
  readonly currentClaim: () => Promise<HeldClaim | null>
  readonly insertClaim: (
    executionId: string,
    step: string,
    scopeKey: string | null,
    ttlMs: number,
  ) => Promise<{ readonly claimedAt: string }>
  readonly deleteClaim: (executionId: string) => Promise<void>
  readonly appendEntry: (input: JournalEntryInput) => Promise<JournalEntry>
  /** Write the next Case State, bump `seq`, apply the dormancy transition. */
  readonly updateCaseState: (
    state: unknown,
    dormancy: Dormancy | null,
  ) => Promise<{ readonly seq: number; readonly endedAt: string | null }>
  /** The app's own `ctx.onCommit` writes, riding the same transaction. */
  readonly appWrites: (writes: readonly CommitWrite[]) => Promise<void>
}

/** The verbs the execution lifecycle needs from storage. */
export interface LifecyclePort {
  /** One short transaction holding the case row's lock — a claim or a commit. */
  readonly withCaseLock: <T>(
    caseId: string,
    fn: (tx: LifecycleTx) => Promise<T>,
  ) => Promise<T>
  /** Journal outside any transaction — `attempt-failed` / `failed` entries. */
  readonly appendEntry: (input: JournalEntryInput) => Promise<JournalEntry>
  /** Refresh the lease. Best-effort: a failed beat just lets the claim age. */
  readonly heartbeat: (
    caseId: string,
    executionId: string,
    ttlMs: number,
  ) => Promise<void>
  /** Keep the lease's attempt counter current across retries. Best-effort. */
  readonly bumpAttempt: (
    caseId: string,
    executionId: string,
    attempt: number,
  ) => Promise<void>
  /** Delete this Execution's claim — scoped to `executionId`, so releasing a lease we no longer hold is a no-op. */
  readonly releaseClaim: (caseId: string, executionId: string) => Promise<void>
}

type ClaimRow = {
  execution_id: string
  step: string
  scope_key: string | null
  attempt: number
  expires_at: Date
  expired: boolean
}

/** The production adapter: each port verb implemented as SQL over the claims, journal and cases tables. */
export const pgLifecyclePort = (
  db: DatabaseAccess,
  caseTypeFor: CaseTypeLookup,
): LifecyclePort => {
  // The lease verbs are single self-contained statements; only the
  // case-locked transactions care which arm of the access the caller brought.
  const q = queryableOf(db)
  return {
    withCaseLock: (caseId, fn) =>
      withTransaction(db, (tx) =>
        fn({
          loadCase: () => resolveCaseForUpdate(tx, caseTypeFor, caseId),
          lockCase: async () => {
            const { rows } = await tx.query<{ id: string }>(
              `select id from ${CASES} where id = $1 for update`,
              [caseId],
            )
            if (rows.length === 0) throw new CaseNotFoundError(caseId)
          },
          currentClaim: async () => {
            const { rows } = await tx.query<ClaimRow>(
              `select execution_id, step, scope_key, attempt, expires_at, expires_at <= now() as expired
             from ${CLAIMS} where case_id = $1`,
              [caseId],
            )
            const row = rows[0]
            if (!row) return null
            return {
              executionId: row.execution_id,
              step: row.step,
              scopeKey: row.scope_key,
              attempt: row.attempt,
              expiresAt: row.expires_at.toISOString(),
              expired: row.expired,
            }
          },
          insertClaim: async (executionId, step, scopeKey, ttlMs) => {
            const { rows } = await tx.query<{ claimed_at: Date }>(
              `insert into ${CLAIMS} (case_id, execution_id, step, scope_key, expires_at)
             values ($1, $2, $3, $4, ${expiryExpression('$5')})
             returning claimed_at`,
              [caseId, executionId, step, scopeKey, ttlMs],
            )
            return {
              claimedAt:
                rows[0]?.claimed_at.toISOString() ?? new Date().toISOString(),
            }
          },
          deleteClaim: async (executionId) => {
            await tx.query(
              `delete from ${CLAIMS} where case_id = $1 and execution_id = $2`,
              [caseId, executionId],
            )
          },
          appendEntry: (input) => appendEntry(tx, input),
          updateCaseState: async (state, dormancy) => {
            const updated = await updateCaseState(tx, caseId, state, dormancy)
            return {
              seq: updated.seq,
              endedAt:
                updated.endedAt === null ? null : updated.endedAt.toISOString(),
            }
          },
          appWrites: async (writes) => {
            for (const write of writes) await write(tx)
          },
        }),
      ),
    appendEntry: (input) => appendEntry(q, input),
    heartbeat: async (caseId, executionId, ttlMs) => {
      await q
        .query(
          `update ${CLAIMS}
           set heartbeat_at = now(), expires_at = ${expiryExpression('$3')}
           where case_id = $1 and execution_id = $2`,
          [caseId, executionId, ttlMs],
        )
        .catch(() => undefined)
    },
    bumpAttempt: async (caseId, executionId, attempt) => {
      await q
        .query(
          `update ${CLAIMS} set attempt = $3 where case_id = $1 and execution_id = $2`,
          [caseId, executionId, attempt],
        )
        .catch(() => undefined)
    },
    releaseClaim: async (caseId, executionId) => {
      await q
        .query(
          `delete from ${CLAIMS} where case_id = $1 and execution_id = $2`,
          [caseId, executionId],
        )
        .catch(() => undefined)
    },
  }
}

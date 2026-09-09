import { CaseNotFoundError } from '@affordance/core'
import type { LifecyclePort } from '@affordance/core/storage'
import { FRAMEWORK_SCHEMA } from './bootstrap.js'
import { registerCorrelation } from './correlation.js'
import { appendEntry } from './journal.js'
import type { DatabaseAccess, Transaction } from './queryable.js'
import { queryableOf } from './queryable.js'
import { selectCaseUntyped, updateCaseState } from './store.js'
import { withTransaction } from './transaction.js'

const CASES = `${FRAMEWORK_SCHEMA}.cases`
const CLAIMS = `${FRAMEWORK_SCHEMA}.claims`
const expiryExpression = (parameter: string): string =>
  `now() + (${parameter}::double precision * interval '1 millisecond')`

type ClaimRow = {
  execution_id: string
  step: string
  scope_key: string | null
  attempt: number
  expires_at: Date
  expired: boolean
}

/** The production adapter: each port verb implemented as SQL over the claims, journal and cases tables. */
export const pgLifecyclePort = <TCommit>(
  db: DatabaseAccess,
  commitContext: (tx: Transaction) => TCommit,
): LifecyclePort<TCommit> => {
  // The lease verbs are single self-contained statements; only the
  // case-locked transactions care which arm of the access the caller brought.
  const q = queryableOf(db)
  return {
    withCase: (caseId, fn) =>
      withTransaction(db, async (tx) => {
        // Establish serialization before invoking any domain decisions or app writes.
        const { rows } = await tx.query<{ id: string }>(
          `select id from ${CASES} where id = $1 for update`,
          [caseId],
        )
        if (rows.length === 0) throw new CaseNotFoundError(caseId)
        return fn({
          loadCase: () => selectCaseUntyped(tx, caseId),
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
          applyEffects: async (effects) => {
            const context = commitContext(tx)
            for (const effect of effects) {
              if (effect.kind === 'write') await effect.write(context)
              else await registerCorrelation(tx, effect.registration)
            }
          },
        })
      }),
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

import {
  ExecutionNotResolvableError,
  LaunchBlockedError,
  type LaunchedExecution,
  type LaunchPort,
} from '@affordance/core'
import type { DatabaseAccess, Queryable } from './queryable.js'
import { queryableOf } from './queryable.js'
import { withTransaction } from './transaction.js'

type Row = {
  execution_id: string
  case_id: string
  step: string
  scope_key: string | null
  actor: string | null
  status: LaunchedExecution['status']
  claimed_at: Date
  started_at: Date | null
  expires_at: Date
  completed_at: Date | null
  journal: LaunchedExecution['journal']
  reason: LaunchedExecution['reason']
  resolution: LaunchedExecution['resolution']
  expired: boolean
}
const project = (r: Row): LaunchedExecution => ({
  executionId: r.execution_id,
  caseId: r.case_id,
  step: r.step,
  scopeKey: r.scope_key,
  actor: r.actor,
  status: r.status === 'running' && r.expired ? 'unresolved' : r.status,
  claimedAt: r.claimed_at.toISOString(),
  startedAt: r.started_at?.toISOString() ?? null,
  expiresAt: r.expires_at.toISOString(),
  completedAt: r.completed_at?.toISOString() ?? null,
  journal: r.journal,
  reason: r.status === 'running' && r.expired ? 'expired' : r.reason,
  resolution: r.resolution,
})
const get = async (q: Queryable, id: string) => {
  const { rows } = await q.query<Row>(
    'select *, expires_at <= clock_timestamp() as expired from affordance.launched_executions where execution_id=$1',
    [id],
  )
  return rows[0] ? project(rows[0]) : null
}
export const createLaunchPort = (db: DatabaseAccess): LaunchPort => {
  const q = queryableOf(db)
  const transition = <T>(id: string, fn: (tx: Queryable) => Promise<T>) =>
    withTransaction(db, async (tx) => {
      // Evaluate time only after any competing transition has released the row.
      await tx.query(
        'select execution_id from affordance.launched_executions where execution_id=$1 for update',
        [id],
      )
      return fn(tx)
    })
  return {
    async claim(c) {
      const result = await q.query(
        `insert into affordance.launched_executions
        (execution_id,case_id,step,scope_key,actor,status,expires_at,reason)
        values ($1,$2,$3,$4,$5,'unresolved',clock_timestamp()+$6::double precision*interval '1 millisecond','startup')
        on conflict (case_id) where status in ('running','unresolved') do nothing`,
        [c.executionId, c.caseId, c.step, c.scopeKey, c.actor, c.leaseMs],
      )
      if (result.rowCount !== 1) throw new LaunchBlockedError(c.caseId)
    },
    start: (id) =>
      transition(
        id,
        async (tx) =>
          (
            await tx.query(
              `update affordance.launched_executions
      set status='running', started_at=clock_timestamp(), reason=null
      where execution_id=$1 and status='unresolved' and reason='startup' and started_at is null and expires_at>clock_timestamp()`,
              [id],
            )
          ).rowCount === 1,
      ),
    release: (id) =>
      transition(id, async (tx) => {
        await tx.query(
          "delete from affordance.launched_executions where execution_id=$1 and status='unresolved' and reason='startup' and started_at is null",
          [id],
        )
      }),
    complete: (id, journal) =>
      transition(
        id,
        async (tx) =>
          (
            await tx.query(
              `update affordance.launched_executions
      set status='completed',completed_at=clock_timestamp(),journal=$2::jsonb,reason=null
      where execution_id=$1 and status='running' and expires_at>clock_timestamp()`,
              [id, JSON.stringify(journal)],
            )
          ).rowCount === 1,
      ),
    fail: (id, reason) =>
      transition(id, async (tx) => {
        await tx.query(
          "update affordance.launched_executions set status='unresolved',reason=$2 where execution_id=$1 and status='running'",
          [id, reason],
        )
      }),
    get: (id) => get(q, id),
    resolve: (id, actor, reason) =>
      transition(id, async (tx) => {
        const result = await tx.query(
          `update affordance.launched_executions set status='resolved',
        resolution=jsonb_build_object('actor',$2::text,'reason',$3::text,'resolvedAt',clock_timestamp())
        where execution_id=$1 and (status='unresolved' or (status='running' and expires_at<=clock_timestamp()))`,
          [id, actor, reason],
        )
        if (result.rowCount !== 1) throw new ExecutionNotResolvableError(id)
        const record = await get(tx, id)
        if (!record) throw new Error('resolved execution disappeared')
        return record
      }),
  }
}

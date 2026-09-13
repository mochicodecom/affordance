import type { CaseHandle, Dormancy } from '@affordance/core'
import { CaseNotFoundError } from '@affordance/core'
import { mintId } from '@affordance/core/storage'
import type { Queryable, Transaction } from './queryable.js'
export const CASE_COLUMNS =
  'id, case_type, reference, seq, ended_at, created_at, updated_at'
export interface CaseRow {
  id: string
  case_type: string
  reference: string
  seq: string | number
  ended_at: Date | null
  created_at: Date
  updated_at: Date
}
export const toHandle = <S>(row: CaseRow, state: S): CaseHandle<S> => ({
  id: row.id,
  reference: row.reference,
  caseTypeName: row.case_type,
  state,
  seq: Number(row.seq),
  endedAt: row.ended_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})
export const selectMetadata = async (
  q: Queryable,
  id: string,
  lock = false,
): Promise<CaseRow> => {
  const { rows } = await q.query<CaseRow>(
    `select ${CASE_COLUMNS} from affordance.cases where id = $1${lock ? ' for update' : ''}`,
    [id],
  )
  if (!rows[0]) throw new CaseNotFoundError(id)
  return rows[0]
}
export const attachMetadata = async (
  tx: Transaction,
  name: string,
  reference: string,
): Promise<CaseRow> => {
  const { rows } = await tx.query<CaseRow>(
    `insert into affordance.cases (id, case_type, reference) values ($1,$2,$3)
    on conflict (case_type, reference) do update set reference = excluded.reference returning ${CASE_COLUMNS}`,
    [mintId('case'), name, reference],
  )
  if (!rows[0]) throw new Error('attachment returned no row')
  return rows[0]
}
export const advanceCase = async (
  tx: Transaction,
  id: string,
  dormancy: Dormancy | null,
): Promise<CaseRow> => {
  const { rows } = await tx.query<CaseRow>(
    `update affordance.cases set seq = seq + 1, updated_at = now(),
    ended_at = case when $2::text = 'ended' then now() when $2::text = 'reopened' then null else ended_at end
    where id = $1 returning ${CASE_COLUMNS}`,
    [id, dormancy],
  )
  if (!rows[0]) throw new CaseNotFoundError(id)
  return rows[0]
}

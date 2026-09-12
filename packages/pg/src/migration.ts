import type { MigrationOptions } from '@affordance/core'
import type {
  MigrationCandidate,
  MigrationPage,
} from '@affordance/core/storage'
import { deserializeValue, SerializationError } from '@affordance/core/storage'
import { FRAMEWORK_SCHEMA } from './bootstrap.js'
import type { Queryable } from './queryable.js'
import { sqlWhere } from './sql.js'

const CASES = `${FRAMEWORK_SCHEMA}.cases`
const JOURNAL = `${FRAMEWORK_SCHEMA}.journal`
/** Case ids of this type that do not yet carry the migration's marker, oldest first. */
export const findCandidates = async (
  db: Queryable,
  caseTypeName: string,
  marker: string,
  options: MigrationOptions,
  afterId: string | null,
  batchSize: number,
): Promise<MigrationPage> => {
  const { conditions, values, bind, where } = sqlWhere(
    [
      `c.case_type = $1`,
      // The marker: a completed Execution of this migration on this case. The
      // journal is the record of what has happened, so it is also the record of
      // what has already been migrated — no bookkeeping table, no state flag.
      `not exists (
       select 1 from ${JOURNAL} j
       where j.case_id = c.id and j.step = $2 and j.entry = 'completed'
     )`,
    ],
    [caseTypeName, marker],
  )
  if (options.includeEnded !== true) conditions.push(`c.ended_at is null`)
  if (options.caseIds !== undefined)
    conditions.push(`c.id = any(${bind(options.caseIds)}::text[])`)
  if (afterId !== null) conditions.push(`c.id > ${bind(afterId)}`)

  const { rows } = await db.query<{ id: string; state: unknown }>(
    `select c.id, c.state from ${CASES} c
     where ${where()}
     order by c.id asc
     limit ${bind(batchSize)}`,
    values,
  )
  return {
    cases: rows.map((row): MigrationCandidate => {
      try {
        return {
          id: row.id,
          state: deserializeValue(row.state, `case '${row.id}' state`),
        }
      } catch (error) {
        if (!(error instanceof SerializationError)) throw error
        return { id: row.id, error }
      }
    }),
    nextCursor: rows.length === batchSize ? (rows.at(-1)?.id ?? null) : null,
  }
}

/** Whether one case already carries a migration's marker. */
export const hasCompleted = async (
  db: Queryable,
  caseId: string,
  marker: string,
): Promise<boolean> => {
  const { rows } = await db.query<{ one: number }>(
    `select 1 as one from ${JOURNAL}
     where case_id = $1 and step = $2 and entry = 'completed' limit 1`,
    [caseId, marker],
  )
  return rows.length > 0
}

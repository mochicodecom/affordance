import { CASE_TABLES, FRAMEWORK_SCHEMA } from './bootstrap.js'
import type { DatabaseAccess } from './queryable.js'
import { withTransaction } from './transaction.js'

/** Destructive administrative cleanup, intended for disposable demo/test cases.
 * Locks the case before removing related records; all deletions commit together.
 */
export const deleteCase = (db: DatabaseAccess, caseId: string): Promise<void> =>
  withTransaction(db, async (tx) => {
    await tx.query(
      `select id from ${FRAMEWORK_SCHEMA}.cases where id = $1 for update`,
      [caseId],
    )
    for (const { table, caseColumn } of CASE_TABLES) {
      await tx.query(
        `delete from ${FRAMEWORK_SCHEMA}.${table} where ${caseColumn} = $1`,
        [caseId],
      )
    }
  })

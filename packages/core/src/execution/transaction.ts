/**
 * The transaction seam.
 *
 * The claim and the commit are each one short transaction; the handler runs
 * between them, outside both — so no transaction is ever held open
 * across a handler's external calls. `withTransaction` is how the execution
 * lifecycle gets one, and it is also what a handler's `ctx.onCommit` writes
 * ride along inside.
 */

import type { DatabaseAccess, Queryable, Transaction } from '../store/index.js'

/**
 * Run `fn` inside a transaction and hand it the handle to use — a checked-out
 * client when the caller brought a pool, the client itself when they brought
 * one (issuing `begin` on a *pool* would put each statement on a different
 * connection, so the distinction is not cosmetic). Which case applies is the
 * caller's declaration — {@link DatabaseAccess} — never sniffed from the
 * object.
 *
 * Commits on return, rolls back on throw, and always releases what it
 * checked out. A rollback that itself fails is swallowed: the original error
 * is what the caller needs, and a connection too broken to roll back is
 * discarded by the pool anyway.
 */
export const withTransaction = async <T>(
  db: DatabaseAccess,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> => {
  if (!('pool' in db)) return runTransaction(db.client, fn)
  const client = await db.pool.connect()
  try {
    return await runTransaction(client, fn)
  } finally {
    client.release()
  }
}

const runTransaction = async <T>(
  handle: Queryable,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> => {
  // The one place the brand is applied: past the `begin` below, this handle
  // really is inside a transaction.
  const tx = handle as Transaction
  await tx.query('begin')
  try {
    const result = await fn(tx)
    await tx.query('commit')
    return result
  } catch (error) {
    await tx.query('rollback').catch(() => undefined)
    throw error
  }
}

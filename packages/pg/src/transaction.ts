import type { DatabaseAccess, Queryable, Transaction } from './queryable.js'
import { withClient } from './queryable.js'
/** The callback finished, but COMMIT was not acknowledged. Never blindly retry. */
export class CommitOutcomeUnknownError extends Error {
  constructor(options: ErrorOptions) {
    super('Database commit outcome is unknown', options)
    this.name = 'CommitOutcomeUnknownError'
  }
}
export const withTransaction = async <T>(
  db: DatabaseAccess,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> => {
  if (!('pool' in db))
    return withClient(db.client, () => runTransaction(db.client, fn))
  const client = await db.pool.connect()
  let discard = false
  try {
    return await runTransaction(client, fn)
  } catch (error) {
    discard = true
    throw error
  } finally {
    client.release(discard)
  }
}
const runTransaction = async <T>(
  handle: Queryable,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> => {
  // A waiting parent lock must be followed by a fresh snapshot, even when
  // the connection's default isolation level is repeatable read.
  await handle.query('begin isolation level read committed')
  let active = true
  const tx = {
    query: (...args: Parameters<Queryable['query']>) => {
      if (!active) return Promise.reject(new Error('transaction is closed'))
      return handle.query(...args)
    },
  } as Transaction
  let result: T
  try {
    result = await fn(tx)
  } catch (error) {
    active = false
    await handle.query('rollback').catch(() => undefined)
    throw error
  }
  active = false
  try {
    await handle.query('commit')
  } catch (cause) {
    await handle.query('rollback').catch(() => undefined)
    if (isConfirmedCommitRejection(cause)) throw cause
    throw new CommitOutcomeUnknownError({ cause })
  }
  return result
}

/** Affirmative server errors that abort COMMIT. Connection loss and SQLSTATE
 * 40003 (statement completion unknown) deliberately remain indeterminate. */
const isConfirmedCommitRejection = (error: unknown): boolean => {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('severity' in error) ||
    error.severity !== 'ERROR' ||
    !('code' in error) ||
    typeof error.code !== 'string'
  )
    return false
  return (
    /^23[0-9A-Z]{3}$/.test(error.code) ||
    error.code === '40001' ||
    error.code === '40P01'
  )
}

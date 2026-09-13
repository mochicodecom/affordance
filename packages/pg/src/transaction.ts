import type { DatabaseAccess, Queryable, Transaction } from './queryable.js'
import { withClient } from './queryable.js'
/** The callback finished, but COMMIT was not acknowledged. Never blindly retry. */
export class CommitOutcomeUnknownError extends Error {
  constructor(options: ErrorOptions) {
    super('Database commit outcome is unknown', options)
    this.name = 'CommitOutcomeUnknownError'
  }
}
/** PostgreSQL acknowledged that the transaction rolled back instead of committing. */
export class TransactionRolledBackError extends Error {
  constructor() {
    super('Database transaction rolled back instead of committing')
    this.name = 'TransactionRolledBackError'
  }
}
export const withTransaction = async <T>(
  db: DatabaseAccess,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> => {
  if (!('pool' in db))
    return withClient(db.client, () => runTransaction(db.client, fn))
  const client = await db.pool.connect()
  // Keep the connection only after the transaction confirms it can be reused.
  let discard = true
  try {
    return await runTransaction(client, fn, () => {
      discard = false
    })
  } finally {
    client.release(discard)
  }
}
const runTransaction = async <T>(
  handle: Queryable,
  fn: (tx: Transaction) => Promise<T>,
  onReusable: () => void = () => {},
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
    if (await rollback(handle)) onReusable()
    throw error
  }
  active = false
  let command: string
  try {
    const acknowledgment = await handle.query('commit')
    command = acknowledgment.command
  } catch (cause) {
    const rolledBack = await rollback(handle)
    if (isConfirmedCommitRejection(cause)) {
      if (rolledBack) onReusable()
      throw cause
    }
    throw new CommitOutcomeUnknownError({ cause })
  }
  if (command === 'ROLLBACK') {
    onReusable()
    throw new TransactionRolledBackError()
  }
  if (command !== 'COMMIT')
    throw new CommitOutcomeUnknownError({
      cause: new Error(`Unexpected COMMIT acknowledgment: ${command}`),
    })
  onReusable()
  return result
}

/** A failed or unrecognized cleanup acknowledgment leaves the connection unusable.
 * Preserve the operation's original error when cleanup also fails. */
const rollback = async (handle: Queryable): Promise<boolean> => {
  try {
    return (await handle.query('rollback')).command === 'ROLLBACK'
  } catch {
    return false
  }
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

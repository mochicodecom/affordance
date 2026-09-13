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
  await handle.query('begin')
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
    throw new CommitOutcomeUnknownError({ cause })
  }
  return result
}

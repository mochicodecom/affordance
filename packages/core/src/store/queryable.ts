import type { QueryResult, QueryResultRow } from 'pg'

/**
 * Minimal query surface satisfied by pg.Pool, pg.Client, and pg.PoolClient.
 *
 * Every store internal takes a Queryable rather than a Pool so a future
 * caller can run case-store queries on an existing client/transaction —
 * the shared-transaction seam (spec §Mechanics/Persistence: handlers may
 * join the framework transaction so app-table writes commit atomically
 * with case state).
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>
}

/**
 * A pooled connection source: `connect()` checks out a client that must be
 * released. `pg.Pool` satisfies this structurally, and so does any
 * multiplexing wrapper (an instrumented pool, a proxy) that declares
 * checkout the same way.
 */
export interface PoolLike extends Queryable {
  connect(): Promise<Queryable & { release(): void }>
}

/**
 * The database as the engine's caller supplies it. The union states, in the
 * type, the one fact a transaction must know: whether `begin` needs a
 * checked-out connection first. A pool multiplexes — issuing `begin` on it
 * would put each statement on a different connection — so `pool` promises
 * checkout via `connect()`, and `client` asserts a connection dedicated to
 * the engine, safe to run a transaction on directly. The caller declares
 * which they have; nothing downstream sniffs the object to guess.
 */
export type DatabaseAccess =
  | { readonly pool: PoolLike }
  | { readonly client: Queryable }

/**
 * The plain query surface of either arm — what a single self-contained
 * statement (a journal read, a heartbeat) runs against, where pool vs.
 * client makes no difference.
 */
export const queryableOf = (db: DatabaseAccess): Queryable =>
  'pool' in db ? db.pool : db.client

declare const transactionBrand: unique symbol

/**
 * A {@link Queryable} known to be inside an open transaction — the handle
 * `withTransaction` passes to its callback, and the only place the brand is
 * ever applied.
 *
 * Some operations are meaningless (or silently wrong) against a pool: a
 * `select … for update` whose lock vanishes with the statement, a write
 * that must commit in the same transaction as the state it accompanies.
 * Those take a `Transaction`, so "pass the transaction handle, not a pool"
 * is a compile error rather than a sentence a caller has to have read.
 */
export interface Transaction extends Queryable {
  readonly [transactionBrand]: true
}

import { randomUUID } from 'node:crypto'
import { createBackgroundRuntime, createEngine } from '@affordance/core'
import { testPool } from '@affordance/testkit'
import type { QueryResultRow } from 'pg'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  type Definition,
  type Domain,
  domainContract,
  domainDefinition,
} from '../../core/test/storage/domain-contract.js'
import {
  createPgStorage,
  type PoolLike,
  type Queryable,
  TransactionRolledBackError,
  withTransaction,
} from '../src/index.js'

const pool = testPool({ max: 12 })
const singlePool = testPool({ max: 1 })
beforeAll(async () => {
  await pool.query(`create table if not exists contract_purchases (id text primary key, count integer not null);
    create table if not exists contract_buyers (purchase_id text references contract_purchases(id), id text, name text, primary key(purchase_id,id));`)
})
const load = async (q: Queryable, id: string): Promise<Domain> => {
  const { rows } = await q.query<{ count: number; buyers: Domain['buyers'] }>(
    `select count,
    (select json_agg(json_build_object('id',b.id,'name',b.name) order by b.id) from contract_buyers b where b.purchase_id=p.id) as buyers
    from contract_purchases p where p.id=$1`,
    [id],
  )
  if (!rows[0]) throw new Error('missing domain')
  return rows[0]
}
const fixture = async (
  definition: Definition,
  connectionPool: PoolLike = pool,
) => {
  const reference = randomUUID()
  await pool.query('insert into contract_purchases values ($1,0)', [reference])
  await pool.query(
    "insert into contract_buyers values ($1,'a','Alice'),($1,'b','Bob')",
    [reference],
  )
  const storage = createPgStorage({ db: { pool: connectionPool } })
  const binding = storage.bindCase(definition, { load })
  const runtime = createBackgroundRuntime()
  const engine = createEngine({
    storage,
    caseTypes: [binding],
    launch: { runtime, leaseMs: 60_000 },
  })
  const { id } = await engine.attachCase(definition.name, { reference })
  return {
    engine,
    storage,
    binding,
    id,
    reference,
    drain: () => runtime.drain(),
    externalCount: async (count: number) => {
      await pool.query('update contract_purchases set count=$2 where id=$1', [
        reference,
        count,
      ])
    },
  }
}
domainContract('postgres', fixture)
describe('commit acknowledgment and transaction lifetime', () => {
  it('rejects an attachment result when a caught SQL error makes COMMIT roll back', async () => {
    const f = await fixture(domainDefinition(randomUUID(), async () => {}))
    const reference = randomUUID()
    const before = await singlePool.query('select pg_backend_pid() as pid')
    await expect(
      withTransaction({ pool: singlePool }, async (tx) => {
        await tx.query('insert into contract_purchases values ($1,42)', [
          reference,
        ])
        await tx.query("insert into contract_buyers values ($1,'a','Alice')", [
          reference,
        ])
        const attached = await f.storage.attachCase(tx, f.binding, reference)
        // A caller may catch an optional write failure; PostgreSQL still aborts
        // the transaction, and COMMIT acknowledges ROLLBACK without throwing.
        await tx
          .query('insert into contract_purchases values ($1,42)', [reference])
          .catch(() => {})
        return attached
      }),
    ).rejects.toBeInstanceOf(TransactionRolledBackError)
    expect(
      (await singlePool.query('select pg_backend_pid() as pid')).rows[0].pid,
    ).toBe(before.rows[0].pid)
    expect(
      (
        await pool.query('select id from contract_purchases where id=$1', [
          reference,
        ])
      ).rows,
    ).toEqual([])
    expect(
      (
        await pool.query('select id from affordance.cases where reference=$1', [
          reference,
        ])
      ).rows,
    ).toEqual([])
  })
  it('reports a deferred constraint rejection at COMMIT as a known rollback', async () => {
    const before = await singlePool.query('select pg_backend_pid() as pid')
    await expect(
      withTransaction({ pool: singlePool }, async (tx) => {
        await tx.query(
          'create temporary table deferred_failure (n integer unique deferrable initially deferred) on commit drop',
        )
        await tx.query('insert into deferred_failure values (1),(1)')
      }),
    ).rejects.toMatchObject({ code: '23505', severity: 'ERROR' })
    expect(
      (await singlePool.query('select pg_backend_pid() as pid')).rows[0].pid,
    ).toBe(before.rows[0].pid)
  })
  it.each(['begin', 'rollback-error', 'rollback-unknown'] as const)(
    'discards a connection after %s fails to establish a reusable transaction state',
    async (fault) => {
      const original = new Error('application failed')
      const transport = new Error('connection failed')
      const released: boolean[] = []
      const faulty: PoolLike = {
        query: singlePool.query.bind(singlePool),
        connect: async () => {
          const client = await singlePool.connect()
          return {
            query: async <R extends QueryResultRow>(
              text: string,
              values?: unknown[],
            ) => {
              if (fault === 'begin' && text.startsWith('begin')) throw transport
              if (fault === 'rollback-error' && text === 'rollback')
                throw transport
              const result = await client.query<R>(text, values)
              return fault === 'rollback-unknown' && text === 'rollback'
                ? { ...result, command: 'UNKNOWN' }
                : result
            },
            release: (discard) => {
              released.push(discard === true)
              client.release(discard)
            },
          }
        },
      }
      await expect(
        withTransaction({ pool: faulty }, async () => {
          throw original
        }),
      ).rejects.toBe(fault === 'begin' ? transport : original)
      expect(released).toEqual([true])
      expect(singlePool.totalCount).toBe(0)
    },
  )
  it('does not let a retained transaction write after its operation ends', async () => {
    const tx = await withTransaction({ pool }, async (tx) => tx)
    await expect(tx.query('select 1')).rejects.toThrow('transaction is closed')
  })
})

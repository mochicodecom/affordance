import { randomUUID } from 'node:crypto'
import { createEngine, ExecutionIndeterminateError } from '@affordance/core'
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
  type Transaction,
  TransactionRolledBackError,
  withTransaction,
} from '../src/index.js'

const pool = testPool({ max: 12 })
beforeAll(async () => {
  await pool.query(`create table if not exists contract_purchases (id text primary key, count integer not null);
    create table if not exists contract_buyers (purchase_id text references contract_purchases(id), id text, name text, primary key(purchase_id,id));`)
})
const protect = async (tx: Transaction, id: string) => {
  const { rows } = await tx.query(
    'select id from contract_purchases where id=$1 for update',
    [id],
  )
  if (!rows[0]) throw new Error('missing domain')
}
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
  const binding = storage.bindCase(definition, {
    load,
    protect,
    repositories: (tx, id) => ({
      setCount: async (count) => {
        await tx.query('update contract_purchases set count=$2 where id=$1', [
          id,
          count,
        ])
      },
      rename: async (buyer, name) => {
        await tx.query(
          'update contract_buyers set name=$3 where purchase_id=$1 and id=$2',
          [id, buyer, name],
        )
      },
    }),
  })
  const engine = createEngine({ storage, caseTypes: [binding] })
  const { id } = await engine.attachCase(definition.name, { reference })
  return {
    engine,
    storage,
    binding,
    id,
    reference,
    externalCount: async (count: number) =>
      withTransaction({ pool }, async (tx) => {
        await protect(tx, reference)
        await tx.query('update contract_purchases set count=$2 where id=$1', [
          reference,
          count,
        ])
      }),
  }
}
domainContract('postgres', fixture)

describe('Postgres domain mechanics', () => {
  it('creates domain rows and attaches metadata in one application transaction', async () => {
    const f = await fixture(domainDefinition(randomUUID()))
    const reference = randomUUID()
    const attached = await withTransaction({ pool }, async (tx) => {
      await tx.query('insert into contract_purchases values ($1,42)', [
        reference,
      ])
      await tx.query("insert into contract_buyers values ($1,'a','Alice')", [
        reference,
      ])
      return f.storage.attachCase(tx, f.binding, reference)
    })
    expect((await f.engine.case(attached.id)).state).toMatchObject({
      count: 42,
    })
    const rejectedReference = randomUUID()
    await expect(
      withTransaction({ pool }, async (tx) => {
        await tx.query('insert into contract_purchases values ($1,42)', [
          rejectedReference,
        ])
        await tx.query("insert into contract_buyers values ($1,'a','Alice')", [
          rejectedReference,
        ])
        await f.storage.attachCase(tx, f.binding, rejectedReference)
        throw new Error('application rejected creation')
      }),
    ).rejects.toThrow('application rejected creation')
    expect(
      (
        await pool.query('select id from contract_purchases where id=$1', [
          rejectedReference,
        ])
      ).rows,
    ).toEqual([])
    expect(
      (
        await pool.query('select id from affordance.cases where reference=$1', [
          rejectedReference,
        ])
      ).rows,
    ).toEqual([])
  })

  it('does not fall back to stale state when the domain record disappears', async () => {
    const f = await fixture(domainDefinition(randomUUID()))
    await pool.query('delete from contract_buyers where purchase_id=$1', [
      f.reference,
    ])
    await pool.query('delete from contract_purchases where id=$1', [
      f.reference,
    ])
    await expect(f.engine.case(f.id)).rejects.toThrow('missing domain')
    await expect(
      f.engine.execute(f.id, 'increment', { actor: { allowed: true } }),
    ).rejects.toThrow('missing domain')
    expect(await f.engine.journal(f.id)).toEqual([])
  })

  it('stores references without a current-state column or claims table', async () => {
    const { rows } = await pool.query(
      "select column_name from information_schema.columns where table_schema='affordance' and table_name='cases'",
    )
    expect(rows.map((r) => r.column_name)).toContain('reference')
    expect(rows.map((r) => r.column_name)).not.toContain('state')
    expect(
      (await pool.query("select to_regclass('affordance.claims') as name"))
        .rows[0].name,
    ).toBeNull()
  })
  it('waits for a cooperating external writer and evaluates its newly committed state', async () => {
    const f = await fixture(domainDefinition(randomUUID()))
    const writer = await pool.connect()
    try {
      await writer.query('begin')
      await writer.query(
        'select id from contract_purchases where id=$1 for update',
        [f.reference],
      )
      await writer.query('update contract_purchases set count=9 where id=$1', [
        f.reference,
      ])
      const execution = f.engine.execute(f.id, 'once', { actor: {} })
      // Both connections perform real work; no timing assumption about which wins.
      await writer.query('commit')
      await expect(execution).rejects.toMatchObject({
        code: 'step-not-available',
      })
      expect((await f.engine.case(f.id)).state).toMatchObject({ count: 9 })
    } finally {
      await writer.query('rollback')
      writer.release()
    }
  })
  it('includes concurrent child writes in the protected snapshot', async () => {
    const f = await fixture(domainDefinition(randomUUID()))
    const client = await pool.connect()
    try {
      await client.query('begin')
      await client.query(
        'select id from contract_purchases where id=$1 for update',
        [f.reference],
      )
      await client.query(
        "update contract_buyers set name='External Bob' where purchase_id=$1 and id='b'",
        [f.reference],
      )
      const run = f.engine.execute(f.id, 'rename', {
        actor: {},
        scopeKey: 'a',
        input: { name: 'Engine Alice' },
      })
      await client.query('commit')
      await run
      expect((await f.engine.case(f.id)).state).toMatchObject({
        buyers: [
          { id: 'a', name: 'Engine Alice' },
          { id: 'b', name: 'External Bob' },
        ],
      })
    } finally {
      await client.query('rollback')
      client.release()
    }
  })
  it('loads fresh children after a parent lock even with a repeatable-read connection default', async () => {
    let armed = false
    let protecting!: () => void
    const protectionStarted = new Promise<void>((resolve) => {
      protecting = resolve
    })
    const nondefaultPool: PoolLike = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect()
        await client.query(
          "set default_transaction_isolation='repeatable read'",
        )
        return {
          query: <R extends QueryResultRow>(
            text: string,
            values?: unknown[],
          ) => {
            if (armed && text.startsWith('select id from contract_purchases'))
              protecting()
            return client.query<R>(text, values)
          },
          // Discard this test connection rather than leaking its altered default.
          release: () => client.release(true),
        }
      },
    }
    const f = await fixture(domainDefinition(randomUUID()), nondefaultPool)
    const writer = await pool.connect()
    try {
      await writer.query('begin')
      await writer.query(
        'select id from contract_purchases where id=$1 for update',
        [f.reference],
      )
      await writer.query(
        "update contract_buyers set name='External Bob' where purchase_id=$1 and id='b'",
        [f.reference],
      )
      armed = true
      const execution = f.engine.execute(f.id, 'rename', {
        actor: {},
        scopeKey: 'a',
        input: { name: 'Engine Alice' },
      })
      await protectionStarted
      await writer.query('commit')
      await execution
      expect((await f.engine.journal(f.id))[0]?.state).toMatchObject({
        buyers: [
          { id: 'a', name: 'Alice' },
          { id: 'b', name: 'External Bob' },
        ],
      })
    } finally {
      await writer.query('rollback')
      writer.release()
    }
  })
  it('reconciles committed and absent execution identities under a case fence', async () => {
    const f = await fixture(domainDefinition(randomUUID()))
    const result = await f.engine.execute(f.id, 'increment', {
      actor: { allowed: true },
    })
    expect(await f.storage.reconcileExecution(f.id, result.executionId)).toBe(
      'completed',
    )
    expect(await f.storage.reconcileExecution(f.id, 'execution:absent')).toBe(
      'not-committed',
    )
  })
})

describe('commit acknowledgment and transaction lifetime', () => {
  it('rejects an attachment result when a caught SQL error makes COMMIT roll back', async () => {
    const f = await fixture(domainDefinition(randomUUID()))
    const reference = randomUUID()
    await expect(
      withTransaction({ pool }, async (tx) => {
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
    await expect(
      withTransaction({ pool }, async (tx) => {
        await tx.query(
          'create temporary table deferred_failure (n integer unique deferrable initially deferred) on commit drop',
        )
        await tx.query('insert into deferred_failure values (1),(1)')
      }),
    ).rejects.toMatchObject({ code: '23505', severity: 'ERROR' })
  })
  it.each(['before', 'after'] as const)(
    'reconciles a lost %s-COMMIT acknowledgment without retrying',
    async (when) => {
      let armed = false
      const faulty: PoolLike = {
        query: pool.query.bind(pool),
        connect: async () => {
          const client = await pool.connect()
          return {
            query: async <R extends QueryResultRow>(
              text: string,
              values?: unknown[],
            ) => {
              if (armed && text === 'commit') {
                armed = false
                if (when === 'after') await client.query(text, values)
                throw new Error('connection lost at COMMIT')
              }
              return client.query<R>(text, values)
            },
            release: (discard) => client.release(discard),
          }
        },
      }
      const f = await fixture(domainDefinition(randomUUID()), faulty)
      armed = true
      const error = await f.engine
        .execute(f.id, 'increment', { actor: { allowed: true } })
        .catch((error) => error)
      expect(error).toBeInstanceOf(ExecutionIndeterminateError)
      expect(error.caseId).toBe(f.id)
      expect(await f.storage.reconcileExecution(f.id, error.executionId)).toBe(
        when === 'after' ? 'completed' : 'not-committed',
      )
      expect((await f.engine.case(f.id)).state).toMatchObject({
        count: when === 'after' ? 1 : 0,
      })
      expect((await f.engine.journal(f.id)).map((e) => e.entry)).toEqual(
        when === 'after' ? ['started', 'completed'] : [],
      )
    },
  )
  it('does not let a retained transaction write after its operation ends', async () => {
    const tx = await withTransaction({ pool }, async (tx) => tx)
    await expect(tx.query('select 1')).rejects.toThrow('transaction is closed')
  })
})

import { randomUUID } from 'node:crypto'
import { serializeValue } from '@affordance/core/storage'
import { testPool } from '@affordance/testkit'
import { beforeAll } from 'vitest'
import { storageContract } from '../../core/test/storage/contract.js'
import { lookupCorrelation } from '../src/correlation.js'
import { createPgStorage } from '../src/index.js'

const pool = testPool({ max: 8 })
beforeAll(async () => {
  await pool.query(
    'create table if not exists adapter_contract_records (ordinal bigserial primary key, namespace text not null, message text not null)',
  )
})
storageContract('Postgres', () => {
  const namespace = randomUUID()
  const storage = createPgStorage({
    db: { pool },
    commitContext: (tx) => ({
      record: async (message: string) => {
        await tx.query(
          'insert into adapter_contract_records (namespace, message) values ($1, $2)',
          [namespace, message],
        )
      },
      correlated: async (system: string, externalId: string) =>
        (await lookupCorrelation(tx, system, externalId)) !== null,
    }),
  })
  return {
    storage,
    records: async () =>
      (
        await pool.query<{ message: string }>(
          'select message from adapter_contract_records where namespace = $1 order by ordinal',
          [namespace],
        )
      ).rows.map((r) => r.message),
    corrupt: async (id: string, state: unknown) => {
      await pool.query(
        'update affordance.cases set state = $2::jsonb where id = $1',
        [id, JSON.stringify(serializeValue(state))],
      )
    },
    expire: async (id: string) => {
      await pool.query(
        "update affordance.claims set expires_at = '1970-01-01' where case_id = $1",
        [id],
      )
    },
  }
})

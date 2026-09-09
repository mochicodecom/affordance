import { TEST_DATABASE_URL } from '@affordance/testkit'
import pg from 'pg'
import { describe, expect, it } from 'vitest'

describe('core scaffold', () => {
  it('reaches a real postgres', async () => {
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL })
    await client.connect()
    try {
      const res = await client.query<{ one: number }>('select 1 as one')
      expect(res.rows[0]?.one).toBe(1)
    } finally {
      await client.end()
    }
  })
})

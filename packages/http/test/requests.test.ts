/**
 * The other half of the crash-versus-refusal rule, tested without a
 * database.
 *
 * `errors.test.ts` proves a bug is never answered as a refusal (non-refusals
 * rethrow untranslated). This suite proves the mirror: a caller's typo is
 * never surfaced as a crash. A malformed query parameter is a `400
 * bad-request` contract payload — `?asOf=banana` must not reach core and
 * come back as a `TypeError`, and `?since=banana` must not put `NaN` into a
 * SQL bind.
 */

import type { CaseAffordances } from '@affordance/core'
import { describe, expect, it } from 'vitest'
import { createAffordanceApi } from '../src/index.js'
import { stubEnginePort } from './fixture.js'

const record: CaseAffordances = {
  caseId: 'case:1',
  caseTypeName: 'signing',
  asOf: '2026-08-05T00:00:00.000Z',
  endedAt: null,
  affordances: [],
  blocked: [],
}

/** An engine the router must never reach when the request itself is malformed. */
const engine = stubEnginePort({
  affordances: () => Promise.resolve(record),
  affordancesOf: () => record,
  journal: () => Promise.resolve([]),
  deadLetters: () => Promise.resolve([]),
})

const api = createAffordanceApi({ engine })

const get = (path: string, query: Record<string, string>) =>
  api.handle({ method: 'GET', path, query, actor: { id: 'ops-1' } })

describe('malformed query parameters are refused, not crashed on', () => {
  it.each([
    ['/cases/case:1/affordances', { asOf: 'banana' }],
    ['/cases/case:1/journal', { since: 'banana' }],
    ['/cases/case:1/journal', { limit: '-1' }],
    ['/cases/case:1/journal', { limit: '2.5' }],
    ['/dead-letters', { limit: 'banana' }],
  ])('%s %o → 400 bad-request', async (path, query) => {
    const response = await get(path, query)
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({
      contract: 'affordance/v1',
      error: 'bad-request',
    })
    const named = Object.keys(query)[0]!
    expect((response.body as { message: string }).message).toContain(named)
  })

  it('passes well-formed parameters through to the engine', async () => {
    expect(
      (await get('/cases/case:1/affordances', { asOf: '2026-08-05T00:00:00Z' }))
        .status,
    ).toBe(200)
    expect(
      (await get('/cases/case:1/journal', { since: '0', limit: '10' })).status,
    ).toBe(200)
    expect((await get('/dead-letters', { limit: '5' })).status).toBe(200)
  })
})

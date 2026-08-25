/**
 * The hono binding, exercised over real HTTP semantics (hono's `app.request`
 * runs the whole pipeline — URL parsing, JSON bodies, status codes).
 *
 * What is being tested is the seam: the same adapter core answers the same
 * way whether it is called directly or through a web framework, and the
 * actor arrives from the host's own middleware rather than from anything the
 * framework knows about.
 */

import { randomUUID } from 'node:crypto'
import { createEngine } from '@affordance/core'
import { testPool } from '@affordance/testkit'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AffordancePayload } from '../src/index.js'
import { createAffordanceApi, createHonoApp } from '../src/index.js'
import { buyerA, organizer, purchase, twoBuyers } from './fixture.js'

const pool = testPool()

const engine = createEngine({ db: { pool }, caseTypes: [purchase] })
const api = createAffordanceApi({ engine })

/**
 * The host app: its own auth middleware puts an actor on the context, and the
 * binding reads it from there. The framework never sees the header.
 */
const app = new Hono()
app.use('*', async (c, next) => {
  const who = c.req.header('x-actor')
  c.set('actor' as never, (who === 'ops' ? organizer : buyerA) as never)
  await next()
})
app.route(
  '/',
  createHonoApp({ api, resolveActor: (c) => c.get('actor' as never) }),
)

const asOps = { headers: { 'x-actor': 'ops' } }

describe('the hono binding', () => {
  it('serves the contract end to end, with the host’s actor', async () => {
    const created = await app.request('/cases', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor': 'ops' },
      body: JSON.stringify({ caseType: purchase.name, state: twoBuyers() }),
    })
    expect(created.status).toBe(201)
    const caseId = ((await created.json()) as AffordancePayload).case.id

    // The same case, seen by two different actors, through real requests.
    const opsView = (await (
      await app.request(`/cases/${caseId}/affordances`, asOps)
    ).json()) as AffordancePayload
    const buyerView = (await (
      await app.request(`/cases/${caseId}/affordances`)
    ).json()) as AffordancePayload

    expect(opsView.affordances.map((a) => a.step)).toContain('confirm-split')
    expect(
      buyerView.affordances.map((a) => `${a.step}/${a.scopeKey ?? ''}`),
    ).toContain('sign-agreement/buyer_a')
    expect(buyerView.affordances.map((a) => a.step)).not.toContain(
      'confirm-split',
    )
  })

  it('executes a step from its own execute link, and reflects the result', async () => {
    const created = await app.request('/cases', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor': 'ops' },
      body: JSON.stringify({ caseType: purchase.name, state: twoBuyers() }),
    })
    const payload = (await created.json()) as AffordancePayload
    const buyerView = (await (
      await app.request(`/cases/${payload.case.id}/affordances`)
    ).json()) as AffordancePayload
    const sign = buyerView.affordances.find((a) => a.step === 'sign-agreement')!

    // Follow the link the payload gave us — no URL construction anywhere.
    const executed = await app.request(sign.links.execute.href, {
      method: sign.links.execute.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scopeKey: sign.scopeKey,
        input: { signedAt: '2026-08-05T10:00:00.000Z' },
      }),
    })

    expect(executed.status).toBe(201)
    const after = (await (
      await app.request(`/cases/${payload.case.id}/affordances`)
    ).json()) as AffordancePayload
    expect(
      after.affordances.map((a) => `${a.step}/${a.scopeKey ?? ''}`),
    ).not.toContain('sign-agreement/buyer_a')
  })

  it('passes the framework’s refusals through with their statuses', async () => {
    const missing = await app.request(
      `/cases/${randomUUID()}/affordances`,
      asOps,
    )
    expect(missing.status).toBe(404)
    expect((await missing.json()) as { error: string }).toMatchObject({
      error: 'not-found',
    })
  })
})

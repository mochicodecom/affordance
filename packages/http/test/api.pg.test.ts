/**
 * The adapter and the contract, against a real engine.
 *
 * The acceptance criterion drives most of this: a buyer-scoped request
 * sees only that buyer's affordances, an organizer request sees purchase-level
 * ones, and a blocked `close-purchase` shows its unmet conditions without leaking
 * `permits` internals to the wrong actor.
 */

import { randomUUID } from 'node:crypto'
import { createEngine } from '@affordance/core'
import { testPool } from '@affordance/testkit'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type {
  AffordancePayload,
  ApiRequest,
  ExecutionPayload,
} from '../src/index.js'
import { createAffordanceApi } from '../src/index.js'
import { buyerA, buyerB, organizer, purchase, twoBuyers } from './fixture.js'

const pool = testPool()

const engine = createEngine({ db: { pool }, caseTypes: [purchase] })
const api = createAffordanceApi({
  engine,
  basePath: '/api',
  // A zod app can describe its input schemas on the wire; the framework never
  // assumes a schema library, so this is the host's hook.
  describeInput: (schema) => z.toJSONSchema(schema as z.ZodType),
})

const call = (
  request: Omit<ApiRequest, 'query'> & { query?: ApiRequest['query'] },
) => api.handle({ query: {}, ...request })

const newCase = async () => {
  const created = await call({
    method: 'POST',
    path: '/cases',
    body: { caseType: purchase.name, state: twoBuyers() },
    actor: organizer,
  })
  return (created.body as AffordancePayload).case.id
}

const affordancesFor = async (caseId: string, actor: unknown) =>
  (await call({ method: 'GET', path: `/cases/${caseId}/affordances`, actor }))
    .body as AffordancePayload

describe('the affordance payload', () => {
  it('creates a case and answers with what the creator can do next', async () => {
    const response = await call({
      method: 'POST',
      path: '/cases',
      body: { caseType: purchase.name, state: twoBuyers() },
      actor: organizer,
    })

    expect(response.status).toBe(201)
    const payload = response.body as AffordancePayload
    expect(payload.contract).toBe('affordance/v1')
    expect(payload.case).toMatchObject({ type: purchase.name, endedAt: null })
    expect(payload.affordances.map((a) => a.step)).toEqual([
      'confirm-split',
      'record-commitment',
      'record-commitment',
    ])
    expect(payload.links.self.href).toBe(
      `/api/cases/${payload.case.id}/affordances`,
    )
  })

  it('carries an execute link and a described input schema on every affordance', async () => {
    const caseId = await newCase()

    const payload = await affordancesFor(caseId, buyerA)
    const sign = payload.affordances.find((a) => a.step === 'sign-agreement')

    expect(sign).toMatchObject({
      step: 'sign-agreement',
      scopeKey: 'buyer_a',
      links: {
        execute: {
          method: 'POST',
          href: `/api/cases/${caseId}/steps/sign-agreement`,
        },
        explain: {
          method: 'GET',
          href: `/api/cases/${caseId}/affordances/sign-agreement?scopeKey=buyer_a`,
        },
      },
    })
    expect(sign?.input.required).toBe(true)
    expect(sign?.input.vendor).toBe('zod')
    expect(sign?.input.schema).toMatchObject({
      type: 'object',
      properties: { signedAt: { type: 'string' } },
    })
    // A step with no input schema says so rather than inventing one.
    expect(
      payload.affordances.find((a) => a.step === 'confirm-split'),
    ).toBeUndefined()
  })
})

describe('who sees what', () => {
  it('shows a buyer only their own track', async () => {
    const caseId = await newCase()

    const payload = await affordancesFor(caseId, buyerA)

    // Their own agreement, and nothing of buyer_b's.
    expect(
      payload.affordances.map((a) => `${a.step}/${a.scopeKey ?? ''}`),
    ).toEqual([
      'sign-agreement/buyer_a',
      'record-commitment/buyer_a',
      'record-commitment/buyer_b',
    ])
    expect(payload.blocked.map((b) => `${b.step}/${b.scopeKey ?? ''}`)).toEqual(
      [],
    )
    // buyer_b's blocked sign-agreement is not disclosed at all, and neither
    // is the existence of purchase-level steps they may not take.
    expect(JSON.stringify(payload.blocked)).not.toContain('buyer_b')
    expect(JSON.stringify(payload)).not.toContain('close-purchase')
  })

  it('shows the organizer the purchase-level steps and why the closing one is blocked', async () => {
    const caseId = await newCase()

    const payload = await affordancesFor(caseId, organizer)

    expect(payload.affordances.map((a) => a.step)).toContain('confirm-split')
    const close = payload.blocked.find((b) => b.step === 'close-purchase')
    expect(close).toMatchObject({ possible: false, permitted: true })
    expect(close?.unmet.map((condition) => condition.name)).toEqual([
      'allSigned',
      'splitFinal',
    ])
    expect(close?.unmet.find((c) => c.name === 'allSigned')?.reason).toBe(
      '2 buyers have not signed',
    )
  })

  it('never names a permits condition the caller failed', async () => {
    const caseId = await newCase()

    const buyerPayload = await affordancesFor(caseId, buyerB)
    const explanation = await call({
      method: 'GET',
      path: `/cases/${caseId}/affordances/sign-agreement`,
      query: { scopeKey: 'buyer_a' },
      actor: buyerB,
    })

    // buyer_b asking about buyer_a's agreement is told it is not theirs — not
    // *which rule* said so, and not the rule's reason text.
    expect(JSON.stringify(buyerPayload)).not.toContain('isThisBuyer')
    expect(JSON.stringify(explanation.body)).not.toContain('isThisBuyer')
    expect(explanation.body).toMatchObject({
      permitted: false,
      available: false,
    })
  })

  it('keeps the journal as filtered as every other read surface', async () => {
    const caseId = await newCase()
    await call({
      method: 'POST',
      path: `/cases/${caseId}/steps/sign-agreement`,
      body: {
        scopeKey: 'buyer_a',
        input: { signedAt: '2026-08-05T10:00:00.000Z' },
      },
      actor: buyerA,
    })

    // The claimed entry recorded the full guard evaluation and the Case
    // State it ran against. buyer_b, told only `permitted: false` by the
    // affordances read, must not find the permits rule — or the state —
    // waiting one request away in the journal.
    const journal = await call({
      method: 'GET',
      path: `/cases/${caseId}/journal`,
      actor: buyerB,
    })
    const wire = JSON.stringify(journal.body)
    expect(wire).not.toContain('isThisBuyer')
    expect(wire).not.toContain('"state"')

    // The operator's journal read is the audit view: evidence whole.
    const audit = await call({
      method: 'GET',
      path: `/cases/${caseId}/journal`,
      actor: organizer,
      visibility: 'all',
    })
    const entries = (
      audit.body as { entries: { entry: string; state?: unknown }[] }
    ).entries
    const claimed = entries.find((entry) => entry.entry === 'claimed')
    expect(JSON.stringify(audit.body)).toContain('isThisBuyer')
    expect(claimed?.state).toBeDefined()
  })

  it('tells an ops console everything, when the host asks for it', async () => {
    const caseId = await newCase()

    const payload = (
      await call({
        method: 'GET',
        path: `/cases/${caseId}/affordances`,
        actor: buyerB,
        visibility: 'all',
      })
    ).body as AffordancePayload

    const other = payload.blocked.find(
      (b) => b.step === 'sign-agreement' && b.scopeKey === 'buyer_a',
    )
    expect(other?.permitted).toBe(false)
    expect(other?.unmet.map((condition) => condition.name)).toEqual([
      'isThisBuyer',
    ])
  })
})

describe('executing a step', () => {
  it('commits and answers with the execution and its links', async () => {
    const caseId = await newCase()

    const response = await call({
      method: 'POST',
      path: `/cases/${caseId}/steps/sign-agreement`,
      body: {
        scopeKey: 'buyer_a',
        input: { signedAt: '2026-08-05T10:00:00.000Z' },
      },
      actor: buyerA,
    })

    expect(response.status).toBe(201)
    const payload = response.body as ExecutionPayload
    expect(payload.execution).toMatchObject({
      step: 'sign-agreement',
      scopeKey: 'buyer_a',
      attempts: 1,
      seq: 1,
    })
    expect(payload.links.affordances.href).toBe(
      `/api/cases/${caseId}/affordances`,
    )
    expect(payload.links.journal.href).toContain('executionId=')
  })

  it('surfaces the mid-click race as 409 with the current unmet conditions', async () => {
    const caseId = await newCase()

    const response = await call({
      method: 'POST',
      path: `/cases/${caseId}/steps/close-purchase`,
      actor: organizer,
    })

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({
      contract: 'affordance/v1',
      error: 'step-not-available',
      possible: false,
      permitted: true,
    })
    const unmet = (response.body as { unmet: readonly { name: string }[] })
      .unmet
    expect(unmet.map((condition) => condition.name)).toEqual([
      'allSigned',
      'splitFinal',
    ])
  })

  it('refuses an actor the permits reject, without saying which rule', async () => {
    const caseId = await newCase()

    const response = await call({
      method: 'POST',
      path: `/cases/${caseId}/steps/sign-agreement`,
      body: {
        scopeKey: 'buyer_a',
        input: { signedAt: '2026-08-05T10:00:00.000Z' },
      },
      actor: buyerB,
    })

    expect(response.status).toBe(409)
    expect(response.body).toMatchObject({
      error: 'step-not-available',
      permitted: false,
    })
    expect((response.body as { unmet: unknown[] }).unmet).toEqual([])
  })

  it('maps the framework’s refusals onto the contract’s statuses', async () => {
    const caseId = await newCase()

    expect(
      (
        await call({
          method: 'POST',
          path: `/cases/${caseId}/steps/no-such-step`,
          actor: organizer,
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await call({
          method: 'POST',
          path: `/cases/${caseId}/steps/sign-agreement`,
          body: { scopeKey: 'buyer_a', input: { signedAt: 42 } },
          actor: buyerA,
        })
      ).status,
    ).toBe(422)
    expect(
      (
        await call({
          method: 'GET',
          path: `/cases/${randomUUID()}/affordances`,
          actor: organizer,
        })
      ).status,
    ).toBe(404)
    expect(
      (await call({ method: 'GET', path: '/nope', actor: organizer })).status,
    ).toBe(404)
  })

  it('rejects a typo’d journal entry filter as bad-request — never a silently empty journal', async () => {
    const caseId = await newCase()
    const response = await call({
      method: 'GET',
      path: `/cases/${caseId}/journal`,
      query: { entry: 'complete' },
      actor: organizer,
    })
    expect(response.status).toBe(400)
    expect((response.body as { error: string }).error).toBe('bad-request')
    expect((response.body as { message: string }).message).toContain(
      "'complete'",
    )

    const valid = await call({
      method: 'GET',
      path: `/cases/${caseId}/journal`,
      query: { entry: 'claimed,completed' },
      actor: organizer,
    })
    expect(valid.status).toBe(200)
  })
})

describe('the journal and ingestion endpoints', () => {
  it('reads a case’s journal, filtered per track', async () => {
    const caseId = await newCase()
    await call({
      method: 'POST',
      path: `/cases/${caseId}/steps/sign-agreement`,
      body: {
        scopeKey: 'buyer_a',
        input: { signedAt: '2026-08-05T10:00:00.000Z' },
      },
      actor: buyerA,
    })

    const all = await call({
      method: 'GET',
      path: `/cases/${caseId}/journal`,
      actor: organizer,
    })
    const track = await call({
      method: 'GET',
      path: `/cases/${caseId}/journal`,
      query: { scopeKey: 'buyer_a', entry: 'completed' },
      actor: organizer,
    })

    expect((all.body as { entries: unknown[] }).entries.length).toBe(2)
    expect(
      (track.body as { entries: { step: string }[] }).entries.map(
        (e) => e.step,
      ),
    ).toEqual(['sign-agreement'])
  })

  it('accepts a webhook, routes it, and answers 200 even when it changes nothing', async () => {
    const caseId = await newCase()
    const envelope = `env_${randomUUID().slice(0, 8)}`
    await engine.correlate({
      system: 'verify',
      externalId: envelope,
      caseId,
      scopeKey: 'buyer_a',
      step: 'record-commitment',
    })

    const routed = await call({
      method: 'POST',
      path: '/events',
      body: {
        system: 'verify',
        externalId: envelope,
        type: 'check.completed',
        eventId: `evt_${randomUUID().slice(0, 8)}`,
        payload: { amount: 250_000 },
      },
      actor: null,
    })
    const orphan = await call({
      method: 'POST',
      path: '/events',
      body: {
        system: 'verify',
        externalId: `env_${randomUUID().slice(0, 8)}`,
        type: 'check.completed',
        eventId: `evt_${randomUUID().slice(0, 8)}`,
      },
      actor: null,
    })

    expect(routed.status).toBe(200)
    expect(
      (routed.body as { ingestion: { status: string } }).ingestion.status,
    ).toBe('executed')
    // Unroutable is still 200: the event was recorded, and telling the
    // provider to retry it forever would help nobody.
    expect(orphan.status).toBe(200)
    expect(
      (orphan.body as { ingestion: { status: string; reason: string } })
        .ingestion,
    ).toMatchObject({ status: 'dead-lettered', reason: 'unrouted' })
    expect((await affordancesFor(caseId, organizer)).case.id).toBe(caseId)
  })

  it('exposes the dead-letter surface for an operator', async () => {
    const response = await call({
      method: 'GET',
      path: '/dead-letters',
      query: { system: 'verify', limit: '5' },
      actor: organizer,
    })

    expect(response.status).toBe(200)
    expect(
      Array.isArray((response.body as { deadLetters: unknown[] }).deadLetters),
    ).toBe(true)
  })
})

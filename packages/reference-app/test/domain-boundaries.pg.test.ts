import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { PurchaseApp } from '../src/app.js'
import type { AffordancePayload, ExecutionPayload } from '../src/http/index.js'
import { HOUSE_PURCHASE, newPurchase } from '../src/purchase.js'
import { createMockServices } from '../src/services.js'
import { organizer, PurchaseState } from '../src/state.js'
import { createClient, createPool } from './harness.js'

const pool = createPool()
const apps: PurchaseApp[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop()
  vi.restoreAllMocks()
})
afterAll(() => pool.end())

const appWith = async (services = createMockServices()) => {
  const { app } = await createClient(pool, { services })
  apps.push(app)
  return app
}
const post = (app: PurchaseApp, path: string, body: unknown) =>
  app.http.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-actor-id': organizer.id,
      'x-actor-roles': organizer.roles.join(','),
    },
    body: JSON.stringify(body),
  })
const create = async (app: PurchaseApp, state: unknown) => {
  const response = await post(app, '/api/cases', {
    caseType: HOUSE_PURCHASE,
    state,
  })
  expect(response.status).toBe(201)
  return ((await response.json()) as AffordancePayload).case.id
}

describe('domain creation and provider boundaries', () => {
  it('preserves absent, empty, and manually signed agreements across storage', async () => {
    const app = await appWith()
    const initial = PurchaseState.parse({
      ...newPurchase('Manual signature', 100),
      escrow: { status: 'open' },
      buyers: [
        {
          id: 'manual',
          committed: 100,
          agreement: { signed: true, signedAt: '2026-09-01T00:00:00.000Z' },
        },
        { id: 'empty', agreement: {} },
        { id: 'absent' },
      ],
    })
    const id = await create(app, initial)
    expect((await app.engine.case(id)).state).toEqual(initial)
    expect(
      (await app.engine.affordances(id, organizer)).affordances.map(
        (a) => a.step,
      ),
    ).toContain('issue-funding-call')
    await app.engine.execute(id, 'issue-funding-call', {
      actor: organizer,
      input: { reference: 'manual-signature' },
    })
    expect((await app.engine.case(id)).state).toMatchObject({
      fundingCall: { amount: 100 },
    })
  })

  it.each([
    ['unknown-type', 'typo', 404, 'not-found'],
    ['invalid-state', HOUSE_PURCHASE, 500, 'invalid-state'],
  ])(
    'keeps the HTTP contract for %s creation failures',
    async (_label, caseType, status, error) => {
      const app = await appWith()
      const response = await post(app, '/api/cases', { caseType, state: {} })
      expect(response.status).toBe(status)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(await response.json()).toMatchObject({
        contract: 'affordance/v1',
        error,
      })
    },
  )

  it.each([
    ['open-escrow', 'applyForEscrowAccount'],
    ['start-verification', 'startVerification'],
    ['send-agreement', 'sendEnvelope'],
  ] as const)(
    'returns the committed %s execution when dispatch fails',
    async (step, method) => {
      const services = createMockServices()
      const failure = new Error('provider unavailable')
      const dispatch = vi.spyOn(services, method).mockImplementation(() => {
        throw failure
      })
      const report = vi.spyOn(console, 'error').mockImplementation(() => {})
      const app = await appWith(services)
      const id = await create(app, {
        ...newPurchase(),
        property: {
          offerAcceptedAt: '2026-09-01',
          inspectionReportId: 'report',
        },
        buyers: [
          {
            id: 'a',
            committed: 100,
            verification: {
              status: step === 'send-agreement' ? 'clear' : 'none',
            },
          },
        ],
      })
      const response = await post(
        app,
        `/api/cases/${id}/steps/${step}`,
        step === 'open-escrow' ? {} : { scopeKey: 'a' },
      )
      expect(response.status).toBe(201)
      const { execution } = (await response.json()) as ExecutionPayload
      expect(execution).toMatchObject({ caseId: id, step, seq: 1 })
      expect(dispatch).toHaveBeenCalledOnce()
      expect(report).toHaveBeenCalledWith(
        'Provider dispatch failed after execution committed',
        expect.objectContaining({
          caseId: id,
          executionId: execution.executionId,
          error: failure,
        }),
      )
      expect((await app.engine.journal(id)).map((e) => e.entry)).toEqual([
        'started',
        'completed',
      ])
      expect((await app.engine.case(id)).seq).toBe(1)
    },
  )

  it('dispatches the committed buyer even if caller options change during execution', async () => {
    const services = createMockServices()
    const dispatch = vi.spyOn(services, 'startVerification')
    const app = await appWith(services)
    const id = await create(app, {
      ...newPurchase(),
      buyers: [
        { id: 'a', committed: 100 },
        { id: 'b', committed: 100 },
      ],
    })
    const options = { actor: organizer, scopeKey: 'a' }
    const pending = app.engine.execute(id, 'start-verification', options)
    options.scopeKey = 'b'
    const result = await pending
    const state = PurchaseState.parse(result.state)
    expect(result.scopeKey).toBe('a')
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      buyerId: 'a',
      requestId: state.buyers[0]!.verification.checkId,
    })
    expect(state.buyers[1]!.verification.status).toBe('none')
  })
})

/**
 * The demo console: the page and the `/dev` routes the reference UI needs.
 *
 * These routes are deliberately *not* part of the affordance contract —
 * `app.http` is a root hono app that serves the page and the quarantined
 * `/dev` console, with the contract app mounted under it. This suite pins
 * that seam: the console works, and the contract routes are untouched by it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HOUSE_PURCHASE, newPurchase } from '../src/purchase.js'
import { buyerActor, organizer } from '../src/state.js'
import { type Client, createClient, createPool } from './harness.js'

const pool = createPool()
let client: Client

const http = (path: string, init?: RequestInit) =>
  client.app.http.request(path, init)

beforeAll(async () => {
  client = await createClient(pool)
})

afterAll(async () => {
  await client.app.stop()
  await pool.end()
})

describe('the demo page', () => {
  it('is served at the root as HTML', async () => {
    const response = await http('/')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('<title>')
  })
})

describe('the /dev console', () => {
  it('lists cases newest first, in the handle shape', async () => {
    const older = await client.create(organizer)
    const newer = await client.create(organizer)

    const response = await http('/dev/cases')
    expect(response.status).toBe(200)
    const { cases } = (await response.json()) as { cases: any[] }

    // Other suites share the database, so assert on our own cases only.
    const ids = cases.map((row) => row.id)
    expect(ids.indexOf(newer)).toBeGreaterThanOrEqual(0)
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older))

    const row = cases.find((entry) => entry.id === newer)
    expect(row).toMatchObject({
      caseTypeName: HOUSE_PURCHASE,
      seq: 0,
      endedAt: null,
    })
    expect(row.createdAt).toBeTruthy()
    expect(row.updatedAt).toBeTruthy()
  })

  it('serves one case with its raw state', async () => {
    const caseId = await client.create(organizer, {
      address: '9 Dev Console Way',
    })

    const response = await http(`/dev/cases/${caseId}`)
    expect(response.status).toBe(200)
    const handle = (await response.json()) as any
    expect(handle).toMatchObject({
      id: caseId,
      caseTypeName: HOUSE_PURCHASE,
      seq: 0,
    })
    expect(handle.state.purchase.address).toBe('9 Dev Console Way')
  })

  it('answers 404 for a case that does not exist', async () => {
    const response = await http(
      '/dev/cases/00000000-0000-0000-0000-000000000000',
    )
    expect(response.status).toBe(404)
    expect(((await response.json()) as any).error).toBe('not-found')
  })

  it('settles the world: providers deliver', async () => {
    const caseId = await client.create(organizer)
    await client.take(caseId, organizer, 'accept-offer')
    await client.take(caseId, organizer, 'obtain-inspection-report')
    await client.take(caseId, organizer, 'open-escrow')

    const response = await http('/dev/settle', { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })

    // The settle delivered the escrow provider's webhook.
    const after = await http(`/dev/cases/${caseId}`)
    expect(((await after.json()) as any).state.escrow.status).toBe('open')
  })
})

describe('the outside world, one event at a time', () => {
  it('lists what providers owe, correlated to their cases', async () => {
    const caseId = await client.create(organizer)
    await client.take(caseId, organizer, 'accept-offer')
    await client.take(caseId, organizer, 'obtain-inspection-report')
    await client.take(caseId, organizer, 'open-escrow')

    const response = await http('/dev/world')
    expect(response.status).toBe(200)
    const world = (await response.json()) as { events: any[] }
    const event = world.events.find((entry) => entry.caseId === caseId)
    expect(event).toMatchObject({
      system: 'escrow',
      type: 'account.opened',
      step: 'record-escrow-account',
    })
    expect(typeof event.eventId).toBe('string')
  })

  it('delivers a single queued event and removes it from the outbox', async () => {
    const caseId = await client.create(organizer)
    await client.take(caseId, organizer, 'accept-offer')
    await client.take(caseId, organizer, 'obtain-inspection-report')
    await client.take(caseId, organizer, 'open-escrow')

    const world = (await (await http('/dev/world')).json()) as { events: any[] }
    const event = world.events.find((entry) => entry.caseId === caseId)

    const deliver = await http('/dev/deliver', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: event.eventId }),
    })
    expect(deliver.status).toBe(200)
    expect(((await deliver.json()) as any).ok).toBe(true)

    const after = (await (await http(`/dev/cases/${caseId}`)).json()) as any
    expect(after.state.escrow.status).toBe('open')

    const remaining = (await (await http('/dev/world')).json()) as {
      events: any[]
    }
    expect(
      remaining.events.some((entry) => entry.eventId === event.eventId),
    ).toBe(false)
  })

  it('announces a wire, unprompted, and the outbox delivers it', async () => {
    const caseId = await client.create(organizer)
    await client.take(caseId, organizer, 'accept-offer')
    await client.take(caseId, organizer, 'obtain-inspection-report')
    await client.take(caseId, organizer, 'open-escrow')
    await client.settle()
    await client.take(caseId, organizer, 'invite-buyer', {
      input: { name: 'Wren' },
    })
    const wren = await client.buyerIdOf(caseId, 'Wren')
    await client.take(caseId, buyerActor(wren), 'record-commitment', {
      scopeKey: wren,
      input: { amount: 100_000 },
    })
    await client.take(caseId, organizer, 'start-verification', {
      scopeKey: wren,
    })
    await client.settle()
    await client.take(caseId, organizer, 'send-agreement', { scopeKey: wren })
    await client.settle()
    await client.take(caseId, organizer, 'issue-funding-call', {
      input: { reference: 'CALL-W' },
    })

    // With the funding call out, the world names the announceable wires —
    // computed server-side with the same counting rule the close guard's
    // `funded` condition uses, so the console never restates it.
    const withLevers = (await (
      await http(`/dev/world?caseId=${caseId}`)
    ).json()) as {
      levers: { buyerId: string; name: string; amount: number }[]
    }
    expect(withLevers.levers).toEqual([
      { buyerId: wren, name: 'Wren', amount: 100_000 },
    ])

    // Announcing only enqueues — the wire is a pending webhook, not state.
    const announced = await http('/dev/announce-wire', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ caseId, buyerId: wren, amount: 100_000 }),
    })
    expect(announced.status).toBe(200)
    expect((await client.state(caseId)).wires).toHaveLength(0)

    const world = (await (await http('/dev/world')).json()) as { events: any[] }
    const wire = world.events.find(
      (entry) => entry.caseId === caseId && entry.type === 'wire.received',
    )
    expect(wire).toBeTruthy()

    await http('/dev/deliver', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: wire.eventId }),
    })
    await client.settle()
    expect((await client.state(caseId)).wires[0]).toMatchObject({
      outcome: 'matched',
    })

    // Wren's money has arrived, so the lever is gone: the served levers
    // move with the same facts the guard reads.
    const afterArrival = (await (
      await http(`/dev/world?caseId=${caseId}`)
    ).json()) as {
      levers: unknown[]
    }
    expect(afterArrival.levers).toEqual([])
  })

  it('refuses to announce a wire where no escrow application exists', async () => {
    const caseId = await client.create(organizer)
    const response = await http('/dev/announce-wire', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ caseId, buyerId: 'whoever', amount: 1 }),
    })
    expect(response.status).toBe(409)
    expect(((await response.json()) as any).error).toBe('no-escrow')
  })

  it('deletes a case outright, journal and all', async () => {
    const caseId = await client.create(organizer)
    await client.take(caseId, organizer, 'accept-offer')
    await client.take(caseId, organizer, 'open-escrow').catch(() => undefined)

    const deleted = await http(`/dev/cases/${caseId}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(((await deleted.json()) as any).ok).toBe(true)

    expect((await http(`/dev/cases/${caseId}`)).status).toBe(404)
    const list = (await (await http('/dev/cases')).json()) as {
      cases: { id: string }[]
    }
    expect(list.cases.some((row) => row.id === caseId)).toBe(false)
  })

  it('deletes the case’s ingested events too — a dedup row must not outlive its case', async () => {
    // The regression: the delete once enumerated its own copy of the
    // framework's table set and omitted ingested_events, so a re-created
    // case with the same provider identifiers deduped new deliveries
    // against the deleted case's rows.
    const caseId = await client.create(organizer)
    await pool.query(
      `insert into affordance.ingested_events
         (id, system, external_id, type, idempotency_key, case_id, status, event)
       values ('evt:dev-delete-test', 'escrow-bank', 'ext-dev-delete', 'wire.received',
               'dedup-dev-delete', $1, 'executed', '{}'::jsonb)`,
      [caseId],
    )

    expect(
      (await http(`/dev/cases/${caseId}`, { method: 'DELETE' })).status,
    ).toBe(200)

    const remaining = await pool.query(
      `select 1 from affordance.ingested_events where case_id = $1`,
      [caseId],
    )
    expect(remaining.rowCount).toBe(0)
  })

  it('404s an unknown event id', async () => {
    const response = await http('/dev/deliver', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: 'evt_nope' }),
    })
    expect(response.status).toBe(404)
    expect(((await response.json()) as any).error).toBe('not-found')
  })
})

describe('case creation authorization', () => {
  it('refuses creation for an actor without the organizer role', async () => {
    const response = await http('/api/cases', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': 'buyer_a',
        'x-actor-roles': 'buyer',
      },
      body: JSON.stringify({ caseType: HOUSE_PURCHASE, state: newPurchase() }),
    })
    expect(response.status).toBe(403)
    const body = (await response.json()) as any
    expect(body.error).toBe('not-permitted')
    expect(body.message).toContain('organizer')
  })

  it('leaves every other contract route open to any actor', async () => {
    const caseId = await client.create(organizer)
    const response = await http(`/api/cases/${caseId}/affordances`, {
      headers: { 'x-actor-id': 'buyer_a', 'x-actor-roles': 'buyer' },
    })
    expect(response.status).toBe(200)
  })
})

describe('the contract, through the root app', () => {
  it('still serves /api unchanged', async () => {
    const response = await http('/api/cases', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-actor-id': organizer.id,
        'x-actor-roles': organizer.roles.join(','),
      },
      body: JSON.stringify({ caseType: HOUSE_PURCHASE, state: newPurchase() }),
    })
    expect(response.status).toBe(201)
    const payload = (await response.json()) as any
    expect(payload.contract).toBe('affordance/v1')
    expect(payload.affordances.map((entry: any) => entry.step)).toContain(
      'accept-offer',
    )
  })
})

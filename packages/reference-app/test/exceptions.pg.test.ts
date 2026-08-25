/**
 * The three exceptions the anchor use case is really about.
 *
 * A framework that handles the happy path is a workflow engine. What was
 * claimed here is that the exceptions — the wire that does not match, the
 * verification hit that lands in review, the terms that change mid-purchase —
 * are *ordinary steps* with ordinary guards, and that nobody has to draw a
 * branch for them. These tests are that claim, checked.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Purchase } from '../src/state.js'
import { buyerActor, escrowOfficer, organizer } from '../src/state.js'
import {
  type Client,
  createClient,
  createPool,
  offered,
  unmetOf,
} from './harness.js'

const pool = createPool()
let client: Client

/**
 * Drive a case to "funding call issued", the point every wire test starts
 * from. Buyer ids are the server's to mint, so the fixture learns each one
 * back by name and hands the caller the mapping.
 */
const readyToFund = async (
  buyers: readonly { name: string; amount: number }[],
): Promise<{ caseId: string; idOf: Record<string, string> }> => {
  const caseId = await client.create(organizer)
  await client.take(caseId, organizer, 'accept-offer')
  await client.take(caseId, organizer, 'obtain-inspection-report')
  await client.take(caseId, organizer, 'open-escrow')
  await client.settle()
  const idOf: Record<string, string> = {}
  for (const buyer of buyers) {
    await client.take(caseId, organizer, 'invite-buyer', {
      input: { name: buyer.name },
    })
    const id = await client.buyerIdOf(caseId, buyer.name)
    idOf[buyer.name] = id
    await client.take(caseId, buyerActor(id), 'record-commitment', {
      scopeKey: id,
      input: { amount: buyer.amount },
    })
    await client.take(caseId, organizer, 'start-verification', { scopeKey: id })
  }
  await client.settle()
  for (const buyer of buyers) {
    await client.take(caseId, organizer, 'send-agreement', {
      scopeKey: idOf[buyer.name],
    })
  }
  await client.settle()
  await client.take(caseId, organizer, 'issue-funding-call', {
    input: { reference: 'CALL-1' },
  })
  return { caseId, idOf }
}

const wireOf = (state: Purchase) => state.wires[0]

beforeAll(async () => {
  client = await createClient(pool, { services: { attempts: 2 } })
})

afterAll(async () => {
  await client.app.stop()
  await pool.end()
})

describe('exception 1: wire reconciliation', () => {
  it('materializes a matching wire already classified, with no affordance taken', async () => {
    const { caseId, idOf } = await readyToFund([
      { name: 'Ada', amount: 500_000 },
    ])
    const applicationId = (await client.state(caseId)).escrow.applicationId!

    client.app.services.announceWire({
      applicationId,
      buyerId: idOf.Ada!,
      amount: 500_000,
    })
    await client.settle()

    expect(wireOf(await client.state(caseId))?.outcome).toBe('matched')
    // The external system took it: the announcement executes `record-wire`
    // through ingestion, and the classification rides that same commit.
    const recorded = (
      await client.journal(caseId, { step: 'record-wire' })
    ).find((entry) => entry.entry === 'completed')
    expect(recorded?.actor).toMatchObject({ id: 'system:escrow' })
  })

  it('opens exactly one resolution step for a short wire, and closes on it', async () => {
    const { caseId, idOf } = await readyToFund([
      { name: 'Ada', amount: 500_000 },
    ])
    const applicationId = (await client.state(caseId)).escrow.applicationId!

    client.app.services.announceWire({
      applicationId,
      buyerId: idOf.Ada!,
      amount: 400_000,
    })
    await client.settle()

    const state = await client.state(caseId)
    expect(wireOf(state)?.outcome).toBe('short')
    const payload = await client.affordances(caseId, organizer)
    // One resolution on offer — the one that matches the outcome. The other
    // two exist as steps and are simply not available.
    expect(offered(payload).filter((name) => name.includes('wire'))).toEqual([
      `accept-short-wire(${wireOf(state)!.id})`,
    ])
    expect(unmetOf(payload, 'close-purchase')).toEqual([
      'wiresSettled',
      'funded',
    ])

    await client.take(caseId, organizer, 'accept-short-wire', {
      scopeKey: wireOf(state)!.id,
    })
    expect(offered(await client.affordances(caseId, organizer))).toContain(
      'close-purchase',
    )
  })

  it('routes an over-payment and a wrong-account wire to the escrow officer', async () => {
    const { caseId, idOf } = await readyToFund([
      { name: 'Ada', amount: 500_000 },
      { name: 'Bo', amount: 500_000 },
    ])
    const applicationId = (await client.state(caseId)).escrow.applicationId!

    client.app.services.announceWire({
      applicationId,
      buyerId: idOf.Ada!,
      amount: 750_000,
    })
    client.app.services.announceWire({
      applicationId,
      buyerId: idOf.Bo!,
      amount: 500_000,
      fromAccount: 'ext_someone_else',
    })
    await client.settle()

    const state = await client.state(caseId)
    expect(state.wires.map((w) => w.outcome).sort()).toEqual([
      'over',
      'wrong-account',
    ])
    // Money mechanics are the escrow company's to resolve — the organizer is
    // not offered either step. (Accepting a short wire stays the organizer's:
    // that one is a deal concession, not money handling.)
    const payload = await client.affordances(caseId, escrowOfficer)
    expect(
      offered(payload)
        .filter((name) => name.includes('wire'))
        .sort(),
    ).toEqual([
      `refund-over-wire(${state.wires.find((w) => w.outcome === 'over')!.id})`,
      `return-wire(${state.wires.find((w) => w.outcome === 'wrong-account')!.id})`,
    ])
    expect(
      offered(await client.affordances(caseId, organizer)).filter((name) =>
        name.includes('wire'),
      ),
    ).toEqual([])

    await client.take(caseId, escrowOfficer, 'refund-over-wire', {
      scopeKey: state.wires.find((w) => w.outcome === 'over')!.id,
    })
    expect(
      (await client.state(caseId)).wires.find((w) => w.outcome === 'over')
        ?.resolution,
    ).toBe('refunded-over')
  })
})

describe('exception 2: verification escalation', () => {
  /** A buyer whose provider check comes back with a hit — the mock keys on the name. */
  const withHit = async (): Promise<{ caseId: string; hal: string }> => {
    const caseId = await client.create(organizer)
    await client.take(caseId, organizer, 'invite-buyer', {
      input: { name: 'Hal (hit)' },
    })
    const hal = await client.buyerIdOf(caseId, 'Hal (hit)')
    await client.take(caseId, buyerActor(hal), 'record-commitment', {
      scopeKey: hal,
      input: { amount: 100_000 },
    })
    await client.take(caseId, organizer, 'start-verification', {
      scopeKey: hal,
    })
    await client.settle()
    return { caseId, hal }
  }

  it('puts a hit into review, and offers the escalation to the escrow officer', async () => {
    const { caseId, hal } = await withHit()

    const state = await client.state(caseId)
    expect(state.buyers[0]?.verification).toMatchObject({
      status: 'review',
      hits: ['sanctions:OFAC'],
      flaggedAt: '2026-08-05T10:00:00.000Z',
    })

    const payload = await client.affordances(caseId, escrowOfficer)
    expect(offered(payload)).toContain(`escalate-verification(${hal})`)
  })

  it('escalates to enhanced review, and clears out of it', async () => {
    const { caseId, hal } = await withHit()

    await client.take(caseId, escrowOfficer, 'escalate-verification', {
      scopeKey: hal,
    })
    expect((await client.state(caseId)).buyers[0]?.verification.status).toBe(
      'escalated',
    )

    // Enhanced review is a human's call, and its outcome is state like
    // everything else — clearing it puts the buyer back on the main path.
    await client.take(caseId, escrowOfficer, 'clear-enhanced-review', {
      scopeKey: hal,
      input: { cleared: true },
    })
    expect((await client.state(caseId)).buyers[0]?.verification.status).toBe(
      'clear',
    )
    expect(offered(await client.affordances(caseId, organizer))).toContain(
      `send-agreement(${hal})`,
    )
  })

  it('does not offer escalation to the organizer — it is the escrow officer’s step', async () => {
    const { caseId, hal } = await withHit()

    expect(offered(await client.affordances(caseId, organizer))).not.toContain(
      `escalate-verification(${hal})`,
    )
    expect(offered(await client.affordances(caseId, escrowOfficer))).toContain(
      `escalate-verification(${hal})`,
    )
  })
})

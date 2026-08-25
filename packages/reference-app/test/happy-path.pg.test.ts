/**
 * The anchor use case, end to end: create a house purchase and take it to
 * close, driven **only through affordances**.
 *
 * Nothing in this test knows the order of anything. Each step is taken
 * because the payload offered it, and the assertions are about what the
 * payload offered next — so the process the test walks is the process the
 * guards describe, not one the test author remembered.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buyerActor, organizer } from '../src/state.js'
import {
  blocked,
  type Client,
  createClient,
  createPool,
  offered,
  unmetOf,
} from './harness.js'

const pool = createPool()
let client: Client

beforeAll(async () => {
  client = await createClient(pool, { services: { attempts: 3 } })
})

afterAll(async () => {
  await client.app.stop()
  await pool.end()
})

describe('a group house purchase, from nothing to closed', () => {
  it('walks the whole happy path with no knowledge of the process', async () => {
    const caseId = await client.create(organizer)

    // 1. A fresh purchase offers exactly two things: accept the offer, invite
    //    somebody. Everything else is blocked on facts that do not exist yet.
    expect(offered(await client.affordances(caseId, organizer))).toEqual([
      'accept-offer',
      'invite-buyer',
    ])

    // 2. Purchase setup is a linear stretch, and the payload enforces it one
    //    step at a time — each guard reading the previous step's effect.
    await client.take(caseId, organizer, 'accept-offer')
    expect(offered(await client.affordances(caseId, organizer))).toContain(
      'obtain-inspection-report',
    )
    await client.take(caseId, organizer, 'obtain-inspection-report')
    await client.take(caseId, organizer, 'open-escrow')

    // The escrow company has the application; the account is not open. The
    // case is waiting on a provider, and says so by offering nothing about
    // the escrow account.
    expect((await client.state(caseId)).escrow.status).toBe('requested')
    expect(offered(await client.affordances(caseId, organizer))).not.toContain(
      'record-escrow-account',
    )

    // 3. The provider answers — late, and three times over.
    await client.settle()
    expect((await client.state(caseId)).escrow.status).toBe('open')

    // 4. Two buyers. Each is an independent track from here — and each
    //    identity is the server's, minted as `buyer:<uuid>` on invitation.
    await client.take(caseId, organizer, 'invite-buyer', {
      input: { name: 'Ada' },
    })
    await client.take(caseId, organizer, 'invite-buyer', {
      input: { name: 'Bo' },
    })
    const ada = await client.buyerIdOf(caseId, 'Ada')
    const bo = await client.buyerIdOf(caseId, 'Bo')
    expect(ada).toMatch(/^buyer:[0-9a-f-]{36}$/)

    // Committing is buyer-only: the organizer holds nobody's commitment,
    // and each buyer sees exactly their own.
    expect(offered(await client.affordances(caseId, organizer))).not.toContain(
      `record-commitment(${ada})`,
    )
    expect(offered(await client.affordances(caseId, buyerActor(ada)))).toEqual([
      `record-commitment(${ada})`,
    ])
    expect(offered(await client.affordances(caseId, buyerActor(bo)))).toEqual([
      `record-commitment(${bo})`,
    ])

    // 5. A buyer takes their own affordance, as themselves.
    await client.take(caseId, buyerActor(ada), 'record-commitment', {
      scopeKey: ada,
      input: { amount: 600_000 },
    })
    // …and only as themselves: committing is deliberately buyer-only, so
    // the organizer cannot do it on anyone's behalf.
    await client.take(caseId, buyerActor(bo), 'record-commitment', {
      scopeKey: bo,
      input: { amount: 400_000 },
    })

    // 6. Verification per buyer, answered by the provider out of band.
    await client.take(caseId, organizer, 'start-verification', {
      scopeKey: ada,
    })
    await client.take(caseId, organizer, 'start-verification', { scopeKey: bo })
    await client.settle()

    const cleared = await client.state(caseId)
    expect(cleared.buyers.map((b) => b.verification.status)).toEqual([
      'clear',
      'clear',
    ])

    // 7. Agreements: sent, signed elsewhere, materialized on the webhook.
    await client.take(caseId, organizer, 'send-agreement', { scopeKey: ada })
    await client.take(caseId, organizer, 'send-agreement', { scopeKey: bo })
    await client.settle()
    expect(
      (await client.state(caseId)).buyers.every((b) => b.agreement?.signed),
    ).toBe(true)

    // 8. Now — and only now — the funding call is on offer.
    const fundable = await client.affordances(caseId, organizer)
    expect(offered(fundable)).toContain('issue-funding-call')
    await client.take(caseId, organizer, 'issue-funding-call', {
      input: { reference: 'CALL-2026-08' },
    })

    // 9. The money arrives. Each announcement executes `record-wire` through
    //    ingestion, classified at the same commit — nobody takes an
    //    affordance for it.
    const state = await client.state(caseId)
    client.app.services.announceWire({
      applicationId: state.escrow.applicationId!,
      buyerId: ada,
      amount: 600_000,
    })
    client.app.services.announceWire({
      applicationId: state.escrow.applicationId!,
      buyerId: bo,
      amount: 400_000,
    })
    await client.settle()

    const wired = await client.state(caseId)
    expect(wired.wires.map((w) => w.outcome)).toEqual(['matched', 'matched'])

    // 10. Closing, and then the deed — an ordinary step on a dormant case.
    const closable = await client.affordances(caseId, organizer)
    expect(offered(closable)).toContain('close-purchase')
    const closed = await client.take(caseId, organizer, 'close-purchase')
    expect(closed.execution.dormancy).toBe('ended')

    const afterClose = await client.affordances(caseId, organizer)
    expect(afterClose.case.endedAt).not.toBeNull()
    expect(offered(afterClose)).toEqual(['record-deed'])

    await client.take(caseId, organizer, 'record-deed')
    expect((await client.state(caseId)).purchase.deedRecordedAt).not.toBeNull()
  })

  it('says why the closing step is blocked, in the domain’s own words', async () => {
    const caseId = await client.create(organizer)

    const payload = await client.affordances(caseId, organizer)

    expect(blocked(payload)).toContain('close-purchase')
    expect(unmetOf(payload, 'close-purchase')).toEqual(['called', 'funded'])
    const reason = payload.blocked
      .find((entry) => entry.step === 'close-purchase')
      ?.unmet.find((condition) => condition.name === 'called')?.reason
    expect(reason).toBe('the funding call has not been issued')
  })

  it('deduplicates a provider that delivers the same webhook three times', async () => {
    const caseId = await client.create(organizer)
    await client.take(caseId, organizer, 'accept-offer')
    await client.take(caseId, organizer, 'obtain-inspection-report')
    await client.take(caseId, organizer, 'open-escrow')

    const applicationId = (await client.state(caseId)).escrow.applicationId!
    const results = (await client.app.services.flush(client.app.engine)).filter(
      (result) => result.externalId === applicationId,
    )

    // Three deliveries of one webhook: one Execution, two duplicates.
    expect(results.map((result) => result.status).sort()).toEqual([
      'duplicate',
      'duplicate',
      'executed',
    ])
    const opened = await client.journal(caseId, {
      step: 'record-escrow-account',
      entry: 'completed',
    })
    expect(opened).toHaveLength(1)
  })

  it('refuses a buyer another buyer’s affordance, without naming the rule', async () => {
    const caseId = await client.create(organizer)
    await client.take(caseId, organizer, 'invite-buyer', {
      input: { name: 'Ada' },
    })
    await client.take(caseId, organizer, 'invite-buyer', {
      input: { name: 'Bo' },
    })
    const ada = await client.buyerIdOf(caseId, 'Ada')
    const bo = await client.buyerIdOf(caseId, 'Bo')

    const asA = await client.affordances(caseId, buyerActor(ada))
    const rejected = await client.attempt(
      caseId,
      buyerActor(ada),
      'record-commitment',
      {
        scopeKey: bo,
        input: { amount: 1 },
      },
    )

    expect(offered(asA)).toEqual([`record-commitment(${ada})`])
    expect(rejected.status).toBe(409)
    expect(rejected.body).toMatchObject({
      error: 'step-not-available',
      permitted: false,
    })
    expect(JSON.stringify(rejected.body)).not.toContain('isThisBuyer')
  })
})

/**
 * Ingestion and correlation against a real database, including the two
 * criteria the issue names: three deliveries of one webhook produce exactly
 * one Execution, and an event nobody can route lands visibly in the
 * dead-letter surface with a reason.
 */

import { randomUUID } from 'node:crypto'
import { testPool } from '@affordance/testkit'
import { describe, expect, it } from 'vitest'
import { createEngine } from '../../src/engine/index.js'
import { foldExecutions } from '../../src/execution/index.js'
import { externalActor, idempotencyKeyFor } from '../../src/ingestion/index.js'
import { FRAMEWORK_SCHEMA } from '../../src/store/index.js'
import { organizer, type Signing, signing, twoBuyers } from './fixture.js'

const pool = testPool()
const engine = createEngine({ db: { pool }, caseTypes: [signing] })

const newCase = () => engine.createCase(signing.name, twoBuyers())

/**
 * Ingestion's whole job is to remember events forever, so a suite that reused
 * ids would deduplicate against its own previous run. Every external id and
 * delivery id here is unique to this run, exactly as a real provider's are.
 */
const RUN = randomUUID().slice(0, 8)
const unique = (name: string): string => `${name}_${RUN}`

const stateOf = async (caseId: string): Promise<Signing> => {
  const { rows } = await pool.query<{ state: Signing }>(
    `select state from ${FRAMEWORK_SCHEMA}.cases where id = $1`,
    [caseId],
  )
  return rows[0]!.state
}

/** One buyer, with their envelope sent and correlated by the handler. */
const withEnvelope = async (buyer = 'buyer_a') => {
  const created = await newCase()
  const result = await engine.execute(created.id, 'send-envelope', {
    actor: organizer,
    scopeKey: buyer,
  })
  const envelopeId = (result.state as Signing).buyers.find(
    (i) => i.id === buyer,
  )!.envelopeId!
  return { created, envelopeId }
}

const signedEvent = (envelopeId: string, eventId: string) => ({
  system: 'esign',
  externalId: envelopeId,
  type: 'envelope.completed',
  eventId,
  payload: { signedAt: '2026-08-05T10:00:00.000Z' },
})

describe('correlation', () => {
  it('is registered by the handler that starts the interaction, in the same commit', async () => {
    const { created, envelopeId } = await withEnvelope('buyer_a')

    const correlations = await engine.correlations(created.id)
    expect(correlations).toHaveLength(1)
    expect(correlations[0]).toMatchObject({
      system: 'esign',
      externalId: envelopeId,
      caseId: created.id,
      // A scoped handler's registration defaults to its own element.
      scopeKey: 'buyer_a',
      step: 'record-signature',
    })
  })

  it('rolls back with the commit it rode in on', async () => {
    const created = await newCase()

    // `record-brokenly` throws, so its Execution never commits — and a
    // correlation registered by a failed attempt must not survive either.
    await expect(
      engine.execute(created.id, 'record-brokenly', { actor: organizer }),
    ).rejects.toThrow()

    expect(await engine.correlations(created.id)).toEqual([])
  })

  it('re-registering the same identifier is the same fact, not an error', async () => {
    const created = await newCase()

    const first = await engine.correlate({
      system: 'verify',
      externalId: unique('chk_1'),
      caseId: created.id,
      scopeKey: 'buyer_a',
      step: 'record-signature',
    })
    const second = await engine.correlate({
      system: 'verify',
      externalId: unique('chk_1'),
      caseId: created.id,
      scopeKey: 'buyer_b',
      step: 'record-signature',
    })

    expect(second.id).toBe(first.id)
    expect(second.scopeKey).toBe('buyer_b')
    expect(await engine.correlations(created.id, 'buyer_b')).toHaveLength(1)
  })
})

describe('ingestion', () => {
  it('routes an event to the correlated step, with the external system as the actor', async () => {
    const { created, envelopeId } = await withEnvelope('buyer_a')

    const result = await engine.ingest(signedEvent(envelopeId, unique('evt_1')))

    expect(result.status).toBe('executed')
    expect(result.correlation?.caseId).toBe(created.id)
    expect((await stateOf(created.id)).buyers[0]?.signedAt).toBe(
      '2026-08-05T10:00:00.000Z',
    )

    const execution = foldExecutions(await engine.journal(created.id)).find(
      (record) => record.step === 'record-signature',
    )
    expect(execution).toMatchObject({
      scopeKey: 'buyer_a',
      status: 'completed',
      actor: {
        kind: 'external',
        system: 'esign',
        externalId: envelopeId,
        eventType: 'envelope.completed',
      },
      input: { signedAt: '2026-08-05T10:00:00.000Z' },
    })
  })

  it('produces exactly one Execution when a provider delivers the same webhook three times', async () => {
    const { created, envelopeId } = await withEnvelope('buyer_b')
    const event = signedEvent(envelopeId, unique('evt_retry'))

    const [first, second, third] = await Promise.all([
      engine.ingest(event),
      engine.ingest(event),
      engine.ingest(event),
    ])

    const statuses = [first, second, third]
      .map((result) => result.status)
      .sort()
    expect(statuses).toEqual(['duplicate', 'duplicate', 'executed'])
    const signatures = (await engine.journal(created.id)).filter(
      (entry) =>
        entry.step === 'record-signature' && entry.entry === 'completed',
    )
    expect(signatures).toHaveLength(1)
    // All three deliveries agree on which record they are.
    expect(
      new Set([first, second, third].map((result) => result.idempotencyKey))
        .size,
    ).toBe(1)
  })

  it('dedups a provider with no event id on the payload’s content', async () => {
    const { created, envelopeId } = await withEnvelope('buyer_a')
    const event = {
      system: 'esign',
      externalId: envelopeId,
      type: 'envelope.completed',
      payload: { signedAt: '2026-08-05T11:00:00.000Z' },
    }

    const first = await engine.ingest(event)
    const second = await engine.ingest({ ...event })

    expect(first.status).toBe('executed')
    expect(second.status).toBe('duplicate')
    // The key is (system, external id, type) plus a content hash — so a
    // *different* payload about the same envelope is a different event.
    expect(idempotencyKeyFor(event)).toMatch(
      new RegExp(`^esign/${envelopeId}/envelope\\.completed/[0-9a-f]{32}$`),
    )
    expect(idempotencyKeyFor(event)).not.toBe(
      idempotencyKeyFor({
        ...event,
        payload: { signedAt: '2026-08-06T11:00:00.000Z' },
      }),
    )
    expect((await stateOf(created.id)).notes).toEqual([
      'signature recorded for buyer_a',
    ])
  })

  it('routes a case-level correlation to an unscoped step', async () => {
    const created = await newCase()
    await engine.correlate({
      system: 'esign',
      externalId: unique('env_purchase'),
      caseId: created.id,
      step: 'record-purchase-document',
    })

    const result = await engine.ingest({
      system: 'esign',
      externalId: unique('env_purchase'),
      type: 'document.filed',
      eventId: unique('evt_purchase'),
      payload: { documentId: 'doc_1' },
    })

    expect(result.status).toBe('executed')
    expect((await stateOf(created.id)).notes).toEqual([
      'purchase document doc_1',
    ])
  })
})

describe('the dead-letter surface', () => {
  it('lands an event with an unknown external id there, with a reason', async () => {
    const orphan = unique('env_nobody_knows')
    const result = await engine.ingest({
      system: 'esign',
      externalId: orphan,
      type: 'envelope.completed',
      eventId: unique('evt_orphan'),
      payload: { signedAt: '2026-08-05T10:00:00.000Z' },
    })

    expect(result).toMatchObject({
      status: 'dead-lettered',
      reason: 'unrouted',
    })
    expect(result.detail).toMatch(
      new RegExp(`no correlation registered for esign/${orphan}`),
    )

    const letters = await engine.deadLetters({
      system: 'esign',
      reason: 'unrouted',
    })
    const mine = letters.find((letter) => letter.externalId === orphan)
    expect(mine).toMatchObject({
      type: 'envelope.completed',
      caseId: null,
      reason: 'unrouted',
    })
    // The event itself is kept verbatim, so it can be replayed by hand.
    expect(mine?.event.payload).toEqual({
      signedAt: '2026-08-05T10:00:00.000Z',
    })
  })

  it('lands a routed event whose guard refuses the step, naming the unmet conditions', async () => {
    const created = await newCase()
    await engine.correlate({
      system: 'esign',
      externalId: unique('env_decline'),
      caseId: created.id,
      scopeKey: 'buyer_a',
      step: 'record-decline',
    })

    const result = await engine.ingest({
      system: 'esign',
      externalId: unique('env_decline'),
      type: 'envelope.declined',
      eventId: unique('evt_decline'),
    })

    expect(result).toMatchObject({
      status: 'dead-lettered',
      reason: 'step-not-available',
    })
    expect(result.detail).toMatch(/requires\.purchaseClosed/)
    const letters = await engine.deadLetters({ caseId: created.id })
    expect(letters[0]).toMatchObject({
      step: 'record-decline',
      scopeKey: 'buyer_a',
    })
  })

  it('lands an event whose correlation names no step', async () => {
    const created = await newCase()
    await engine.correlate({
      system: 'verify',
      externalId: unique('chk_no_step'),
      caseId: created.id,
    })

    const result = await engine.ingest({
      system: 'verify',
      externalId: unique('chk_no_step'),
      type: 'check.completed',
      eventId: unique('evt_no_step'),
    })

    expect(result).toMatchObject({ status: 'dead-lettered', reason: 'no-step' })
  })

  it('lands a failed handler’s event, and lets the provider’s next retry through', async () => {
    const created = await newCase()
    await engine.correlate({
      system: 'verify',
      externalId: unique('chk_boom'),
      caseId: created.id,
      step: 'record-brokenly',
    })
    const event = {
      system: 'verify',
      externalId: unique('chk_boom'),
      type: 'check.completed',
      eventId: unique('evt_boom'),
    }

    const first = await engine.ingest(event)
    expect(first).toMatchObject({
      status: 'dead-lettered',
      reason: 'execution-failed',
    })
    expect(first.detail).toMatch(/the materializing handler blew up/)

    // A retry of a transiently-failed delivery is not a duplicate: it gets
    // another go, and fails the same way (the fixture always throws).
    const second = await engine.ingest(event)
    expect(second.status).toBe('dead-lettered')

    // A delivery that already *succeeded*, by contrast, stays deduplicated.
    const done = await withEnvelope('buyer_a')
    const signed = signedEvent(done.envelopeId, unique('evt_settled'))
    expect((await engine.ingest(signed)).status).toBe('executed')
    expect((await engine.ingest(signed)).status).toBe('duplicate')
    expect((await stateOf(done.created.id)).notes).toHaveLength(1)
  })

  it('keeps a schema-rejected payload dead as invalid-input — a retry cannot cure it', async () => {
    const { envelopeId } = await withEnvelope('buyer_a')
    const event = {
      system: 'esign',
      externalId: envelopeId,
      type: 'envelope.completed',
      eventId: unique('evt_bad_payload'),
      payload: { signedAt: 123 },
    }

    const first = await engine.ingest(event)
    expect(first).toMatchObject({
      status: 'dead-lettered',
      reason: 'invalid-input',
    })

    // The provider will redeliver this forever; every redelivery is a
    // duplicate, not another Execution — the refusal is deterministic.
    const second = await engine.ingest(event)
    expect(second.status).toBe('duplicate')
    expect(
      await engine.deadLetters({ reason: 'invalid-input' }),
    ).not.toHaveLength(0)
  })
})

describe('actor mapping', () => {
  it('lets the app map an event to its own actor shape', async () => {
    const mapped = createEngine({
      db: { pool },
      caseTypes: [signing],
      ingestion: {
        actor: (event) => ({
          id: `system:${event.system}`,
          roles: ['integration'],
        }),
      },
    })
    const created = await newCase()
    const sent = await mapped.execute(created.id, 'send-envelope', {
      actor: organizer,
      scopeKey: 'buyer_a',
    })
    const envelopeId = (sent.state as Signing).buyers[0]!.envelopeId!

    await mapped.ingest(signedEvent(envelopeId, unique('evt_mapped')))

    const execution = foldExecutions(await mapped.journal(created.id)).find(
      (record) => record.step === 'record-signature',
    )
    expect(execution?.actor).toEqual({
      id: 'system:esign',
      roles: ['integration'],
    })
    // The default is the framework's external actor, for apps that want it.
    expect(externalActor(signedEvent('env_x', 'evt_x'))).toEqual({
      kind: 'external',
      system: 'esign',
      externalId: 'env_x',
      eventType: 'envelope.completed',
    })
  })
})

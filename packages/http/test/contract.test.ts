/**
 * The contract, tested as a contract — pure serializers over hand-built
 * records, no engine, no database.
 *
 * Two things are pinned here. First, the exact bytes: hrefs (including the
 * literal `:` in typed ids), `scopeKey` absence-vs-null, and the payload
 * shapes of all the routes that used to serialize themselves inline. Second,
 * the audience rule at every surface that carries condition results — most
 * pointedly the journal, whose `claimed` entries record the full guard
 * evaluation and the Case State it ran against, neither of which is a
 * caller's business under `permitted` visibility.
 */

import type {
  CaseAffordances,
  DeadLetter,
  ExecutionResult,
  GuardEvaluation,
  IngestionResult,
  JournalEntry,
} from '@affordance/core'
import { describe, expect, it } from 'vitest'
import type { ContractContext } from '../src/contract.js'
import {
  toAffordancePayload,
  toDeadLettersPayload,
  toExecutionPayload,
  toIngestionPayload,
  toJournalPayload,
} from '../src/contract.js'

const context = (visibility: 'permitted' | 'all'): ContractContext => ({
  basePath: '/api',
  visibility,
  describeStep: () => ({ required: false, schema: null, vendor: null }),
  metadataFor: () => ({ title: null, description: null }),
})

/** A recorded evaluation whose permits condition names an internal rule. */
const evaluation: GuardEvaluation = {
  asOf: '2026-08-05T00:00:00.000Z',
  possible: true,
  permitted: false,
  available: false,
  conditions: [
    {
      name: 'escrowReady',
      section: 'requires',
      kind: 'condition',
      passed: true,
    },
    {
      name: 'isThisBuyer',
      section: 'permits',
      kind: 'condition',
      passed: false,
      reason: 'acting buyer must own the track',
    },
  ],
}

const execution: ExecutionResult = {
  executionId: 'exec:9a2c',
  caseId: 'case:5f1b',
  caseTypeName: 'house-purchase',
  step: 'record-commitment',
  scopeKey: 'buyer:7',
  attempts: 1,
  guard: evaluation,
  state: { secret: 'the whole case document' },
  delta: [{ op: 'add', path: '/committed', value: true }],
  seq: 4,
  dormancy: null,
  endedAt: null,
  claimedAt: '2026-08-05T00:00:01.000Z',
  committedAt: '2026-08-05T00:00:02.000Z',
}

describe('the execution payload', () => {
  it('carries the descriptor, never the record — no state, no guard', () => {
    const payload = toExecutionPayload(execution, context('permitted'))
    expect(payload.execution).toEqual({
      executionId: 'exec:9a2c',
      caseId: 'case:5f1b',
      caseType: 'house-purchase',
      step: 'record-commitment',
      scopeKey: 'buyer:7',
      attempts: 1,
      seq: 4,
      delta: [{ op: 'add', path: '/committed', value: true }],
      dormancy: null,
      endedAt: null,
      claimedAt: '2026-08-05T00:00:01.000Z',
      committedAt: '2026-08-05T00:00:02.000Z',
    })
    expect(JSON.stringify(payload)).not.toContain('the whole case document')
    expect(JSON.stringify(payload)).not.toContain('isThisBuyer')
  })

  it('keeps typed ids literal in hrefs and nulls an absent scopeKey', () => {
    const { scopeKey: _ignored, ...unscopedRest } = execution
    const unscoped: ExecutionResult = unscopedRest
    const payload = toExecutionPayload(unscoped, context('permitted'))
    expect(payload.execution.scopeKey).toBeNull()
    expect(payload.links.affordances.href).toBe(
      '/api/cases/case:5f1b/affordances',
    )
    expect(payload.links.journal.href).toBe(
      '/api/cases/case:5f1b/journal?executionId=exec:9a2c',
    )
  })
})

describe('the affordance payload', () => {
  const record: CaseAffordances = {
    caseId: 'case:5f1b',
    caseTypeName: 'house-purchase',
    asOf: '2026-08-05T00:00:00.000Z',
    endedAt: null,
    affordances: [{ step: 'record-commitment', scopeKey: 'buyer:7' }],
    blocked: [
      {
        step: 'close-purchase',
        possible: false,
        permitted: true,
        unmet: [
          {
            name: 'funded',
            section: 'requires',
            kind: 'condition',
            passed: false,
          },
          {
            name: 'isOrganizer',
            section: 'permits',
            kind: 'condition',
            passed: false,
          },
        ],
      },
      { step: 'record-deed', possible: true, permitted: false, unmet: [] },
    ],
  }

  it('drops not-permitted entries and permits conditions under permitted visibility', () => {
    const payload = toAffordancePayload(record, context('permitted'))
    expect(payload.blocked.map((entry) => entry.step)).toEqual([
      'close-purchase',
    ])
    expect(
      payload.blocked[0]!.unmet.map((condition) => condition.name),
    ).toEqual(['funded'])
    expect(JSON.stringify(payload)).not.toContain('isOrganizer')
  })

  it('shows everything to the operator', () => {
    const payload = toAffordancePayload(record, context('all'))
    expect(payload.blocked.map((entry) => entry.step)).toEqual([
      'close-purchase',
      'record-deed',
    ])
    expect(
      payload.blocked[0]!.unmet.map((condition) => condition.name),
    ).toEqual(['funded', 'isOrganizer'])
  })

  it('leaves scopeKey absent — not null — on unscoped entries', () => {
    const payload = toAffordancePayload(record, context('permitted'))
    expect('scopeKey' in payload.blocked[0]!).toBe(false)
    expect(payload.affordances[0]!.scopeKey).toBe('buyer:7')
  })

  it('carries the definition’s title and description on every entry', () => {
    const withMetadata: ContractContext = {
      ...context('permitted'),
      metadataFor: (_caseType, step) => ({
        title: `Title of ${step}`,
        description: null,
      }),
    }
    const payload = toAffordancePayload(record, withMetadata)
    for (const entry of [...payload.affordances, ...payload.blocked]) {
      expect(entry.title).toBe(`Title of ${entry.step}`)
      expect(entry.description).toBeNull()
    }
  })
})

describe('the journal payload', () => {
  const claimed: JournalEntry = {
    ordinal: 12,
    id: 'jrnl:1',
    caseId: 'case:5f1b',
    executionId: 'exec:9a2c',
    entry: 'claimed',
    attempt: 1,
    step: 'record-commitment',
    scopeKey: 'buyer:7',
    actor: { id: 'buyer:7', roles: ['buyer'] },
    input: { amount: 250_000 },
    asOf: '2026-08-05T00:00:00.000Z',
    guard: evaluation,
    state: { secret: 'the whole case document' },
    delta: null,
    dormancy: null,
    error: null,
    recordedAt: '2026-08-05T00:00:01.000Z',
  }

  it('redacts the recorded guard and omits the state under permitted visibility', () => {
    const payload = toJournalPayload([claimed], context('permitted'))
    const entry = payload.entries[0]!
    // The verdict survives; the rule that decided it does not.
    expect(entry.guard).toMatchObject({
      possible: true,
      permitted: false,
      available: false,
    })
    expect(entry.guard!.conditions.map((condition) => condition.name)).toEqual([
      'escrowReady',
    ])
    expect('state' in entry).toBe(false)
    const wire = JSON.stringify(payload)
    expect(wire).not.toContain('isThisBuyer')
    expect(wire).not.toContain('the whole case document')
  })

  it('serves the operator the evidence whole', () => {
    const entry = toJournalPayload([claimed], context('all')).entries[0]!
    expect(entry.guard!.conditions.map((condition) => condition.name)).toEqual([
      'escrowReady',
      'isThisBuyer',
    ])
    expect(entry.state).toEqual({ secret: 'the whole case document' })
  })
})

describe('the ingestion payload', () => {
  const result: IngestionResult = {
    id: 'event:1',
    status: 'executed',
    system: 'escrow',
    externalId: 'wire_1',
    idempotencyKey: 'escrow/wire_1/wire.received/d1',
    correlation: {
      id: 'corr:1',
      system: 'escrow',
      externalId: 'wire_1',
      caseId: 'case:5f1b',
      scopeKey: null,
      step: 'record-wire',
      metadata: { appSecret: 'not wire business' },
      createdAt: '2026-08-04T00:00:00.000Z',
    },
    execution,
    reason: null,
    detail: null,
    receivedAt: '2026-08-05T00:00:03.000Z',
  }

  it('carries the execution descriptor and a slim correlation — no state, no guard, no metadata', () => {
    const payload = toIngestionPayload(result)
    expect(payload.ingestion.execution).toMatchObject({
      executionId: 'exec:9a2c',
      seq: 4,
    })
    expect(payload.ingestion.correlation).toEqual({
      system: 'escrow',
      externalId: 'wire_1',
      caseId: 'case:5f1b',
      scopeKey: null,
      step: 'record-wire',
    })
    const wire = JSON.stringify(payload)
    expect(wire).not.toContain('the whole case document')
    expect(wire).not.toContain('isThisBuyer')
    expect(wire).not.toContain('not wire business')
  })
})

describe('the dead-letter payload', () => {
  it('pins the row shape, reason included', () => {
    const letter: DeadLetter = {
      id: 'event:2',
      system: 'esign',
      externalId: 'env_9',
      type: 'envelope.completed',
      idempotencyKey: 'esign/env_9/envelope.completed/d2',
      caseId: 'case:5f1b',
      scopeKey: 'buyer:7',
      step: 'record-signature',
      reason: 'invalid-input',
      detail: 'input failed the schema',
      event: {
        system: 'esign',
        externalId: 'env_9',
        type: 'envelope.completed',
      },
      receivedAt: '2026-08-05T00:00:04.000Z',
    }
    expect(toDeadLettersPayload([letter])).toEqual({
      contract: 'affordance/v1',
      deadLetters: [letter],
    })
  })
})

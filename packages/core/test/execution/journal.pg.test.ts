import { expectJsonRoundTrips, testPool } from '@affordance/testkit'
import { beforeAll, describe, expect, it } from 'vitest'
import { createEngine } from '../../src/engine/index.js'
import {
  foldExecutions,
  isClaimedEntry,
  readJournal,
  replayGuard,
} from '../../src/execution/index.js'
import { caseType, step } from '../../src/model/index.js'
import { insertCase } from '../../src/store/index.js'
import {
  amendmentState,
  control,
  organizer,
  type Purchase,
  PurchaseState,
  purchaseExecution,
  resetControl,
} from './fixture.js'

const pool = testPool()
const engine = createEngine({
  db: { pool },
  caseTypes: [purchaseExecution],
  claimTtlMs: 2_000,
  heartbeatMs: 500,
})

/**
 * One case carried through a realistic run — two tracks re-papered, a failed
 * Execution, a close — so the journal assertions read against a story rather
 * than a synthetic row set.
 */
let caseId: string

beforeAll(async () => {
  resetControl()
  const created = await insertCase(
    pool,
    purchaseExecution.name,
    PurchaseState,
    amendmentState(),
  )
  caseId = created.id

  await engine.execute(caseId, 'request-re-sign', {
    actor: organizer,
    scopeKey: 'buyer_a',
  })
  await engine.execute(caseId, 'request-re-sign', {
    actor: organizer,
    scopeKey: 'buyer_b',
  })
  control.failuresRemaining = Number.MAX_SAFE_INTEGER
  await engine
    .execute(caseId, 'flaky', {
      actor: organizer,
      retry: { maxAttempts: 2, delayMs: 0 },
    })
    .catch(() => undefined)
  resetControl()
  await engine.execute(caseId, 'close-purchase', { actor: organizer })
})

describe('journal reads', () => {
  it('returns the case’s entries oldest-first, and is JSON-serializable throughout', async () => {
    const entries = await engine.journal(caseId)
    expect(entries.map((entry) => `${entry.step}:${entry.entry}`)).toEqual([
      'request-re-sign:claimed',
      'request-re-sign:completed',
      'request-re-sign:claimed',
      'request-re-sign:completed',
      'flaky:claimed',
      'flaky:attempt-failed',
      'flaky:failed',
      'close-purchase:claimed',
      'close-purchase:completed',
    ])
    expect(entries.map((entry) => entry.ordinal)).toEqual(
      [...entries.map((e) => e.ordinal)].sort((a, b) => a - b),
    )
    expectJsonRoundTrips(entries)
  })

  it('filters by scope key — the per-track audit', async () => {
    const track = await engine.journal(caseId, { scopeKey: 'buyer_b' })
    expect(track).toHaveLength(2)
    expect(track.every((entry) => entry.scopeKey === 'buyer_b')).toBe(true)
    expect(track.every((entry) => entry.step === 'request-re-sign')).toBe(true)
  })

  it('filters by step, entry type, and Execution', async () => {
    expect(await engine.journal(caseId, { step: 'flaky' })).toHaveLength(3)
    expect(await engine.journal(caseId, { entry: 'completed' })).toHaveLength(3)
    expect(
      await engine.journal(caseId, { entry: ['failed', 'attempt-failed'] }),
    ).toHaveLength(2)

    const [claimed] = await engine.journal(caseId, {
      step: 'close-purchase',
      entry: 'claimed',
    })
    const execution = await engine.journal(caseId, {
      executionId: claimed!.executionId,
    })
    expect(execution.map((entry) => entry.entry)).toEqual([
      'claimed',
      'completed',
    ])
  })

  it('pages with since + limit', async () => {
    const all = await engine.journal(caseId)
    const firstTwo = await engine.journal(caseId, { limit: 2 })
    expect(firstTwo.map((e) => e.ordinal)).toEqual(
      all.slice(0, 2).map((e) => e.ordinal),
    )
    const rest = await engine.journal(caseId, { since: firstTwo[1]!.ordinal })
    expect(rest.map((e) => e.ordinal)).toEqual(
      all.slice(2).map((e) => e.ordinal),
    )
  })

  it('is append-only in practice: reading twice returns identical rows', async () => {
    const first = await readJournal(pool, caseId)
    const second = await readJournal(pool, caseId)
    expect(second).toEqual(first)
  })
})

describe('foldExecutions', () => {
  it('assembles one record per Execution, in first-appearance order', async () => {
    const executions = foldExecutions(await engine.journal(caseId))
    expect(executions.map((e) => `${e.step}:${e.status}`)).toEqual([
      'request-re-sign:completed',
      'request-re-sign:completed',
      'flaky:failed',
      'close-purchase:completed',
    ])

    const [buyer_a] = executions
    expect(buyer_a).toMatchObject({
      scopeKey: 'buyer_a',
      attempts: 1,
      actor: organizer,
      dormancy: null,
    })
    expect(buyer_a?.guard?.available).toBe(true)
    expect(buyer_a?.delta).not.toBeNull()
    expect(buyer_a?.claimedAt).not.toBeNull()
    expect(buyer_a?.settledAt).not.toBeNull()

    const failed = executions[2]
    expect(failed).toMatchObject({ status: 'failed', attempts: 2, delta: null })
    expect(failed?.error?.message).toMatch(/transient failure/)

    expect(executions[3]).toMatchObject({ dormancy: 'ended' })
  })

  it('folds a filtered read into just that track’s Executions', async () => {
    const track = foldExecutions(
      await engine.journal(caseId, { scopeKey: 'buyer_a' }),
    )
    expect(track).toHaveLength(1)
    expect(track[0]).toMatchObject({
      step: 'request-re-sign',
      scopeKey: 'buyer_a',
      status: 'completed',
    })
  })
})

describe('audit reconstruction', () => {
  it('a guard evaluated as of a journaled moment reproduces the recorded results', async () => {
    const claims = await engine.journal(caseId, { entry: 'claimed' })
    expect(claims.length).toBeGreaterThan(0)

    for (const entry of claims.filter(isClaimedEntry)) {
      const replay = replayGuard(purchaseExecution, entry)
      expect(replay.matches).toBe(true)
      expect(replay.reproduced).toEqual(replay.recorded)
      expect(replay.asOf).toBe(entry.asOf)
    }
    expect(claims.filter(isClaimedEntry)).toHaveLength(claims.length)
  })

  it('reproduces the recorded moment, not today’s answer for it', async () => {
    // buyer_a was re-papered first; by the time buyer_b's Execution was claimed,
    // the case state had already moved. Each replay must reproduce its own
    // moment — replaying against current state would not.
    const [buyerA, buyerB] = (
      await engine.journal(caseId, {
        step: 'request-re-sign',
        entry: 'claimed',
      })
    ).filter(isClaimedEntry)
    expect((buyerA!.state as Purchase).buyers[0]?.reSignRequests).toBe(0)
    expect((buyerB!.state as Purchase).buyers[0]?.reSignRequests).toBe(1)
    expect(replayGuard(purchaseExecution, buyerA!).matches).toBe(true)
    expect(replayGuard(purchaseExecution, buyerB!).matches).toBe(true)
  })

  it('surfaces definition drift instead of hiding it', async () => {
    // The same case type, deployed later with a tightened guard: cases float
    // to the latest definitions, so a replay disagreeing with the record is
    // the signal, not an error.
    const tightened = caseType({
      name: 'purchase-execution',
      state: PurchaseState,
      steps: [
        step({
          name: 'close-purchase',
          requires: {
            open: (s: Purchase) => s.purchase.closedAt === null,
            // added by a later deploy: nobody closes with re-papering outstanding
            allBuyersSigned: (s: Purchase) => ({
              ok: s.buyers.every((b) => b.agreement?.signed ?? false),
              reason: 'some buyers have not signed the amended documents',
            }),
          },
          handler: async (s) => s,
        }),
      ],
    })

    const [claimed] = (
      await engine.journal(caseId, { step: 'close-purchase', entry: 'claimed' })
    ).filter(isClaimedEntry)
    const replay = replayGuard(tightened, claimed!)
    expect(replay.recorded.available).toBe(true)
    expect(replay.reproduced?.available).toBe(false)
    expect(replay.matches).toBe(false)
    expect(
      replay.reproduced?.conditions.find((c) => c.name === 'allBuyersSigned'),
    ).toMatchObject({
      passed: false,
      reason: 'some buyers have not signed the amended documents',
    })
  })

  it('reports a moment today’s definitions cannot address, instead of taking down the audit', async () => {
    // The strongest drift: a later deploy removed the step outright. Replay
    // is a sweep over the Journal, so an unaddressable entry is a reported
    // outcome — one drifted entry must not throw the rest of the audit away.
    const withoutStep = caseType({
      name: 'purchase-execution',
      state: PurchaseState,
      steps: [
        step({
          name: 'unrelated',
          requires: { never: () => false },
          handler: async (s: Purchase) => s,
        }),
      ],
    })
    const claims = (await engine.journal(caseId, { entry: 'claimed' })).filter(
      isClaimedEntry,
    )
    expect(claims.length).toBeGreaterThan(0)

    const replays = claims.map((entry) => replayGuard(withoutStep, entry))
    for (const replay of replays) {
      expect(replay.reproduced).toBeNull()
      expect(replay.matches).toBe(false)
      expect(replay.unaddressable?.reason).toMatch(/has no step/)
    }
  })

  it('reports a scope key that no longer selects, instead of throwing', async () => {
    // A selector tightened by a later deploy: buyer_a's journaled track is
    // still auditable — its entries replay as unaddressable, with the reason.
    const tightenedScope = caseType({
      name: 'purchase-execution',
      state: PurchaseState,
      steps: [
        step({
          name: 'request-re-sign',
          scope: {
            select: (s: Purchase) => s.buyers.filter((b) => b.id === 'nobody'),
            key: (b) => b.id,
          },
          requires: {},
          handler: async (s) => s,
        }),
      ],
    })
    const claims = (
      await engine.journal(caseId, {
        step: 'request-re-sign',
        entry: 'claimed',
      })
    ).filter(isClaimedEntry)
    expect(claims.length).toBeGreaterThan(0)

    for (const entry of claims) {
      const replay = replayGuard(tightenedScope, entry)
      expect(replay.reproduced).toBeNull()
      expect(replay.matches).toBe(false)
      expect(replay.unaddressable?.reason).toMatch(
        /no element in scope has key/,
      )
    }
  })

  it('an entry that records no evaluation is not a claimed entry — the compiler refuses the replay', async () => {
    // `replayGuard` takes a ClaimedJournalEntry, so handing it a completed
    // entry is a type error now, not a runtime throw; `isClaimedEntry` is the
    // narrowing every replay caller goes through.
    const [completed] = await engine.journal(caseId, { entry: 'completed' })
    expect(isClaimedEntry(completed!)).toBe(false)
  })
})

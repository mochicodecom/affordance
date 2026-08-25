import { TEST_DATABASE_URL, testPool } from '@affordance/testkit'
import pg from 'pg'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createEngine } from '../../src/engine/index.js'
import {
  CaseBusyError,
  ClaimLostError,
  foldExecutions,
  StepExecutionError,
  StepNotAvailableError,
} from '../../src/execution/index.js'
import {
  ScopeKeyError,
  StepInputValidationError,
  UnknownStepError,
} from '../../src/model/index.js'
import {
  CaseStateValidationError,
  FRAMEWORK_SCHEMA,
  insertCase,
  selectCase,
} from '../../src/store/index.js'
import {
  APP_TABLE,
  amendmentState,
  buyerActor,
  control,
  createGate,
  organizer,
  type Purchase,
  PurchaseState,
  purchaseExecution,
  readyState,
  resetControl,
  waitUntil,
} from './fixture.js'

const pool = testPool()
const engine = createEngine({
  db: { pool },
  caseTypes: [purchaseExecution],
  // Short lease + fast heartbeat so the expiry tests are seconds, not minutes.
  claimTtlMs: 2_000,
  heartbeatMs: 200,
})

const newCase = (state: Purchase = readyState()) =>
  insertCase(pool, purchaseExecution.name, PurchaseState, state)

const claimRows = async (caseId: string) => {
  const { rows } = await pool.query<{ execution_id: string; expires_at: Date }>(
    `select execution_id, expires_at from ${FRAMEWORK_SCHEMA}.claims where case_id = $1`,
    [caseId],
  )
  return rows
}

beforeAll(async () => {
  await pool.query(
    `create table if not exists ${APP_TABLE} (execution_id text primary key, amount numeric not null)`,
  )
})

beforeEach(() => {
  resetControl()
})

describe('claim → run → commit', () => {
  it('commits the handler’s Case State, bumps seq, and journals the whole Execution', async () => {
    const created = await newCase()

    const result = await engine.execute(created.id, 'confirm-split', {
      actor: organizer,
    })

    expect(result.caseId).toBe(created.id)
    expect(result.caseTypeName).toBe('purchase-execution')
    expect(result.step).toBe('confirm-split')
    expect(result.scopeKey).toBeUndefined()
    expect(result.attempts).toBe(1)
    expect(result.seq).toBe(1)
    expect(result.dormancy).toBeNull()
    expect(result.endedAt).toBeNull()
    expect(result.guard.available).toBe(true)
    expect((result.state as Purchase).split.confirmed).toBe(true)
    expect(result.delta).toEqual([
      { op: 'replace', path: '/split/confirmed', value: true },
      { op: 'add', path: '/notes/-', value: 'split confirmed by ops-1' },
    ])

    // the materialized case row is the committed state
    const reloaded = await selectCase(pool, created.id, PurchaseState)
    expect(reloaded.state.split.confirmed).toBe(true)
    expect(reloaded.seq).toBe(1)

    const entries = await engine.journal(created.id)
    expect(entries.map((entry) => entry.entry)).toEqual([
      'claimed',
      'completed',
    ])
    const [claimed, completed] = entries
    expect(claimed).toMatchObject({
      executionId: result.executionId,
      step: 'confirm-split',
      scopeKey: null,
      attempt: 1,
      actor: organizer,
      dormancy: null,
    })
    // the claim entry carries the enforcement moment: guard results, the
    // instant, and the state they were evaluated against
    expect(claimed?.guard?.available).toBe(true)
    expect(claimed?.asOf).toMatch(/^\d{4}-.*Z$/)
    expect((claimed!.state as Purchase).split.confirmed).toBe(false)
    expect(completed).toMatchObject({
      executionId: result.executionId,
      delta: result.delta,
    })

    // the claim is released
    expect(await claimRows(created.id)).toHaveLength(0)
  })

  it('validates input against the step’s schema and hands the output to the handler', async () => {
    const created = await newCase()
    await engine.execute(created.id, 'confirm-split', { actor: organizer })

    const result = await engine.execute(created.id, 'issue-funding-call', {
      actor: organizer,
      input: { callAmount: 250_000 },
    })

    // ctx.executionId is the idempotency key the handler wrote through
    expect((result.state as Purchase).fundingCall).toEqual({
      amount: 250_000,
      executionId: result.executionId,
    })
    const [claimed] = await engine.journal(created.id, {
      step: 'issue-funding-call',
      entry: 'claimed',
    })
    expect(claimed?.input).toEqual({ callAmount: 250_000 })
  })

  it('rejects invalid input before claiming anything', async () => {
    const created = await newCase()
    await engine.execute(created.id, 'confirm-split', { actor: organizer })

    await expect(
      engine.execute(created.id, 'issue-funding-call', {
        actor: organizer,
        input: { callAmount: -5 },
      }),
    ).rejects.toBeInstanceOf(StepInputValidationError)

    expect(
      await engine.journal(created.id, { step: 'issue-funding-call' }),
    ).toHaveLength(0)
    expect(await claimRows(created.id)).toHaveLength(0)
  })

  it('is loud about a bad address — unknown step, or a scope key that is not selected', async () => {
    const created = await newCase(amendmentState())
    await expect(
      engine.execute(created.id, 'wire-funds', { actor: organizer }),
    ).rejects.toBeInstanceOf(UnknownStepError)
    await expect(
      engine.execute(created.id, 'request-re-sign', {
        actor: organizer,
        scopeKey: 'buyer_z',
      }),
    ).rejects.toBeInstanceOf(ScopeKeyError)
    await expect(
      engine.execute(created.id, 'request-re-sign', { actor: organizer }),
    ).rejects.toThrow(
      /a scopeKey is required — currently selected: buyer_a, buyer_b/,
    )
    expect(await engine.journal(created.id)).toHaveLength(0)
  })
})

describe('the transaction seam', () => {
  it('runs against a dedicated client as well as a pool (the app brings its database)', async () => {
    const created = await newCase()
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL })
    await client.connect()
    try {
      const clientEngine = createEngine({
        db: { client },
        caseTypes: [purchaseExecution],
      })
      const result = await clientEngine.execute(created.id, 'confirm-split', {
        actor: organizer,
      })
      expect(result.seq).toBe(1)
      expect(
        (await clientEngine.journal(created.id)).map((entry) => entry.entry),
      ).toEqual(['claimed', 'completed'])
    } finally {
      await client.end()
    }
  })
})

describe('guards advise, handlers enforce', () => {
  it('rejects with the current unmet conditions when the answer changed since render', async () => {
    const created = await newCase()
    // The affordance was real when it was rendered…
    const rendered = await engine.affordances(created.id, organizer)
    expect(rendered.affordances.map((a) => a.step)).toContain('confirm-split')

    // …and then state moved underneath it.
    await engine.execute(created.id, 'confirm-split', { actor: organizer })

    const error = await engine
      .execute(created.id, 'confirm-split', { actor: organizer })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(StepNotAvailableError)
    const rejection = error as StepNotAvailableError
    expect(rejection.possible).toBe(false)
    expect(rejection.permitted).toBe(true)
    expect(rejection.unmet).toHaveLength(1)
    expect(rejection.unmet[0]).toMatchObject({
      name: 'notConfirmed',
      section: 'requires',
      passed: false,
      reason: 'the split is already confirmed',
    })

    // a refused claim is not an Execution: nothing was journaled for it
    expect(
      await engine.journal(created.id, { step: 'confirm-split' }),
    ).toHaveLength(2)
    expect(await claimRows(created.id)).toHaveLength(0)
  })

  it('distinguishes not-permitted-for-you from not-possible', async () => {
    const created = await newCase()
    const error = await engine
      .execute(created.id, 'confirm-split', { actor: buyerActor })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(StepNotAvailableError)
    expect(error).toMatchObject({ possible: true, permitted: false })
    expect((error as StepNotAvailableError).unmet[0]).toMatchObject({
      name: 'isOrganizer',
      section: 'permits',
    })
    const reloaded = await selectCase(pool, created.id, PurchaseState)
    expect(reloaded.seq).toBe(0)
  })
})

describe('scoped execution', () => {
  it('executes one track, binds the element on ctx, and journals the scope key', async () => {
    const created = await newCase(amendmentState())

    const result = await engine.execute(created.id, 'request-re-sign', {
      actor: organizer,
      scopeKey: 'buyer_a',
    })
    expect(result.scopeKey).toBe('buyer_a')

    const state = result.state as Purchase
    expect(state.buyers[0]).toMatchObject({ id: 'buyer_a', reSignRequests: 1 })
    expect(state.buyers[1]).toMatchObject({ id: 'buyer_b', reSignRequests: 0 })

    // per-track audit is a journal filter, not a reconstruction
    const track = await engine.journal(created.id, { scopeKey: 'buyer_a' })
    expect(track.map((entry) => entry.entry)).toEqual(['claimed', 'completed'])
    expect(
      await engine.journal(created.id, { scopeKey: 'buyer_b' }),
    ).toHaveLength(0)
  })

  it('rejects a track whose own guard is unmet while its sibling stays available', async () => {
    const created = await newCase(amendmentState())
    await engine.execute(created.id, 'request-re-sign', {
      actor: organizer,
      scopeKey: 'buyer_a',
    })

    // buyer_a is now on current terms; buyer_b is untouched
    await expect(
      engine.execute(created.id, 'request-re-sign', {
        actor: organizer,
        scopeKey: 'buyer_a',
      }),
    ).rejects.toBeInstanceOf(ScopeKeyError) // no longer signed, so no longer in scope
    const result = await engine.execute(created.id, 'request-re-sign', {
      actor: organizer,
      scopeKey: 'buyer_b',
    })
    expect(result.scopeKey).toBe('buyer_b')
  })
})

describe('one in-flight Execution per case', () => {
  it('refuses a second Execution while one holds the claim', async () => {
    const created = await newCase()
    control.gate = createGate()

    const running = engine.execute(created.id, 'stall', { actor: organizer })
    await control.gate.entered

    const error = await engine
      .execute(created.id, 'confirm-split', { actor: organizer })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CaseBusyError)
    expect((error as CaseBusyError).stepName).toBe('stall')
    expect(Date.parse((error as CaseBusyError).expiresAt)).toBeGreaterThan(0)

    control.gate.open()
    await running
    // and once the case is free, the refused step runs
    await expect(
      engine.execute(created.id, 'confirm-split', { actor: organizer }),
    ).resolves.toMatchObject({ attempts: 1 })
  })

  it('exactly one of many concurrent attempts claims; the rest are refused with reasons', async () => {
    const created = await newCase()

    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        engine.execute(created.id, 'confirm-split', { actor: organizer }),
      ),
    )
    const fulfilled = outcomes.filter(
      (outcome) => outcome.status === 'fulfilled',
    )
    expect(fulfilled).toHaveLength(1)

    // every refusal says why: the case was busy, or the guard had already flipped
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') continue
      expect(
        outcome.reason instanceof CaseBusyError ||
          outcome.reason instanceof StepNotAvailableError,
      ).toBe(true)
    }

    const reloaded = await selectCase(pool, created.id, PurchaseState)
    expect(reloaded.seq).toBe(1)
    expect(reloaded.state.notes).toEqual(['split confirmed by ops-1'])
    expect(
      await engine.journal(created.id, { entry: 'completed' }),
    ).toHaveLength(1)
    expect(await claimRows(created.id)).toHaveLength(0)
  })
})

describe('a crashed handler cannot deadlock a case', () => {
  it('the claim expires, the next claimant takes over, and the zombie’s commit is refused', async () => {
    const created = await newCase()
    control.gate = createGate()

    // A handler that never returns, with a lease shorter than the heartbeat —
    // exactly what a wedged or killed process looks like to the database.
    const zombie = engine.execute(created.id, 'stall', {
      actor: organizer,
      claimTtlMs: 250,
      heartbeatMs: 60_000,
    })
    await control.gate.entered
    // Expiry is the *database's* judgement (`expires_at <= now()`), so ask it
    // rather than this process's clock — a few milliseconds of skew between
    // the two is enough to make the takeover below race.
    await waitUntil(async () => {
      const { rows } = await pool.query(
        `select 1 from ${FRAMEWORK_SCHEMA}.claims where case_id = $1 and expires_at <= now()`,
        [created.id],
      )
      return rows.length > 0
    })

    // the case is workable again
    const takeover = await engine.execute(created.id, 'confirm-split', {
      actor: organizer,
    })
    expect(takeover.seq).toBe(1)

    // …and the zombie's state write is refused when it finally finishes
    control.gate.open()
    const error = await zombie.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ClaimLostError)
    expect((error as ClaimLostError).heldBy).toBeNull()

    const reloaded = await selectCase(pool, created.id, PurchaseState)
    expect(reloaded.state.notes).toEqual(['split confirmed by ops-1'])
    expect(reloaded.seq).toBe(1)

    // the journal shows the full story, in order
    const entries = await engine.journal(created.id)
    expect(entries.map((entry) => `${entry.step}:${entry.entry}`)).toEqual([
      'stall:claimed',
      'stall:expired',
      'confirm-split:claimed',
      'confirm-split:completed',
      'stall:failed',
    ])
    const [stalled] = foldExecutions(
      await engine.journal(created.id, { step: 'stall' }),
    )
    expect(stalled).toMatchObject({ status: 'failed', attempts: 1 })
    expect(stalled?.error?.name).toBe('ClaimLostError')
  })
})

describe('retry', () => {
  it('retries a throwing handler in place — same Execution, same idempotency key', async () => {
    const created = await newCase()
    control.failuresRemaining = 2

    const result = await engine.execute(created.id, 'flaky', {
      actor: organizer,
    })

    expect(result.attempts).toBe(3)
    expect(control.attemptsSeen).toEqual([1, 2, 3])
    expect(new Set(control.executionIdsSeen)).toEqual(
      new Set([result.executionId]),
    )
    expect((result.state as Purchase).notes).toEqual([
      'flaky succeeded on attempt 3',
    ])

    const entries = await engine.journal(created.id)
    expect(entries.map((entry) => entry.entry)).toEqual([
      'claimed',
      'attempt-failed',
      'attempt-failed',
      'completed',
    ])
    expect(entries[1]).toMatchObject({
      attempt: 1,
      error: { name: 'Error', message: 'transient failure on attempt 1' },
    })
    expect(entries[3]?.attempt).toBe(3)
  })

  it('exhausted retries journal a failed Execution and release the case', async () => {
    const created = await newCase()
    control.failuresRemaining = Number.MAX_SAFE_INTEGER

    const error = await engine
      .execute(created.id, 'flaky', { actor: organizer })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(StepExecutionError)
    expect((error as StepExecutionError).attempts).toBe(3)
    expect((error as StepExecutionError).cause).toBeInstanceOf(Error)

    const entries = await engine.journal(created.id)
    expect(entries.map((entry) => entry.entry)).toEqual([
      'claimed',
      'attempt-failed',
      'attempt-failed',
      'failed',
    ])
    const [execution] = foldExecutions(entries)
    expect(execution).toMatchObject({ status: 'failed', attempts: 3 })

    // nothing was committed, and the case is free for the next Execution
    const reloaded = await selectCase(pool, created.id, PurchaseState)
    expect(reloaded.seq).toBe(0)
    expect(await claimRows(created.id)).toHaveLength(0)
    control.failuresRemaining = 0
    await expect(
      engine.execute(created.id, 'flaky', { actor: organizer }),
    ).resolves.toMatchObject({
      attempts: 1,
    })
  })

  it('does not retry a deterministic defect: state the case type’s schema rejects', async () => {
    const created = await newCase()

    const error = await engine
      .execute(created.id, 'corrupt-state', { actor: organizer })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(StepExecutionError)
    expect((error as StepExecutionError).attempts).toBe(1)
    expect((error as StepExecutionError).cause).toBeInstanceOf(
      CaseStateValidationError,
    )

    const entries = await engine.journal(created.id)
    expect(entries.map((entry) => entry.entry)).toEqual(['claimed', 'failed'])
    expect((await selectCase(pool, created.id, PurchaseState)).seq).toBe(0)
  })

  it('honours a per-call retry override', async () => {
    const created = await newCase()
    control.failuresRemaining = Number.MAX_SAFE_INTEGER

    const error = await engine
      .execute(created.id, 'flaky', {
        actor: organizer,
        retry: { maxAttempts: 1 },
      })
      .catch((e: unknown) => e)
    expect((error as StepExecutionError).attempts).toBe(1)
    expect(control.attemptsSeen).toEqual([1])
  })
})

describe('shared transaction', () => {
  it('commits an app-table write atomically with Case State', async () => {
    const created = await newCase()

    const result = await engine.execute(created.id, 'record-wire', {
      actor: organizer,
      input: { amount: 750_000 },
    })

    const { rows } = await pool.query<{ execution_id: string; amount: string }>(
      `select execution_id, amount from ${APP_TABLE} where execution_id = $1`,
      [result.executionId],
    )
    expect(rows).toHaveLength(1)
    expect(Number(rows[0]?.amount)).toBe(750_000)
    expect((result.state as Purchase).notes).toEqual(['wire recorded: 750000'])
  })

  it('a failing app-table write takes the whole commit down with it', async () => {
    const created = await newCase()

    const error = await engine
      .execute(created.id, 'record-wire', {
        actor: organizer,
        input: { amount: 10, poison: true },
      })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(StepExecutionError)

    const reloaded = await selectCase(pool, created.id, PurchaseState)
    expect(reloaded.seq).toBe(0)
    expect(reloaded.state.notes).toEqual([])
    const { rows } = await pool.query(
      `select 1 from ${APP_TABLE} where amount = 10`,
    )
    expect(rows).toHaveLength(0)
    // …and the failure is journaled without a `completed` entry
    const entries = await engine.journal(created.id)
    expect(entries.map((entry) => entry.entry)).toEqual(['claimed', 'failed'])
  })
})

describe('end() is dormancy, never a freeze', () => {
  it('journals the terminal marker, stamps ended_at, and keeps computing affordances', async () => {
    const created = await newCase()

    const result = await engine.execute(created.id, 'close-purchase', {
      actor: organizer,
    })
    expect(result.dormancy).toBe('ended')
    expect(result.endedAt).not.toBeNull()

    const [completed] = await engine.journal(created.id, { entry: 'completed' })
    expect(completed?.dormancy).toBe('ended')

    // a dormant case still answers, and still says what can happen next
    const record = await engine.affordances(created.id, organizer)
    expect(record.endedAt).toBe(result.endedAt)
    expect(record.affordances.map((a) => a.step)).toContain('reopen-purchase')
  })

  it('un-ending is an ordinary step: a dormant case can be claimed and reopened', async () => {
    const created = await newCase()
    await engine.execute(created.id, 'close-purchase', { actor: organizer })

    const reopened = await engine.execute(created.id, 'reopen-purchase', {
      actor: organizer,
    })
    expect(reopened.dormancy).toBe('reopened')
    expect(reopened.endedAt).toBeNull()
    expect(reopened.seq).toBe(2)

    const record = await engine.affordances(created.id, organizer)
    expect(record.endedAt).toBeNull()
    expect(
      await engine.journal(created.id, {
        step: 'reopen-purchase',
        entry: 'completed',
      }),
    ).toMatchObject([{ dormancy: 'reopened' }])
  })
})

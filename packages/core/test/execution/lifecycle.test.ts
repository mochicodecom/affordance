/**
 * The claim state machine, in memory — the invariants that would otherwise
 * need a running Postgres, exercised through the lifecycle port's second
 * adapter with a clock the tests advance by hand.
 *
 * `execute.pg.test.ts` remains the proof that the pg adapter's transactions
 * and row lock deliver these semantics under real concurrency; this suite is
 * where the *decisions* (busy vs. takeover, holder check, retry vs. fatal,
 * per-attempt discard, rollback of a refused takeover) run in-process,
 * where a failure can be stepped through without a database.
 *
 * Everything here talks to the fake through seeding, observation, and the
 * port itself. Mid-run interference is expressed as what it is in
 * production — a competing `runLifecycle` — never as a write around the
 * port.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { HeldClaim, LifecycleDeps } from '../../src/execution/index.js'
import {
  CaseBusyError,
  ClaimLostError,
  runLifecycle,
  StepExecutionError,
  StepNotAvailableError,
} from '../../src/execution/index.js'
import { caseType, step } from '../../src/model/index.js'
import { virtualClock } from './clock.js'
import { memoryStore } from './memory-port.js'

const State = z.object({
  count: z.number().default(0),
  open: z.boolean().default(true),
})
type S = z.output<typeof State>

const actor = { id: 'ops-1' }

const harness = () => {
  const clock = virtualClock(new Date('2026-08-05T00:00:00.000Z'))
  const tick = clock.advance
  const sideEffects: string[] = []
  let flakyFailures = 0
  // Set below, once `run` exists — the intruder step's mid-run competitor.
  let intrude: () => Promise<unknown> = async () => undefined

  const increment = step({
    name: 'increment',
    handler: async (s: S) => ({ ...s, count: s.count + 1 }),
  })
  const flaky = step({
    name: 'flaky',
    retry: { maxAttempts: 2, delayMs: 0 },
    handler: async (s: S) => {
      if (flakyFailures > 0) {
        flakyFailures -= 1
        throw new Error('transient wobble')
      }
      return { ...s, count: s.count + 1 }
    },
  })
  const corrupt = step({
    name: 'corrupt',
    handler: async (s: S) => ({
      ...s,
      count: 'not a number' as unknown as number,
    }),
  })
  const sneaky = step({
    name: 'sneaky',
    retry: { maxAttempts: 2, delayMs: 0 },
    handler: async (s: S, ctx) => {
      const attempt = ctx.attempt
      ctx.onCommit(async () => {
        sideEffects.push(`write-of-attempt-${attempt}`)
      })
      if (attempt === 1) {
        ctx.end()
        throw new Error('first attempt dies after registering intent')
      }
      return { ...s, count: s.count + 1 }
    },
  })
  const intruder = step({
    name: 'intruder',
    handler: async (s: S) => {
      // Mid-run, this Execution's lease lapses and another claimant runs a
      // whole Execution through the port — the takeover a crashed handler
      // invites. The commit below must then refuse this Execution's write.
      await intrude()
      return { ...s, count: s.count + 1 }
    },
  })
  const guarded = step({
    name: 'guarded',
    requires: { open: (s: S) => s.open },
    handler: async (s: S) => s,
  })

  const definition = caseType({
    name: 'counting',
    state: State,
    steps: [increment, flaky, corrupt, sneaky, intruder, guarded],
  })
  const store = memoryStore(clock.now, () => definition)

  const deps: LifecycleDeps = {
    now: clock.now,
    timers: clock.timers,
    claimTtlMs: 30_000,
    heartbeatMs: 3_600_000,
  }

  store.seed('case:1', 'counting', { count: 0, open: true })
  const run = (stepName: string) =>
    runLifecycle(store.port, deps, 'case:1', stepName, { actor })
  intrude = async () => {
    await tick(31_000) // the intruder's lease has lapsed…
    return run('increment') // …and a competitor executes, start to commit
  }

  return {
    store,
    run,
    tick,
    sideEffects,
    failFlakyTimes: (n: number) => {
      flakyFailures = n
    },
  }
}

describe('claim → run → commit', () => {
  it('commits state, journal and release together', async () => {
    const { store, run } = harness()
    const result = await run('increment')

    expect(result).toMatchObject({ attempts: 1, seq: 1, state: { count: 1 } })
    expect(result.delta).toEqual([{ op: 'replace', path: '/count', value: 1 }])
    expect(store.caseRow('case:1')).toMatchObject({
      state: { count: 1 },
      seq: 1,
    })
    expect(store.journal.map((entry) => entry.entry)).toEqual([
      'claimed',
      'completed',
    ])
    expect(store.claim('case:1')).toBeNull()
  })
})

describe('busy vs. takeover', () => {
  it('refuses while a live claim holds the case, writing nothing', async () => {
    const { store, run, tick } = harness()
    store.seedClaim('case:1', {
      executionId: 'exec:holder',
      step: 'increment',
      expiresAt: new Date('2026-08-05T00:00:10.000Z'),
    })
    await tick(5_000) // five seconds in: the lease has five left
    await expect(run('increment')).rejects.toBeInstanceOf(CaseBusyError)
    expect(store.journal).toEqual([])
    expect(store.claim('case:1')?.executionId).toBe('exec:holder')
  })

  it('takes over an expired claim, journaling the abandonment it found', async () => {
    const { store, run, tick } = harness()
    store.seedClaim('case:1', {
      executionId: 'exec:zombie',
      step: 'increment',
      attempt: 2,
      expiresAt: new Date('2026-08-05T00:00:10.000Z'),
    })
    await tick(11_000) // the lease has lapsed
    const result = await run('increment')

    expect(result.state).toEqual({ count: 1, open: true })
    expect(store.journal.map((entry) => entry.entry)).toEqual([
      'expired',
      'claimed',
      'completed',
    ])
    const expired = store.journal[0]!
    expect(expired).toMatchObject({ executionId: 'exec:zombie', attempt: 2 })
    expect(expired.error?.message).toContain('taken over by execution')
  })

  it('rolls a refused takeover back whole: the guard says no, the dead lease stays', async () => {
    const { store, run, tick } = harness()
    store.seed('case:1', 'counting', { count: 0, open: false })
    store.seedClaim('case:1', {
      executionId: 'exec:zombie',
      step: 'increment',
      expiresAt: new Date('2026-08-05T00:00:10.000Z'),
    })
    await tick(11_000)
    await expect(run('guarded')).rejects.toBeInstanceOf(StepNotAvailableError)
    // The abandonment record rode the rolled-back transaction: an expired
    // lease blocks nothing, and it is only worth recording when somebody
    // actually took the case over.
    expect(store.journal).toEqual([])
    expect(store.claim('case:1')?.executionId).toBe('exec:zombie')
  })
})

describe('the holder check', () => {
  it('refuses a commit whose claim was taken over mid-run', async () => {
    const { store, run } = harness()
    await expect(run('intruder')).rejects.toBeInstanceOf(ClaimLostError)

    // The competitor's Execution is the one that landed: it took over the
    // lapsed lease (journaling the abandonment), ran, and committed. The
    // intruder's own commit found its claim gone and wrote nothing.
    expect(store.caseRow('case:1')).toMatchObject({
      state: { count: 1, open: true },
      seq: 1,
    })
    expect(store.journal.map((entry) => entry.entry)).toEqual([
      'claimed',
      'expired',
      'claimed',
      'completed',
      'failed',
    ])
    expect(store.journal[4]!.error?.name).toBe('ClaimLostError')
    // The competitor committed and released; nothing holds the case now.
    expect(store.claim('case:1')).toBeNull()
  })
})

describe('retry classification', () => {
  it('retries a transient failure on the same claim and commits the attempt that survived', async () => {
    const { store, run, failFlakyTimes } = harness()
    failFlakyTimes(1)
    const result = await run('flaky')

    expect(result.attempts).toBe(2)
    expect(store.journal.map((entry) => [entry.entry, entry.attempt])).toEqual([
      ['claimed', 1],
      ['attempt-failed', 1],
      ['completed', 2],
    ])
  })

  it('fails a schema-rejecting return without retrying — the defect is deterministic', async () => {
    const { store, run } = harness()
    await expect(run('corrupt')).rejects.toBeInstanceOf(StepExecutionError)

    expect(store.journal.map((entry) => entry.entry)).toEqual([
      'claimed',
      'failed',
    ])
    expect(store.caseRow('case:1')!.seq).toBe(0)
    expect(store.claim('case:1')).toBeNull()
  })

  it('discards a failed attempt’s writes and dormancy intent with the attempt', async () => {
    const { store, run, sideEffects } = harness()
    const result = await run('sneaky')

    expect(result.attempts).toBe(2)
    // Attempt 1 registered a write and called end(); it died, and both died
    // with it. Only attempt 2's write reached the commit transaction.
    expect(sideEffects).toEqual(['write-of-attempt-2'])
    expect(result.dormancy).toBeNull()
    expect(store.caseRow('case:1')!.endedAt).toBeNull()
  })
})

describe('the lease and the timers', () => {
  // A harness of its own: these tests are about the relationship between
  // elapsed time and the lease, so the lease timings vary per test and the
  // handler itself drives the clock.
  const leaseHarness = (timings: {
    claimTtlMs: number
    heartbeatMs: number
  }) => {
    const clock = virtualClock(new Date('2026-08-05T00:00:00.000Z'))
    let during: () => Promise<void> = async () => undefined
    let failures = 0

    const slow = step({
      name: 'slow',
      handler: async (s: S) => {
        await during()
        return { ...s, count: s.count + 1 }
      },
    })
    const backoff = step({
      name: 'backoff',
      retry: { maxAttempts: 3, delayMs: (attempt) => attempt * 1_000 },
      handler: async (s: S) => {
        if (failures > 0) {
          failures -= 1
          throw new Error('transient wobble')
        }
        return { ...s, count: s.count + 1 }
      },
    })

    const definition = caseType({
      name: 'leased',
      state: State,
      steps: [slow, backoff],
    })
    const store = memoryStore(clock.now, () => definition)
    const deps: LifecycleDeps = {
      now: clock.now,
      timers: clock.timers,
      ...timings,
    }
    store.seed('case:1', 'leased', { count: 0, open: true })

    return {
      clock,
      store,
      run: (stepName: string) =>
        runLifecycle(store.port, deps, 'case:1', stepName, { actor }),
      setDuring: (fn: () => Promise<void>) => {
        during = fn
      },
      failTimes: (n: number) => {
        failures = n
      },
    }
  }

  it('a handler that outlives the TTL survives because the heartbeat kept renewing the lease', async () => {
    const h = leaseHarness({ claimTtlMs: 10_000, heartbeatMs: 3_000 })
    let midRunClaim: HeldClaim | null = null
    h.setDuring(async () => {
      // Well past the TTL; the heartbeat has beaten at 3s, 6s, 9s, 12s.
      await h.clock.advance(12_000)
      midRunClaim = h.store.claim('case:1')
    })

    const result = await h.run('slow')

    // At +12s the lease was still alive — renewal, not luck.
    expect(midRunClaim).toMatchObject({ expired: false })
    expect(result).toMatchObject({ attempts: 1, seq: 1, state: { count: 1 } })
    expect(h.store.journal.map((entry) => entry.entry)).toEqual([
      'claimed',
      'completed',
    ])
  })

  it('an expired lease nobody contended for still commits — expiry blocks nothing by itself', async () => {
    const h = leaseHarness({ claimTtlMs: 10_000, heartbeatMs: 3_600_000 })
    h.setDuring(async () => {
      await h.clock.advance(15_000) // past the TTL, heartbeat never due
    })

    const result = await h.run('slow')

    expect(result).toMatchObject({ attempts: 1, seq: 1 })
    expect(h.store.journal.map((entry) => entry.entry)).toEqual([
      'claimed',
      'completed',
    ])
  })

  it('retries bump the lease’s attempt counter and pace out on the declared backoff', async () => {
    const h = leaseHarness({ claimTtlMs: 30_000, heartbeatMs: 3_600_000 })
    h.failTimes(2)

    const pending = h.run('backoff')

    // Attempt 1 has failed; the lease already names attempt 2, and the
    // retry is parked on the declared 1s delay — attempt 2 has not run.
    await h.clock.advance(0)
    expect(h.store.claim('case:1')?.attempt).toBe(2)
    expect(h.store.journal.map((entry) => entry.entry)).toEqual([
      'claimed',
      'attempt-failed',
    ])

    await h.clock.advance(1_000)
    expect(h.store.claim('case:1')?.attempt).toBe(3)

    await h.clock.advance(2_000)
    const result = await pending

    expect(result.attempts).toBe(3)
    expect(h.clock.sleeps).toEqual([1_000, 2_000])
    expect(
      h.store.journal.map((entry) => [entry.entry, entry.attempt]),
    ).toEqual([
      ['claimed', 1],
      ['attempt-failed', 1],
      ['attempt-failed', 2],
      ['completed', 3],
    ])
  })
})

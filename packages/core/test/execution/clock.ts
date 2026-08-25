/**
 * A virtual clock: one instant driving both halves of the lifecycle's time —
 * `now` and the {@link Timers}. The behaviours under test here (lease
 * renewal, backoff pacing) are about the *relationship* between elapsed time
 * and the lease, so faking the halves independently would make every test
 * responsible for keeping them consistent. `advance` moves the instant and
 * fires every sleep and interval that falls due, in due order, yielding to
 * the event loop between firings so the lifecycle's continuations run at the
 * virtual moment they would have run at in real time.
 */

import type { Timers } from '../../src/execution/index.js'

interface PendingSleep {
  readonly dueMs: number
  readonly resolve: () => void
}

interface IntervalCell {
  readonly periodMs: number
  nextDueMs: number
  readonly fn: () => void
  stopped: boolean
}

export interface VirtualClock {
  readonly now: () => Date
  readonly timers: Timers
  /** The delays `sleep` was asked for, in order — the backoff schedule as observed. */
  readonly sleeps: readonly number[]
  /** Move the instant forward, firing due sleeps and intervals along the way. */
  readonly advance: (ms: number) => Promise<void>
}

/** Let everything scheduled at the current instant settle before time moves on. */
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

export const virtualClock = (start: Date): VirtualClock => {
  let nowMs = start.getTime()
  const sleeps: number[] = []
  const pending: PendingSleep[] = []
  const intervals: IntervalCell[] = []

  const dueNext = (
    target: number,
  ): { readonly at: number; readonly fire: () => void } | null => {
    let best: { at: number; fire: () => void } | null = null
    for (const sleep of pending) {
      if (sleep.dueMs <= target && (best === null || sleep.dueMs < best.at)) {
        best = {
          at: sleep.dueMs,
          fire: () => {
            pending.splice(pending.indexOf(sleep), 1)
            sleep.resolve()
          },
        }
      }
    }
    for (const cell of intervals) {
      if (
        !cell.stopped &&
        cell.nextDueMs <= target &&
        (best === null || cell.nextDueMs < best.at)
      ) {
        best = {
          at: cell.nextDueMs,
          fire: () => {
            cell.nextDueMs += cell.periodMs
            cell.fn()
          },
        }
      }
    }
    return best
  }

  return {
    now: () => new Date(nowMs),
    sleeps,
    timers: {
      sleep: (ms) => {
        sleeps.push(ms)
        if (ms <= 0) return Promise.resolve()
        return new Promise((resolve) => {
          pending.push({ dueMs: nowMs + ms, resolve })
        })
      },
      every: (ms, fn) => {
        const cell: IntervalCell = {
          periodMs: ms,
          nextDueMs: nowMs + ms,
          fn,
          stopped: false,
        }
        intervals.push(cell)
        return () => {
          cell.stopped = true
        }
      },
    },
    advance: async (ms) => {
      const target = nowMs + ms
      await settle()
      for (;;) {
        const due = dueNext(target)
        if (due === null) break
        nowMs = Math.max(nowMs, due.at)
        due.fire()
        await settle()
      }
      nowMs = target
      await settle()
    },
  }
}

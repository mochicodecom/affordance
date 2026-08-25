/**
 * The process-timer half of the lifecycle's clock.
 *
 * `now` answers "what time is it"; these answer "wake me later" — the retry
 * delay and the heartbeat. They are a seam for the same reason `now` is:
 * the lease story (renewal past the TTL, backoff between attempts) is only
 * testable when a test can drive elapsed time instead of sleeping through
 * it. The engine always binds {@link realTimers}; the in-memory lifecycle
 * tests bind a virtual clock that advances `now` and fires due timers
 * together.
 */

export interface Timers {
  /** Resolve after `ms` — the delay between retry attempts. */
  readonly sleep: (ms: number) => Promise<void>
  /**
   * Run `fn` every `ms` until the returned stop function is called — the
   * heartbeat.
   */
  readonly every: (ms: number, fn: () => void) => () => void
}

export const realTimers: Timers = {
  // Deliberately not unref'd: a retry delay is work in progress, and a
  // process that exits during one abandons a claimed Execution.
  sleep: (ms) =>
    ms <= 0
      ? Promise.resolve()
      : new Promise((resolve) => {
          setTimeout(resolve, ms)
        }),
  every: (ms, fn) => {
    const timer = setInterval(fn, ms)
    timer.unref?.()
    return () => clearInterval(timer)
  },
}

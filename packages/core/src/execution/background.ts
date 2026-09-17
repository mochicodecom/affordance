/** A host must own tasks beyond a request's lifetime. No replay is permitted. */
export interface BackgroundRuntime {
  /** Invoke task once; reject on handoff failure. Acceptance alone is not handler entry. */
  start(task: () => Promise<void>): Promise<void>
}

/** For long-lived Node processes. Keep the process alive and drain on shutdown.
 * Not suitable for hosts that freeze or kill the process at request completion. */
export const createBackgroundRuntime = () => {
  const tasks = new Set<Promise<void>>()
  let closed = false
  return {
    async start(task: () => Promise<void>): Promise<void> {
      if (closed) throw new Error('background runtime is closed')
      const keepAlive = setInterval(() => {}, 1000)
      const pending = Promise.resolve().then(task)
      tasks.add(pending)
      // Engine tasks handle their own failures. Cleanup also handles a broken task.
      void pending.then(cleanup, cleanup)
      function cleanup() {
        clearInterval(keepAlive)
        tasks.delete(pending)
      }
    },
    async drain(): Promise<void> {
      closed = true
      await Promise.allSettled([...tasks])
    },
  }
}

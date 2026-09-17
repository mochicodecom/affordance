import { deserializeValue, serializeValue } from '../serialization.js'
import { mintId } from '../store/index.js'
import type { BackgroundRuntime } from './background.js'
import type { ExecutionEnvironment, RunOptions } from './environment.js'
import { LaunchBlockedError, LaunchUnresolvedError } from './launch-port.js'
import {
  duration,
  prepareRun,
  type RunConfiguration,
  safeActor,
} from './run.js'

export interface LaunchConfiguration {
  readonly runtime: BackgroundRuntime
  readonly leaseMs: number
}
export interface LaunchResult {
  readonly executionId: string
}
export interface ResolveExecutionOptions {
  readonly actor: unknown
  readonly reason: string
}
export const requireLaunchPort = (env: ExecutionEnvironment) => {
  if (!env.storage.launches)
    throw new TypeError('storage does not support launch tracking')
  return env.storage.launches
}

export const launchStep = async (
  env: ExecutionEnvironment,
  caseId: string,
  stepName: string,
  options: RunOptions,
  config: RunConfiguration,
  launch: LaunchConfiguration | undefined,
): Promise<LaunchResult> => {
  const port = requireLaunchPort(env)
  if (!launch || typeof launch.runtime?.start !== 'function')
    throw new TypeError('launch requires a background runtime')
  if (!env.storage.journal.observe)
    throw new TypeError('launch requires journal.observe storage support')
  const leaseMs = duration(launch.leaseMs, 'leaseMs')
  duration(config.journalTimeoutMs ?? 1000, 'journalTimeoutMs')
  // Detach request-owned arguments before any asynchronous handoff.
  const supplied = deserializeValue(serializeValue(options)) as RunOptions
  const executionId = mintId('execution')
  try {
    await port.claim({
      executionId,
      caseId,
      step: stepName,
      scopeKey: supplied.scopeKey ?? null,
      actor: safeActor(supplied.actor, config),
      leaseMs,
    })
  } catch (cause) {
    // The caller can inspect this identity after an uncertain claim acknowledgment.
    if (cause instanceof LaunchBlockedError) throw cause
    throw new LaunchUnresolvedError(executionId, { cause })
  }
  let startAttempted = false
  let cancelled = false
  let called = false
  let entered!: () => void
  let rejectEntry!: (error: unknown) => void
  const entry = new Promise<void>((resolve, reject) => {
    entered = resolve
    rejectEntry = reject
  })
  // Observe rejection even when a runtime throws synchronously during handoff.
  void entry.catch(() => {})
  try {
    const prepared = await prepareRun(
      env,
      caseId,
      stepName,
      supplied,
      config,
      executionId,
    )
    await Promise.all([
      launch.runtime.start(async () => {
        if (cancelled || called) return
        called = true
        let handlerEntered = false
        try {
          startAttempted = true
          if (!(await port.start(executionId)))
            throw new LaunchUnresolvedError(executionId)
          if (cancelled) throw new LaunchUnresolvedError(executionId)
          let result: ReturnType<typeof prepared.invoke>
          try {
            handlerEntered = true
            result = prepared.invoke()
          } catch (cause) {
            // Even a synchronous throw is a handler entry, not a safe startup refusal.
            entered()
            throw cause
          }
          entered()
          const completed = await prepared.observe(await result)
          try {
            if (!(await port.complete(executionId, completed.journal))) {
              await port.fail(executionId, 'finalization')
            }
          } catch {
            await port.fail(executionId, 'finalization')
          }
        } catch {
          rejectEntry(new LaunchUnresolvedError(executionId))
          // Safe diagnostic codes only. No raw handler errors or request data in status.
          try {
            await port.fail(
              executionId,
              handlerEntered ? 'handler-error' : 'startup',
            )
          } catch {
            /* Expiry still exposes unresolved ownership. */
          }
        }
      }),
      entry,
    ])
    return { executionId }
  } catch (cause) {
    cancelled = true
    if (!startAttempted) {
      try {
        await port.release(executionId)
      } catch (releaseError) {
        throw new LaunchUnresolvedError(executionId, { cause: releaseError })
      }
      throw cause
    }
    try {
      await port.fail(executionId, 'startup')
    } catch {
      /* Never clear uncertain ownership. */
    }
    throw new LaunchUnresolvedError(executionId, { cause })
  }
}

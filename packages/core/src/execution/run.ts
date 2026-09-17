import { toIso } from '../guards/index.js'
import {
  evaluateTarget,
  resolveTarget,
  validateStepInput,
} from '../model/index.js'
import { deserializeValue, serializeValue } from '../serialization.js'
import { mintId, resolveCase, validateCaseState } from '../store/index.js'
import { diffState } from './delta.js'
import type { ExecutionEnvironment, RunOptions } from './environment.js'
import { StepNotAvailableError } from './errors.js'
import type { ObservedEntryInput } from './journal.js'

export type JournalDisposition =
  | { readonly status: 'skipped' }
  | { readonly status: 'recorded' }
  | {
      readonly status: 'failed'
      readonly reason: 'evidence' | 'storage' | 'timeout'
    }
export interface RunResult {
  readonly executionId: string
  readonly caseId: string
  readonly step: string
  readonly scopeKey?: string
  readonly journal: JournalDisposition
}
export interface RunConfiguration {
  /** Bounds validation, diff and storage acquisition/write after handler completion. Default 1000ms. */
  readonly journalTimeoutMs?: number
  /** Explicit safe identity projection. Default: string actor or string actor.id, else null. */
  readonly actorIdentity?: (actor: unknown) => string | null
}
export const duration = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
    throw new TypeError(
      `${name} must be a positive integer no greater than 2147483647`,
    )
  return value
}
export const actorIdentity = (actor: unknown): string | null => {
  if (typeof actor === 'string') return actor
  if (
    typeof actor === 'object' &&
    actor !== null &&
    'id' in actor &&
    typeof actor.id === 'string'
  )
    return actor.id
  return null
}
export const safeActor = (
  actor: unknown,
  config: RunConfiguration,
): string | null => {
  const identity = (config.actorIdentity ?? actorIdentity)(actor)
  if (identity !== null && typeof identity !== 'string')
    throw new TypeError('actorIdentity must return a string or null')
  return identity
}
const snapshot = <T>(value: T): T =>
  deserializeValue(serializeValue(value)) as T

/** Validation and a frozen-by-copy baseline precede any business invocation. */
export const prepareRun = async (
  env: ExecutionEnvironment,
  caseId: string,
  stepName: string,
  options: RunOptions,
  config: RunConfiguration,
  executionId = mintId('execution'),
) => {
  const requestedScope = options.scopeKey
  const requestedAsOf =
    options.asOf === undefined ? undefined : toIso(options.asOf)
  const append = env.storage.journal.observe
  if (!append)
    throw new TypeError('run/launch require journal.observe storage support')
  const timeoutMs = duration(
    config.journalTimeoutMs ?? 1000,
    'journalTimeoutMs',
  )
  const actor = snapshot(options.actor)
  const attribution = safeActor(actor, config)
  const suppliedInput = snapshot(options.input)
  const { definition, handle, state } = await resolveCase(
    await env.storage.cases.get(caseId),
    env.caseTypeFor,
  )
  const target = resolveTarget(definition, state, stepName, requestedScope)
  const input = await validateStepInput(target.step, suppliedInput)
  const asOf = toIso(requestedAsOf ?? env.now())
  const guard = evaluateTarget(target, { actor, asOf })
  const scopeKey = target.binding?.key ?? null
  if (!guard.available)
    throw new StepNotAvailableError(caseId, stepName, scopeKey, guard)
  const before = snapshot(state)
  const identity = {
    executionId,
    caseId,
    step: stepName,
    ...(scopeKey === null ? {} : { scopeKey }),
  }
  return {
    invoke: () =>
      target.step.handler({
        executionId,
        caseId,
        reference: handle.reference,
        state,
        actor,
        input,
        ...(target.binding
          ? { scope: target.binding.element, scopeKey: target.binding.key }
          : {}),
      }),
    async observe(returned: unknown): Promise<RunResult> {
      if (returned === undefined)
        return { ...identity, journal: { status: 'skipped' } }
      let timer: ReturnType<typeof setTimeout> | undefined
      let expired = false
      const deadline = new Promise<JournalDisposition>((resolve) => {
        timer = setTimeout(() => {
          expired = true
          resolve({ status: 'failed', reason: 'timeout' })
        }, timeoutMs)
      })
      const record = async (): Promise<JournalDisposition> => {
        let evidence: ObservedEntryInput
        try {
          const after = await validateCaseState(
            definition,
            returned,
            'returned journal state',
          )
          evidence = {
            ...identity,
            scopeKey,
            entry: 'observed',
            attempt: 1,
            actor: attribution,
            asOf,
            observedAt: env.now().toISOString(),
            state: before,
            delta: diffState(before, after),
          }
          // Catch serializer failures before the adapter and detach from caller mutation.
          evidence = snapshot(evidence)
        } catch {
          return { status: 'failed', reason: 'evidence' }
        }
        if (expired) return { status: 'failed', reason: 'timeout' }
        try {
          await append.call(env.storage.journal, evidence)
          return { status: 'recorded' }
        } catch {
          return { status: 'failed', reason: 'storage' }
        }
      }
      try {
        return {
          ...identity,
          journal: await Promise.race([deadline, record()]),
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
export const runStep = async (
  env: ExecutionEnvironment,
  caseId: string,
  stepName: string,
  options: RunOptions,
  config: RunConfiguration,
): Promise<RunResult> => {
  const prepared = await prepareRun(env, caseId, stepName, options, config)
  // Preserve errors unchanged: effects may already have committed.
  return prepared.observe(await prepared.invoke())
}

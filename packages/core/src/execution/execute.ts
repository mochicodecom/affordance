/** One protected domain operation. External orchestration belongs to the adopter. */
import { toError } from '../errors.js'
import type { GuardEvaluation, Instant } from '../guards/index.js'
import { toIso } from '../guards/index.js'
import type { CorrelationRegistration } from '../ingestion/correlation.js'
import type { AnyCaseType, CorrelationRequest } from '../model/index.js'
import {
  evaluateTarget,
  resolveTarget,
  validateStepInput,
} from '../model/index.js'
import { deserializeValue, serializeValue } from '../serialization.js'
import type { EngineStorage } from '../storage.js'
import type { Dormancy } from '../store/index.js'
import { mintId, resolveCase, validateCaseState } from '../store/index.js'
import { diffState, type StateDelta } from './delta.js'
import {
  ExecutionIndeterminateError,
  StepExecutionError,
  StepNotAvailableError,
} from './errors.js'

export interface ExecutionEnvironment {
  readonly storage: EngineStorage
  readonly caseTypeFor: (name: string) => AnyCaseType
  readonly now: () => Date
}
export interface ExecuteOptions<TActor = unknown> {
  readonly actor: TActor
  readonly scopeKey?: string
  readonly input?: unknown
  readonly asOf?: Instant
}
export interface ExecutionResult<TState = unknown> {
  readonly executionId: string
  readonly caseId: string
  readonly caseTypeName: string
  readonly step: string
  readonly scopeKey?: string
  readonly attempts: number
  readonly guard: GuardEvaluation
  readonly state: TState
  readonly delta: StateDelta
  readonly seq: number
  readonly dormancy: Dormancy | null
  readonly endedAt: string | null
  readonly startedAt: string
  readonly committedAt: string
}
const snapshot = <T>(value: T): T =>
  deserializeValue(serializeValue(value)) as T

export const executeStep = async (
  env: ExecutionEnvironment,
  caseId: string,
  stepName: string,
  options: ExecuteOptions,
): Promise<ExecutionResult> => {
  const executionId = mintId('execution')
  // Copy caller-owned evidence before waiting for another execution.
  const actor = snapshot(options.actor)
  const suppliedInput = snapshot(options.input)
  return env.storage.execution.withCase(
    caseId,
    executionId,
    async (session) => {
      const { definition, handle, state } = await resolveCase(
        await session.loadCase(),
        env.caseTypeFor,
      )
      const target = resolveTarget(
        definition,
        state,
        stepName,
        options.scopeKey,
      )
      const input = await validateStepInput(target.step, suppliedInput)
      const asOf = toIso(options.asOf ?? env.now())
      const guard = evaluateTarget(target, { actor, asOf })
      const scopeKey = target.binding?.key ?? null
      if (!guard.available)
        throw new StepNotAvailableError(caseId, stepName, scopeKey, guard)
      const before = snapshot(state)
      const identity = {
        caseId,
        executionId,
        step: stepName,
        scopeKey,
        actor: snapshot(actor),
        attempt: 1,
      }
      const started = {
        ...identity,
        entry: 'started' as const,
        input: snapshot(input),
        asOf,
        guard: snapshot(guard),
        state: before,
      }
      const correlations: CorrelationRegistration[] = []
      let dormancy: Dormancy | null = null
      try {
        await target.step.handler({
          caseId,
          executionId,
          reference: handle.reference,
          state,
          actor: snapshot(actor),
          input,
          repos: session.repos,
          correlate: (request: CorrelationRequest) =>
            correlations.push(
              snapshot({
                ...request,
                caseId,
                scopeKey:
                  request.scopeKey === undefined ? scopeKey : request.scopeKey,
              }),
            ),
          end: () => {
            dormancy = 'ended'
          },
          reopen: () => {
            dormancy = 'reopened'
          },
          ...(target.binding === null
            ? {}
            : { scope: target.binding.element, scopeKey: target.binding.key }),
        })
        const after = snapshot(
          await validateCaseState(
            definition,
            (await session.loadCase()).state,
            'state after domain operation',
          ),
        )
        const delta = diffState(before, after)
        const metadata = await session.persistCompletion({
          started,
          completed: { ...identity, entry: 'completed', delta, dormancy },
          dormancy,
          correlations,
        })
        return {
          executionId,
          caseId,
          caseTypeName: definition.name,
          step: stepName,
          ...(scopeKey === null ? {} : { scopeKey }),
          attempts: 1,
          guard: started.guard,
          state: after,
          delta,
          dormancy,
          ...metadata,
        }
      } catch (error) {
        // This throw aborts the operation. No separate failure journal write:
        // evidence describes committed domain operations only.
        throw new StepExecutionError(
          caseId,
          executionId,
          stepName,
          scopeKey,
          1,
          error,
        )
      }
    },
  )
}
export interface SystemCommit {
  readonly outcome: 'committed'
  readonly result: ExecutionResult
}
export interface SystemSettled {
  readonly outcome: 'settled'
  readonly error: Error
}
export type SystemRunOutcome = SystemCommit | SystemSettled
export type SystemRunOptions = ExecuteOptions
export const settleSystemRun = (error: unknown): SystemSettled => ({
  outcome: 'settled',
  error: toError(error),
})
export const runAsSystem = async (
  env: ExecutionEnvironment,
  id: string,
  step: string,
  options: SystemRunOptions,
): Promise<SystemRunOutcome> => {
  try {
    return {
      outcome: 'committed',
      result: await executeStep(env, id, step, options),
    }
  } catch (error) {
    // An uncertain commit must not be settled as a failed delivery.
    if (error instanceof ExecutionIndeterminateError) throw error
    return settleSystemRun(error)
  }
}

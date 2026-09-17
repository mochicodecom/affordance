/** Execute an existing operation without taking ownership of its transactions. */
import type { GuardEvaluation } from '../guards/index.js'
import { toIso } from '../guards/index.js'
import {
  evaluateTarget,
  resolveTarget,
  validateStepInput,
} from '../model/index.js'
import { deserializeValue, serializeValue } from '../serialization.js'
import { mintId, resolveCase } from '../store/index.js'
import { StepNotAvailableError } from './errors.js'
import type { ExecuteOptions, ExecutionEnvironment } from './execute.js'

export interface ExecuteNonAtomicOptions<TActor = unknown, TRepos = unknown>
  extends ExecuteOptions<TActor> {
  /** Complete application operations; they own transactions, retries and external calls. */
  readonly repos: TRepos
}

/** Handler completion, without a claim about journal persistence or database commit. */
export interface NonAtomicExecutionResult {
  readonly mode: 'non-atomic'
  readonly executionId: string
  readonly caseId: string
  readonly caseTypeName: string
  readonly step: string
  readonly scopeKey?: string
  readonly guard: GuardEvaluation
}

const snapshot = <T>(value: T): T =>
  deserializeValue(serializeValue(value)) as T

export const executeNonAtomicStep = async (
  env: ExecutionEnvironment,
  caseId: string,
  stepName: string,
  options: ExecuteNonAtomicOptions,
): Promise<NonAtomicExecutionResult> => {
  const executionId = mintId('execution')
  const actor = snapshot(options.actor)
  const suppliedInput = snapshot(options.input)
  const { definition, handle, state } = await resolveCase(
    await env.storage.cases.get(caseId),
    env.caseTypeFor,
  )
  const target = resolveTarget(definition, state, stepName, options.scopeKey)
  const input = await validateStepInput(target.step, suppliedInput)
  const asOf = toIso(options.asOf ?? env.now())
  const guard = evaluateTarget(target, { actor, asOf })
  const scopeKey = target.binding?.key ?? null
  if (!guard.available)
    throw new StepNotAvailableError(caseId, stepName, scopeKey, guard)

  // Construct the answer before the handler: serialization cannot fail after a write.
  const result: NonAtomicExecutionResult = {
    mode: 'non-atomic',
    executionId,
    caseId,
    caseTypeName: definition.name,
    step: stepName,
    ...(scopeKey === null ? {} : { scopeKey }),
    guard: snapshot(guard),
  }
  const unsupportedMetadata = (): never => {
    throw new Error(
      'Non-atomic handlers cannot stage correlations or dormancy; manage them separately',
    )
  }
  // Do not wrap errors as StepExecutionError: the operation may have committed effects.
  await target.step.handler({
    caseId,
    executionId,
    reference: handle.reference,
    state,
    actor,
    input,
    repos: options.repos,
    correlate: unsupportedMetadata,
    end: unsupportedMetadata,
    reopen: unsupportedMetadata,
    ...(target.binding === null
      ? {}
      : { scope: target.binding.element, scopeKey: target.binding.key }),
  })
  // No second state load, metadata mutation or persistence after known handler success.
  return result
}

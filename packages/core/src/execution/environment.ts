import type { Instant } from '../guards/index.js'
import type { AnyCaseType } from '../model/index.js'
import type { EngineStorage } from '../storage.js'
import type { RunConfiguration } from './run.js'
export interface ExecutionEnvironment {
  readonly storage: EngineStorage
  readonly caseTypeFor: (name: string) => AnyCaseType
  readonly now: () => Date
  readonly operations?: RunConfiguration
}
export interface RunOptions<TActor = unknown> {
  readonly actor: TActor
  readonly scopeKey?: string
  readonly input?: unknown
  readonly asOf?: Instant
}

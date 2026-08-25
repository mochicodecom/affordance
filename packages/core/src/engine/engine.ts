/**
 * The engine: the case-type registry bound to the case store.
 *
 * `createEngine({ db, caseTypes })` wires the halves together — persistence
 * (`../store`), guard evaluation (`../guards`), the definition API
 * (`../model`) and the execution lifecycle (`../execution`) — into the
 * framework's public face: `affordances`, `explain`, `execute`, `journal`.
 *
 * The engine is where `asOf` defaults to now: conditions never read the
 * clock, so `EngineOptions.now` — wall clock by default — is the one clock,
 * threaded through the environment to everything below, and everything below
 * it is pure and reconstructable.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec'
import type {
  ExecuteOptions,
  ExecutionResult,
  JournalEntry,
  JournalFilter,
} from '../execution/index.js'
import {
  DEFAULT_CLAIM_TTL_MS,
  DEFAULT_HEARTBEAT_MS,
  executeStep,
  readJournal,
  realTimers,
  withTransaction,
} from '../execution/index.js'
import type { Instant } from '../guards/index.js'
import type {
  Correlation,
  CorrelationRegistration,
  DeadLetter,
  DeadLetterFilter,
  ExternalEvent,
  IngestionEnvironment,
  IngestionOptions,
  IngestionResult,
} from '../ingestion/index.js'
import {
  correlationsFor,
  ingest,
  lookupCorrelation,
  normalizeIngestion,
  readDeadLetters,
  registerCorrelation,
} from '../ingestion/index.js'
import type {
  MigrationOptions,
  MigrationReport,
  MigrationTransform,
} from '../migration/index.js'
import { migrate } from '../migration/index.js'
import type { AnyCaseType, StepMetadata } from '../model/index.js'
import type { CaseHandle, DatabaseAccess } from '../store/index.js'
import { insertCase, queryableOf, resolveCase } from '../store/index.js'
import type {
  AffordanceExplanation,
  CaseAffordances,
  CaseSnapshot,
  ExplainRequest,
} from './compute.js'
import {
  computeAffordances,
  computeExplanation,
  explainContext,
} from './compute.js'
import { UnknownCaseTypeError } from './errors.js'

/** Options for {@link createEngine}. */
export interface EngineOptions {
  /**
   * The app brings its database, declaring which kind of handle it has:
   * `{ pool }` for anything that checks out connections (`pg.Pool`, or any
   * wrapper declaring `connect()`), `{ client }` for a single connection
   * dedicated to the engine. The declaration is what lets `execute` run its
   * transactions on one connection without guessing — see
   * {@link DatabaseAccess}.
   */
  readonly db: DatabaseAccess
  /** Every case type this engine serves; a loaded case's `case_type` must name one of them. */
  readonly caseTypes: readonly AnyCaseType[]
  /**
   * How long an Execution's claim survives without a heartbeat (default 30s).
   * The floor on how long a crashed handler can hold a case.
   */
  readonly claimTtlMs?: number
  /** How often a running handler refreshes its claim (default 5s). */
  readonly heartbeatMs?: number
  /**
   * Event ingestion: how an external event's Actor is derived.
   * Correlation needs no configuration — it is a registry, not a policy.
   */
  readonly ingestion?: IngestionOptions
  /**
   * The clock — every process-side "as of now" below the boundary reads
   * through it: guard evaluation instants, journal timestamps, ingestion
   * receipt times. Defaults to the wall clock. Two "nows" it deliberately
   * does not govern: lease expiry is judged by the storage adapter's own
   * clock (the one clock all competing processes share), and the retry
   * delay / heartbeat cadence run on process timers (an internal seam the
   * lifecycle's own tests drive virtually).
   */
  readonly now?: () => Date
}

/**
 * Options for {@link Engine.explain}. Omit `actor` to probe `requires`
 * alone: `permits` conditions are then reported un-evaluated (failed, with
 * the stated reason `'not evaluated: no actor supplied'`) rather than run
 * against nothing. The normalization rule is `explainContext`, stated and
 * tested beside the pure computation it feeds.
 */
export type ExplainOptions = ExplainRequest

export interface Engine {
  /**
   * Create a case of a registered case type. The initial state is validated
   * against the type's schema.
   */
  createCase(
    caseTypeName: string,
    initialState: unknown,
  ): Promise<CaseHandle<unknown>>

  /**
   * Compute the affordances record for a case: load it, evaluate every
   * step's guard for `actor` (with scope fan-out), and return the
   * serializable available + blocked answer. Dormant (ended) cases compute
   * like any other — dormancy is annotation, never a freeze.
   */
  affordances(
    caseId: string,
    actor: unknown,
    asOf?: Instant,
  ): Promise<CaseAffordances>

  /**
   * {@link Engine.affordances} for a case already in hand — no second load,
   * no re-validation. Synchronous: a registry read plus the pure
   * computation. The handle must be one this engine issued
   * ({@link Engine.createCase}, {@link Engine.case}) — their `state` is the
   * validated document; a hand-built handle carries no such guarantee.
   * This is how a create route answers with the fresh case's affordances
   * without re-reading what it just wrote.
   */
  affordancesOf(
    handle: CaseHandle<unknown>,
    actor: unknown,
    asOf?: Instant,
  ): CaseAffordances

  /** The full per-condition breakdown for one step (× scope element) of a case. */
  explain(
    caseId: string,
    stepName: string,
    options?: ExplainOptions,
  ): Promise<AffordanceExplanation>

  /**
   * Execute a step on a case: claim → run → commit. The claim
   * re-evaluates the guard transactionally — the enforcement moment — so an
   * affordance that has since gone away rejects with `StepNotAvailableError`
   * carrying the current unmet conditions, and a case with an Execution
   * already in flight rejects with `CaseBusyError`.
   */
  execute(
    caseId: string,
    stepName: string,
    options: ExecuteOptions,
  ): Promise<ExecutionResult>

  /**
   * Read a case's journal, oldest first. Filter by `scopeKey` for
   * a per-track audit — "everything that happened on buyer #7".
   */
  journal(
    caseId: string,
    filter?: JournalFilter,
  ): Promise<readonly JournalEntry[]>

  /**
   * Read one case as persisted: the row plus its Case State validated
   * against the registered schema. Loud — an addressed read owes an answer,
   * so an unknown case or a state its schema no longer accepts throws.
   * The read ops surfaces, tests and consoles would otherwise each
   * hand-write in SQL.
   */
  case(caseId: string): Promise<CaseHandle<unknown>>

  /** Where an external identifier routes — the reverse of {@link Engine.correlations}. */
  correlationOf(system: string, externalId: string): Promise<Correlation | null>

  /**
   * The declared input schema of one step of a registered case type, or
   * `null` when the step takes no input. Synchronous — a registry read. The
   * engine owns the registry and a case names its type, so an adapter never
   * needs to be handed the case types a second time to describe inputs.
   */
  inputSchemaFor(
    caseTypeName: string,
    stepName: string,
  ): StandardSchemaV1 | null

  /**
   * The declared human metadata of one step of a registered case type —
   * `title` and `description`, each `null` when undeclared — or `null` for
   * an unknown step. Synchronous, a registry read like
   * {@link Engine.inputSchemaFor}, and for the same reason: adapters
   * serialize step metadata from here rather than being handed the case
   * types a second time.
   */
  stepMetadataFor(caseTypeName: string, stepName: string): StepMetadata | null

  /**
   * Ingest one external event: dedup, correlate, then an ordinary Execution
   * with the external system as the actor. Never throws for an
   * event's own sake — an event that could not be applied is dead-lettered
   * with a reason, so a webhook endpoint can acknowledge and move on.
   */
  ingest(event: ExternalEvent): Promise<IngestionResult>

  /**
   * Register an external identifier against a case out of band. Handlers
   * should prefer `ctx.correlate(...)`, which rides the same commit as the
   * state recording that the interaction was started.
   */
  correlate(registration: CorrelationRegistration): Promise<Correlation>

  /** Every external identifier registered against a case (× scope element). */
  correlations(
    caseId: string,
    scopeKey?: string,
  ): Promise<readonly Correlation[]>

  /** The dead-letter surface: events that arrived and changed nothing, with why. */
  deadLetters(filter?: DeadLetterFilter): Promise<readonly DeadLetter[]>

  /**
   * Restructure the state of every case of a case type, as journaled system
   * Executions (float's escape hatch). Idempotent: a case that
   * already carries the migration's marker is skipped, so re-running is a
   * no-op and an interrupted run resumes. Reach for it only when no total
   * condition can read the old shape — see `docs/migration.md`.
   */
  migrate(
    caseTypeName: string,
    name: string,
    transform: MigrationTransform,
    options?: MigrationOptions,
  ): Promise<MigrationReport>
}

/**
 * Build an engine from the app's database and its case type definitions.
 * Throws at construction on duplicate case type names — the registry is
 * keyed by name, which is all a case row records (definitions
 * float; only the name is persisted).
 */
export const createEngine = (options: EngineOptions): Engine => {
  const registry = new Map<string, AnyCaseType>()
  for (const definition of options.caseTypes) {
    if (registry.has(definition.name)) {
      throw new TypeError(
        `createEngine: duplicate case type name '${definition.name}'`,
      )
    }
    registry.set(definition.name, definition)
  }

  const caseTypeFor = (caseTypeName: string): AnyCaseType => {
    const definition = registry.get(caseTypeName)
    if (definition === undefined) {
      throw new UnknownCaseTypeError(caseTypeName, [...registry.keys()])
    }
    return definition
  }

  const now = options.now ?? (() => new Date())

  // Single self-contained statements run against either arm alike; only
  // transactions (and the lifecycle behind them) need the declaration itself.
  const db = queryableOf(options.db)

  // The widest environment any subsystem asks for (IngestionEnvironment ⊇
  // ExecutionEnvironment), built once and handed to all of them.
  const environment: IngestionEnvironment = {
    db: options.db,
    caseTypeFor,
    claimTtlMs: options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS,
    heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    ingestion: normalizeIngestion(options.ingestion),
    now,
    timers: realTimers,
  }

  /** Load the case, resolve its type from the registry, validate state against the type's schema. */
  const load = async (
    caseId: string,
  ): Promise<{ definition: AnyCaseType; snapshot: CaseSnapshot<unknown> }> => {
    const { definition, handle, state } = await resolveCase(
      db,
      caseTypeFor,
      caseId,
    )
    return {
      definition,
      snapshot: { id: handle.id, state, endedAt: handle.endedAt },
    }
  }

  return {
    createCase: async (caseTypeName, initialState) => {
      const definition = caseTypeFor(caseTypeName)
      return withTransaction(options.db, (tx) =>
        insertCase(tx, caseTypeName, definition.state, initialState),
      )
    },
    affordances: async (caseId, actor, asOf) => {
      const { definition, snapshot } = await load(caseId)
      return computeAffordances(definition, snapshot, {
        actor,
        asOf: asOf ?? now(),
      })
    },
    affordancesOf: (handle, actor, asOf) =>
      computeAffordances(
        caseTypeFor(handle.caseTypeName),
        { id: handle.id, state: handle.state, endedAt: handle.endedAt },
        { actor, asOf: asOf ?? now() },
      ),
    explain: async (caseId, stepName, explainOptions = {}) => {
      const { definition, snapshot } = await load(caseId)
      // The boundary's one normalization (absent-vs-undefined actor, the
      // asOf default) lives with the pure computation — see explainContext.
      return computeExplanation(
        definition,
        snapshot,
        stepName,
        explainContext(explainOptions, now),
      )
    },
    // Rebuilt field by field, not spread: whatever extra properties a
    // caller's object drags along stop here, so the lifecycle only ever
    // sees the options the public interface declares.
    execute: (
      caseId,
      stepName,
      { actor, scopeKey, input, asOf, claimTtlMs, heartbeatMs, retry },
    ) =>
      executeStep(environment, caseId, stepName, {
        actor,
        scopeKey,
        input,
        asOf,
        claimTtlMs,
        heartbeatMs,
        retry,
      }),
    journal: (caseId, filter) => readJournal(db, caseId, filter),
    case: async (caseId) => {
      const { handle, state } = await resolveCase(db, caseTypeFor, caseId)
      return { ...handle, state }
    },
    correlationOf: (system, externalId) =>
      lookupCorrelation(db, system, externalId),
    inputSchemaFor: (caseTypeName, stepName) =>
      caseTypeFor(caseTypeName).getStep(stepName)?.input ?? null,
    stepMetadataFor: (caseTypeName, stepName) => {
      const step = caseTypeFor(caseTypeName).getStep(stepName)
      if (step === undefined) return null
      return { title: step.title, description: step.description }
    },
    ingest: (event) => ingest(environment, event),
    correlate: (registration) => registerCorrelation(db, registration),
    correlations: (caseId, scopeKey) => correlationsFor(db, caseId, scopeKey),
    deadLetters: (filter) => readDeadLetters(db, filter),
    migrate: (caseTypeName, name, transform, migrationOptions) =>
      migrate(environment, caseTypeName, name, transform, migrationOptions),
  }
}

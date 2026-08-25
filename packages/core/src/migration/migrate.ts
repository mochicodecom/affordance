/**
 * The migration escape hatch.
 *
 * Cases float to the latest definitions: a deploy changes what the steps are
 * and every in-flight case is immediately governed by the new ones, with no
 * migration executed and no version pinned. That covers almost everything,
 * because almost every change is *additive* — a new step, a new condition, a
 * new optional field — and the `?? fallback` discipline makes old
 * state readable by new code.
 *
 * What float cannot cover is a **restructure**: a field renamed, one field
 * split into two, a scalar turned into a collection. No fallback expression
 * makes `state.buyer` readable as `state.buyers[]`. For exactly that,
 * this module.
 *
 * Two properties make it an escape hatch rather than a second way of working:
 *
 * 1. **A migration is an Execution.** Not a script with a database
 *    connection — the same claim → run → commit as any step, so the case row
 *    lock, the in-flight claim, state schema validation
 *    and the journal entry all apply unchanged. The transform runs
 *    as a synthetic step named `migrate:<name>`, with a migration actor.
 *    An auditor asking "why did this case's shape change in March" gets the
 *    same kind of answer as for anything else that ever happened to it.
 * 2. **The journal is the marker.** A case has been migrated iff it carries a
 *    completed `migrate:<name>` entry. Nothing is written into app state to
 *    record it, so a migration leaves no residue in the document it
 *    restructured — and re-running is a no-op by construction, which is also
 *    what makes an interrupted run resumable.
 *
 * When *not* to reach for this is in `docs/migration.md`. The short version:
 * if a total condition can read the old shape, write the total condition.
 */

import { toError } from '../errors.js'
import type { ExecutionEnvironment, StateDelta } from '../execution/index.js'
import { diffState, runAsSystem } from '../execution/index.js'
import type { AnyCaseType, StepDefinition } from '../model/index.js'
import { step } from '../model/index.js'
import type { Queryable } from '../store/index.js'
import {
  FRAMEWORK_SCHEMA,
  queryableOf,
  resolveStoredState,
  sqlWhere,
} from '../store/index.js'

const CASES = `${FRAMEWORK_SCHEMA}.cases`
const JOURNAL = `${FRAMEWORK_SCHEMA}.journal`

/** The synthetic step name a migration executes under — its journal marker. */
export const migrationStepName = (name: string): string => `migrate:${name}`

/** The Actor a migration runs as, when the app supplies none. */
export interface MigrationActor {
  readonly kind: 'migration'
  readonly migration: string
}

/**
 * The state transform. Pure and total, like a condition: it will
 * be handed state written by every definition the case has ever floated
 * through, and returning the input unchanged must be safe.
 */
export type MigrationTransform<TState = any> = (state: TState) => TState

/** Options for {@link migrate}. */
export interface MigrationOptions {
  /** How many cases to claim per round trip when scanning (default 100). */
  readonly batchSize?: number
  /** Stop after this many cases — for a cautious first run. */
  readonly limit?: number
  /** Restrict the run to these cases; they are still skipped if already migrated. */
  readonly caseIds?: readonly string[]
  /** The Actor the Executions run as; defaults to a {@link MigrationActor}. */
  readonly actor?: unknown
  /** Include dormant (ended) cases. Off by default — a closed case is usually not worth restructuring. */
  readonly includeEnded?: boolean
  /**
   * Compute what each case *would* become and report the deltas without
   * writing anything. Nothing is journaled, so a dry run leaves no marker
   * and the real run still has every case to do.
   */
  readonly dryRun?: boolean
  /** Called after each case, for a progress bar or a log line. */
  readonly onProgress?: (progress: MigrationProgress) => void
}

/** Progress after one case. */
export interface MigrationProgress {
  readonly caseId: string
  readonly outcome: 'migrated' | 'unchanged' | 'failed'
  /** What the transform changed, as JSON Patch; empty when it changed nothing. */
  readonly delta: StateDelta
  readonly error: Error | null
  /** How many cases have been processed so far in this run. */
  readonly processed: number
}

/** One case a migration could not restructure. */
export interface MigrationFailure {
  readonly caseId: string
  readonly error: Error
}

/** What {@link migrate} resolves to. */
export interface MigrationReport {
  readonly name: string
  readonly caseTypeName: string
  readonly dryRun: boolean
  /** Cases examined — those not already bearing the marker. */
  readonly scanned: number
  /** Cases whose state the transform changed and which committed. */
  readonly migrated: number
  /**
   * Cases the transform left identical. Still journaled (and so still
   * marked), because "this migration considered this case and had nothing to
   * do" is a fact worth being able to prove.
   */
  readonly unchanged: number
  readonly failed: readonly MigrationFailure[]
}

/**
 * Build the synthetic step the transform runs as. It declares no conditions:
 * a migration is not a business affordance and must not be blockable by one
 * — it is the deliberate exception float reserves, and the guard model
 * would only ever be in its way. `maxAttempts: 1` because a transform that
 * throws is a defect in the transform, and retrying it just throws again.
 */
const migrationStep = (
  name: string,
  transform: MigrationTransform,
): StepDefinition<unknown, unknown> =>
  step({
    name: migrationStepName(name),
    retry: { maxAttempts: 1 },
    handler: async (state: unknown) => transform(state),
  })

/**
 * A view of the case type with the migration step spliced in, so the
 * ordinary lifecycle can address it by name. The real definition is left
 * untouched: the migration step exists for the duration of the run and is
 * never part of anything a client could see as an affordance.
 */
const withMigrationStep = (
  definition: AnyCaseType,
  migration: StepDefinition<unknown, unknown>,
): AnyCaseType => ({
  ...definition,
  steps: [...definition.steps, migration],
  getStep: (stepName: string) =>
    stepName === migration.name ? migration : definition.getStep(stepName),
})

/** Case ids of this type that do not yet carry the migration's marker, oldest first. */
const findCandidates = async (
  db: Queryable,
  caseTypeName: string,
  marker: string,
  options: MigrationOptions,
  afterId: string | null,
  batchSize: number,
): Promise<readonly { id: string; state: unknown }[]> => {
  const { conditions, values, bind, where } = sqlWhere(
    [
      `c.case_type = $1`,
      // The marker: a completed Execution of this migration on this case. The
      // journal is the record of what has happened, so it is also the record of
      // what has already been migrated — no bookkeeping table, no state flag.
      `not exists (
       select 1 from ${JOURNAL} j
       where j.case_id = c.id and j.step = $2 and j.entry = 'completed'
     )`,
    ],
    [caseTypeName, marker],
  )
  if (options.includeEnded !== true) conditions.push(`c.ended_at is null`)
  if (options.caseIds !== undefined)
    conditions.push(`c.id = any(${bind(options.caseIds)}::text[])`)
  if (afterId !== null) conditions.push(`c.id > ${bind(afterId)}`)

  const { rows } = await db.query<{ id: string; state: unknown }>(
    `select c.id, c.state from ${CASES} c
     where ${where()}
     order by c.id asc
     limit ${bind(batchSize)}`,
    values,
  )
  return rows
}

/**
 * Run a state restructure over every case of a case type, as journaled
 * system Executions.
 *
 * Idempotent: a case that already carries the migration's marker is never
 * examined again, so re-running is a no-op and an interrupted run resumes
 * where it stopped. Failures do not stop the run — a case that cannot be
 * migrated (its claim is held, the transform threw, the result fails the
 * state schema) is reported and the run moves on, and the next run will pick
 * it up because it never got its marker.
 *
 * The cursor walks case ids ascending, and the "already migrated" filter is
 * applied by the database on every batch — so a case migrated by a
 * concurrently-running instance of the same migration simply is not returned.
 */
export const migrate = async (
  env: ExecutionEnvironment,
  caseTypeName: string,
  name: string,
  transform: MigrationTransform,
  options: MigrationOptions = {},
): Promise<MigrationReport> => {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError(
      'migrate: a migration must have a non-empty name — it is the journal marker',
    )
  }
  if (typeof transform !== 'function') {
    throw new TypeError(
      `migrate '${name}': the transform must be a function of case state`,
    )
  }

  const definition = env.caseTypeFor(caseTypeName)
  const marker = migrationStepName(name)
  const migration = migrationStep(name, transform)
  const augmented = withMigrationStep(definition, migration)
  const actor: unknown = options.actor ?? { kind: 'migration', migration: name }
  const batchSize = Math.max(1, options.batchSize ?? 100)
  const dryRun = options.dryRun === true

  let scanned = 0
  let migrated = 0
  let unchanged = 0
  const failed: MigrationFailure[] = []
  let cursor: string | null = null

  /** One candidate's verdict, with early returns — no outcome threading. */
  const runOne = async (candidate: {
    readonly id: string
    readonly state: unknown
  }): Promise<Pick<MigrationProgress, 'outcome' | 'delta' | 'error'>> => {
    try {
      if (dryRun) {
        // The transform is pure, so "what would this become" needs no
        // claim, no lock and no write — and leaves no marker behind.
        const resolved = await resolveStoredState(definition, candidate.state)
        const before = resolved === null ? candidate.state : resolved.state
        const delta = diffState(before, transform(before))
        return {
          outcome: delta.length === 0 ? 'unchanged' : 'migrated',
          delta,
          error: null,
        }
      }
      // The system runner returns case-level failures as values rather than
      // throwing, and the sweep filters on that outcome: only a commit
      // advances this case. A settled run — a held claim, a throwing
      // transform, a result its schema rejects — is reported with no marker
      // written, so the next run picks the case up again.
      const ran = await runAsSystem(env, candidate.id, marker, {
        actor,
        definition: augmented,
      })
      if (ran.outcome === 'settled')
        return { outcome: 'failed', delta: [], error: ran.error }
      const delta = ran.result.delta
      return {
        outcome: delta.length === 0 ? 'unchanged' : 'migrated',
        delta,
        error: null,
      }
    } catch (caught) {
      // The dry-run path's own throws (a transform is app code).
      return { outcome: 'failed', delta: [], error: toError(caught) }
    }
  }

  for (;;) {
    const remaining =
      options.limit === undefined ? batchSize : options.limit - scanned
    if (remaining <= 0) break
    const candidates = await findCandidates(
      queryableOf(env.db),
      caseTypeName,
      marker,
      options,
      cursor,
      Math.min(batchSize, remaining),
    )
    if (candidates.length === 0) break

    for (const candidate of candidates) {
      cursor = candidate.id
      scanned += 1
      const { outcome, delta, error } = await runOne(candidate)
      if (error !== null) failed.push({ caseId: candidate.id, error })
      else if (outcome === 'unchanged') unchanged += 1
      else migrated += 1

      options.onProgress?.({
        caseId: candidate.id,
        outcome,
        delta,
        error,
        processed: scanned,
      })
    }
  }

  return { name, caseTypeName, dryRun, scanned, migrated, unchanged, failed }
}

/** Whether one case already carries a migration's marker. */
export const hasMigrated = async (
  db: Queryable,
  caseId: string,
  name: string,
): Promise<boolean> => {
  const { rows } = await db.query<{ one: number }>(
    `select 1 as one from ${JOURNAL}
     where case_id = $1 and step = $2 and entry = 'completed' limit 1`,
    [caseId, migrationStepName(name)],
  )
  return rows.length > 0
}

/**
 * Step definitions.
 *
 * A **step** is an independently-defined unit of possible work on a case: a
 * guard plus a handler (CONTEXT.md). Steps never declare ordering —
 * sequencing is data dependencies between guards. `step()` validates the
 * definition loudly at construction time: a malformed step should fail the
 * deploy, not an evaluation.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec'
import { AffordanceError } from '../errors.js'
import type { ConditionMap, Guard, GuardSection } from '../guards/index.js'
import { guardEntries } from '../guards/index.js'
import type {
  ErasedStepHandler,
  ScopedStepHandler,
  StepHandler,
} from './handler.js'
import type { RetryOptions, RetryPolicy } from './retry.js'
import { normalizeRetry } from './retry.js'
import type { ScopeDeclaration, ScopedConditionMap } from './scope.js'
import { eraseScopedConditionMap } from './scope.js'

/** Options for an unscoped step. */
export interface StepOptions<TState, TActor = unknown, TInput = undefined> {
  /** The step's name — unique within its case type; half of a scoped affordance's identity. */
  readonly name: string
  /**
   * A short human label for the step ("Issue the funding call"). Definition
   * metadata, not identity: journal entries and refusals name the step by
   * `name`; adapters serialize the title so a client renders steps without
   * an out-of-band label table.
   */
  readonly title?: string
  /**
   * A sentence on what the step does and when to take it — what makes the
   * affordance contract a usable tool list for a caller (an agent included)
   * that has never seen this case type.
   */
  readonly description?: string
  /** Case conditions: when one fails the step is not possible on this case, for anyone. */
  readonly requires?: ConditionMap<TState, TActor>
  /** Actor conditions: when one fails the step is possible but not permitted for this actor. */
  readonly permits?: ConditionMap<TState, TActor>
  /**
   * Optional input schema (any Standard Schema — zod v4 qualifies). Validated
   * by `validateStepInput` before the handler runs.
   */
  readonly input?: StandardSchemaV1<unknown, TInput>
  /**
   * How many times a failed attempt is retried, and how long between
   * attempts. Defaults to three attempts with exponential backoff; set
   * `{ maxAttempts: 1 }` to disable retry for this step.
   */
  readonly retry?: RetryOptions
  /** The step's effect function — the only thing that mutates Case State. */
  readonly handler: StepHandler<TState, TActor, TInput>
}

/** Options for a scoped step: an unscoped step plus the scope declaration. */
export interface ScopedStepOptions<
  TState,
  TElement,
  TActor = unknown,
  TInput = undefined,
> {
  readonly name: string
  readonly title?: string
  readonly description?: string
  /** The collection the step ranges over and how each element is identified. */
  readonly scope: ScopeDeclaration<TState, TElement>
  readonly requires?: ScopedConditionMap<TState, TElement, TActor>
  readonly permits?: ScopedConditionMap<TState, TElement, TActor>
  readonly input?: StandardSchemaV1<unknown, TInput>
  readonly retry?: RetryOptions
  readonly handler: ScopedStepHandler<TState, TElement, TActor, TInput>
}

/**
 * A step definition as held by a case type and consumed by the engine — the
 * authoring generics (scope element, input) erased to the case-state level.
 * The options types above carry the precise authoring shapes; this is the
 * machine-facing normal form.
 */
export interface StepDefinition<TState, TActor = unknown> {
  readonly name: string
  /** The declared human label, or `null` — clients fall back to `name`. */
  readonly title: string | null
  /** The declared what-and-when sentence, or `null`. */
  readonly description: string | null
  /**
   * The step's guard in the guards module's shape, ready for `evaluateGuard`.
   * For a scoped step the engine evaluates it once per selected element with
   * the element bound as `scope`.
   */
  readonly guard: Guard<TState, TActor>
  /** The scope declaration (element type erased), or `null` for an unscoped step. */
  readonly scope: {
    readonly select: (state: TState) => readonly unknown[]
    readonly key: (element: unknown) => string
  } | null
  /** The declared input schema, or `null` when the step takes no input. */
  readonly input: StandardSchemaV1 | null
  /** The normalized retry policy the execution lifecycle applies to this step. */
  readonly retry: RetryPolicy
  /** The step's handler — invoked only by the execution lifecycle. */
  readonly handler: ErasedStepHandler<TState, TActor>
}

/**
 * A step's declared human metadata, as `Engine.stepMetadataFor` answers it —
 * the serializable slice of a {@link StepDefinition} an adapter puts on the
 * wire.
 */
export interface StepMetadata {
  readonly title: string | null
  readonly description: string | null
}

/** Whether a value is a Standard-Schema instance — the one spelling of the check. */
export const isStandardSchema = (value: unknown): value is StandardSchemaV1 =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { '~standard'?: unknown })['~standard'] === 'object'

/**
 * Whether a value is plausibly a {@link StepDefinition} — the structural
 * check `caseType()` applies to every step it is given.
 */
export const looksLikeStepDefinition = (
  value: unknown,
): value is StepDefinition<unknown, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { name?: unknown }).name === 'string' &&
  typeof (value as { handler?: unknown }).handler === 'function' &&
  typeof (value as { guard?: unknown }).guard === 'object'

/**
 * Validate one guard section map at definition time: every entry must be a
 * condition function or an `anyOf(...)` group
 * (unscoped only — scoped maps admit conditions alone).
 *
 * The classification and the `requires.escrowReady` addressing both come from
 * `guardEntries`, so what a definition is allowed to contain is decided
 * against the same walk evaluation uses — a definition `step()` accepts is
 * one `evaluateGuard` can read.
 */
const validateConditionMap = (
  stepName: string,
  section: GuardSection,
  map: Readonly<Record<string, unknown>> | undefined,
  allowAnyOf: boolean,
): void => {
  if (map === undefined) return
  if (typeof map !== 'object' || map === null || Array.isArray(map)) {
    throw new TypeError(
      `step '${stepName}': ${section} must be a plain object of named conditions`,
    )
  }
  const section_ = { [section]: map } as Guard<unknown, unknown>
  for (const entry of guardEntries(section_)) {
    if (entry.kind === 'condition') continue
    if (entry.kind === 'anyOf' && allowAnyOf) continue
    const allowed = allowAnyOf
      ? 'a condition function or an anyOf(...) group'
      : 'a condition function (anyOf is not part of the scoped guard surface)'
    throw new TypeError(
      `step '${stepName}': ${entry.address} must be ${allowed}`,
    )
  }
}

const validateCommon = (options: {
  name: unknown
  title?: unknown
  description?: unknown
  input?: unknown
  handler: unknown
}): string => {
  const { name } = options
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('step: name must be a non-empty string')
  }
  if (typeof options.handler !== 'function') {
    throw new TypeError(`step '${name}': handler must be an async function`)
  }
  if (options.input !== undefined && !isStandardSchema(options.input)) {
    throw new TypeError(
      `step '${name}': input must be a Standard Schema (e.g. a zod schema)`,
    )
  }
  for (const field of ['title', 'description'] as const) {
    const value = options[field]
    if (
      value !== undefined &&
      (typeof value !== 'string' || value.trim() === '')
    ) {
      throw new TypeError(
        `step '${name}': ${field} must be a non-empty string when given`,
      )
    }
  }
  return name
}

/**
 * Define a step. Two shapes, discriminated by the presence of `scope`:
 *
 * ```ts
 * // Standalone form (internal — apps author through {@link stepsOf}, which
 * // binds the generics once and takes the same options annotation-free):
 * // type parameters are inferred from annotations in the options — annotate
 * // the state parameter of a condition (and the actor on a permits ctx).
 * step({
 *   name: 'issue-funding-call',
 *   requires: { escrowReady: (s: Purchase) => s.escrow?.status === 'open' },
 *   permits: { isOrganizer: (_s: Purchase, ctx: ConditionContext<Ops>) => ctx.actor.roles.includes('organizer') },
 *   handler: async (s, ctx) => s,
 * })
 *
 * // Scoped, standalone form: annotating scope.select anchors both the state
 * // and element types; conditions then read the bound element as ctx.scope,
 * // fully typed (through stepsOf, even the select annotation goes away):
 * step({
 *   name: 'escalate-verification',
 *   scope: { select: (s: Purchase) => s.buyers.filter(b => b.verification?.status === 'review'), key: b => b.id },
 *   requires: { flagged: (s: Purchase, ctx) => (ctx.scope as Buyer).verification?.flaggedAt != null },
 *   handler: async (s, ctx) => s,
 * })
 * ```
 *
 * Validates loudly at construction time — malformed guard entries, a
 * malformed scope declaration, a non-function handler, or a non-schema
 * `input` all throw `TypeError` (definition-time validation; a definition
 * bug should fail the deploy, not an evaluation).
 *
 * The scoped overload is declared first: type parameters are meant to be
 * inferred, and inference resolves each call shape against its own overload
 * (explicit type-argument lists interact badly with overloaded
 * context-sensitive options — annotate inside the options instead).
 */
export function step<TState, TElement, TActor = unknown, TInput = undefined>(
  options: ScopedStepOptions<TState, TElement, TActor, TInput>,
): StepDefinition<TState, TActor>
export function step<TState, TActor = unknown, TInput = undefined>(
  options: StepOptions<TState, TActor, TInput>,
): StepDefinition<TState, TActor>
export function step<TState, TActor>(
  options:
    | StepOptions<TState, TActor, unknown>
    | ScopedStepOptions<TState, unknown, TActor, unknown>,
): StepDefinition<TState, TActor> {
  const name = validateCommon(options)
  const scoped = 'scope' in options && options.scope !== undefined
  let scope: StepDefinition<TState, TActor>['scope'] = null
  let guard: Guard<TState, TActor>

  if (scoped) {
    const declaration = (
      options as ScopedStepOptions<TState, unknown, TActor, unknown>
    ).scope
    if (
      typeof declaration !== 'object' ||
      declaration === null ||
      typeof declaration.select !== 'function' ||
      typeof declaration.key !== 'function'
    ) {
      throw new TypeError(
        `step '${name}': scope must be { select: state => elements, key: element => string }`,
      )
    }
    validateConditionMap(name, 'requires', options.requires, false)
    validateConditionMap(name, 'permits', options.permits, false)
    scope = { select: declaration.select, key: declaration.key }
    // Erasure, not conversion: scoped maps are runtime-identical to unscoped
    // ones; evaluation binds the scope element the scoped types promise.
    const scopedOptions = options as ScopedStepOptions<
      TState,
      unknown,
      TActor,
      unknown
    >
    guard = {
      ...(scopedOptions.requires !== undefined && {
        requires: eraseScopedConditionMap(scopedOptions.requires),
      }),
      ...(scopedOptions.permits !== undefined && {
        permits: eraseScopedConditionMap(scopedOptions.permits),
      }),
    }
  } else {
    const unscoped = options as StepOptions<TState, TActor, unknown>
    validateConditionMap(name, 'requires', unscoped.requires, true)
    validateConditionMap(name, 'permits', unscoped.permits, true)
    guard = {
      ...(unscoped.requires !== undefined && { requires: unscoped.requires }),
      ...(unscoped.permits !== undefined && { permits: unscoped.permits }),
    }
  }

  return {
    name,
    title: options.title ?? null,
    description: options.description ?? null,
    guard,
    scope,
    input: options.input ?? null,
    retry: normalizeRetry(name, options.retry),
    // The one erasure cast for handlers: the authored context (typed input,
    // typed scope element) is what the execution lifecycle constructs; see
    // ErasedStepHandler.
    handler: options.handler as unknown as ErasedStepHandler<TState, TActor>,
  }
}

/**
 * The `step()` authoring surface with the case's state and actor types fixed.
 *
 * Same two call shapes as `step()` — scoped first, discriminated by the
 * presence of `scope` — but `TState`/`TActor` are already substituted, so
 * only the per-step generics (scope element, input) remain to be inferred.
 * That is what makes annotation-free authoring work: conditions and handlers
 * no longer participate in inferring the state type, they just receive it
 * contextually, and a scoped step's element type anchors on `scope.select`
 * alone (so `ctx.scope` is the element, with no `undefined` to narrow away).
 */
export interface BoundStep<TState, TActor = unknown> {
  <TElement, TInput = undefined>(
    options: ScopedStepOptions<TState, TElement, TActor, TInput>,
  ): StepDefinition<TState, TActor>
  <TInput = undefined>(
    options: StepOptions<TState, TActor, TInput>,
  ): StepDefinition<TState, TActor>
}

/**
 * A value-level carrier for `stepsOf`'s actor type — nothing but the type.
 * Exists because `TActor` has no value to be inferred from (a case's actor
 * shape is app-defined and never materializes at definition time), and
 * spelling it as a type argument would force spelling the schema's type too
 * (TypeScript has no partial type-argument inference).
 */
export interface ActorMarker<TActor> {
  readonly __actor?: TActor
}

const ACTOR_MARKER: ActorMarker<never> = Object.freeze({})

/** Name the actor type of a `stepsOf` factory: `stepsOf(PurchaseState, actor<PurchaseActor>())`. */
export const actor = <TActor>(): ActorMarker<TActor> => ACTOR_MARKER

/**
 * Bind `step()` to a case's state schema — the schema-anchored authoring
 * factory.
 *
 * ```ts
 * const purchaseStep = stepsOf(PurchaseState, actor<PurchaseActor>())
 *
 * purchaseStep({
 *   name: 'issue-funding-call',
 *   requires: { escrowReady: s => s.escrow.status === 'open' },        // s: inferred from the schema
 *   permits:  { isOrganizer: (_s, ctx) => hasRole(ctx.actor, 'organizer') },
 *   handler: async s => s,
 * })
 *
 * purchaseStep({
 *   name: 'escalate-verification',
 *   scope: { select: s => s.buyers.filter(b => b.verification.status === 'review'), key: b => b.id },
 *   requires: { flagged: (_s, ctx) => ctx.scope.verification.flaggedAt !== null },  // ctx.scope: Buyer
 *   handler: async s => s,
 * })
 * ```
 *
 * The state type is derived from the schema *value* — the same
 * `InferOutput` derivation `caseType` performs — so the factory and the case
 * type are anchored to one declaration and cannot drift apart: the state a
 * condition sees is definitionally the state the engine validates against.
 * The per-condition annotations the bare `step()` needs
 * (`(s: Purchase) => …`) disappear, because `TState` is no longer inferred
 * from the options.
 *
 * The second argument exists only to name the actor type and carries no
 * runtime information; omit it for an untyped actor. Define one factory per
 * case type module, next to the schema, and author every step of that case
 * type through it.
 *
 * Returns `step` itself, re-typed — a step authored through the factory is
 * bit-for-bit an ordinary step definition. `step` is deliberately not part
 * of the package barrel: this factory is the public authoring surface, and
 * a helper that builds steps generically should accept a
 * {@link BoundStep} rather than reach for the unbound `step`.
 * Throws at definition time when `state` is not a Standard Schema, like
 * every other malformed-definition case in this module.
 */
export const stepsOf = <S extends StandardSchemaV1, TActor = unknown>(
  state: S,
  _actor?: ActorMarker<TActor>,
): BoundStep<StandardSchemaV1.InferOutput<S>, TActor> => {
  if (!isStandardSchema(state)) {
    throw new TypeError(
      'stepsOf: state must be a Standard Schema (e.g. a zod schema)',
    )
  }
  return step
}

/** A step's declared input failed validation against its input schema. */
export class StepInputValidationError extends AffordanceError {
  readonly stepName: string
  readonly issues: readonly StandardSchemaV1.Issue[]

  constructor(stepName: string, issues: readonly StandardSchemaV1.Issue[]) {
    super(
      'invalid-input',
      `invalid input for step '${stepName}': ${issues.map((issue) => issue.message).join('; ')}`,
    )
    this.name = 'StepInputValidationError'
    this.stepName = stepName
    this.issues = issues
  }
}

/**
 * Validate a step's input against its declared input schema — the validation
 * plumbing the execution lifecycle runs before invoking the handler ("validated before the
 * handler runs"). Returns the schema *output* (defaults applied). A step
 * without an input schema accepts only `undefined` and yields `undefined`;
 * anything else is a caller bug and throws.
 */
export const validateStepInput = async <TState, TActor>(
  definition: StepDefinition<TState, TActor>,
  input: unknown,
): Promise<unknown> => {
  if (definition.input === null) {
    if (input !== undefined) {
      throw new StepInputValidationError(definition.name, [
        { message: 'step declares no input schema, but input was provided' },
      ])
    }
    return undefined
  }
  const result = await definition.input['~standard'].validate(input)
  if (result.issues)
    throw new StepInputValidationError(definition.name, result.issues)
  return result.value
}

/**
 * The framework-agnostic adapter core.
 *
 * A tiny router over a plain `{method, path, query, body, actor}` request and
 * a plain `{status, body}` response — no `Request`, no `Response`, no
 * `req`/`res`, nothing from any HTTP library. A binding for hono, express,
 * Lambda, or a test harness is then a translation of those two shapes and
 * nothing else; `hono.ts` stays tiny and exists mostly to prove it.
 *
 * The seam — the swap point between this router and any HTTP framework —
 * also fixes where actor resolution lives: on the *host* side of it. The
 * framework never sees a session, a token, or a header — the
 * binding resolves whatever the app calls an actor and puts it on the
 * request. Everything below this line treats that value as opaque.
 */

import { JOURNAL_ENTRY_KINDS } from '@affordance/contract'
import type {
  AffordanceErrorCode,
  DeadLetterFilter,
  Engine,
  ExternalEvent,
  JournalEntryType,
  JournalFilter,
  StepMetadata,
} from '@affordance/core'
import {
  AffordanceError,
  StepInputValidationError,
  StepNotAvailableError,
  toEpochMs,
} from '@affordance/core'
import { visibleRefusal } from './audience.js'
import type {
  ContractContext,
  DescribeInput,
  InputDescriptor,
  RouteName,
  Visibility,
} from './contract.js'
import {
  ROUTES,
  toAffordancePayload,
  toDeadLettersPayload,
  toErrorPayload,
  toExecutionPayload,
  toExplanationPayload,
  toIngestionPayload,
  toJournalPayload,
} from './contract.js'

/**
 * What the adapter needs from an engine — and nothing more. `Engine`
 * satisfies it structurally — by having these members, no declaration
 * needed; a test satisfies it with a fake, no database required. Depending
 * on the whole `Engine` here would mean a stub has to lie to the compiler
 * (`as unknown as Engine`) and would keep compiling if the adapter quietly
 * started calling more.
 */
export type EnginePort = Pick<
  Engine,
  | 'createCase'
  | 'affordances'
  | 'affordancesOf'
  | 'explain'
  | 'execute'
  | 'journal'
  | 'ingest'
  | 'deadLetters'
  | 'inputSchemaFor'
  | 'stepMetadataFor'
>

/** One request, in the only shape this adapter knows. */
export interface ApiRequest {
  readonly method: string
  /** Path relative to the mount point, e.g. `/cases/5f1b/affordances`. */
  readonly path: string
  readonly query?: Readonly<Record<string, string | undefined>>
  /** The parsed JSON body, when there is one. */
  readonly body?: unknown
  /**
   * The Actor, resolved by the host. Opaque: passed verbatim to conditions,
   * journaled verbatim, and used verbatim for visibility decisions.
   */
  readonly actor: unknown
  /** Override the payload's visibility for this request (an ops console, say). */
  readonly visibility?: Visibility
}

export interface ApiResponse {
  readonly status: number
  readonly body: unknown
}

/** Options for {@link createAffordanceApi}. */
export interface ApiOptions {
  readonly engine: EnginePort
  /** Mount point every href is prefixed with (default `''`). */
  readonly basePath?: string
  /** Default visibility (default `'permitted'`; see the contract document). */
  readonly visibility?: Visibility
  /**
   * Serialize a step's input schema for the wire — `z.toJSONSchema` for a zod
   * app. Omitted, `input.schema` is `null` and clients rely on the step's
   * documentation.
   */
  readonly describeInput?: DescribeInput
}

/** The adapter core. */
export interface AffordanceApi {
  handle(request: ApiRequest): Promise<ApiResponse>
}

const json = (status: number, body: unknown): ApiResponse => ({ status, body })

/**
 * The status each kind of refusal answers with.
 *
 * A total map over {@link AffordanceErrorCode}, so the compiler — not a
 * reviewer — is what keeps this exhaustive. The framework declaring the
 * *kind* and the adapter declaring the *status* is the whole division of
 * labour: core owns no HTTP, and an error class cannot reach this file
 * without a code, so it cannot arrive here unmapped.
 */
const STATUS: Record<AffordanceErrorCode, number> = {
  'step-not-available': 409,
  'case-busy': 409,
  'invalid-input': 422,
  'not-found': 404,
  'bad-request': 400,
  'execution-failed': 500,
  'invalid-state': 500,
}

/**
 * Map a framework error onto the contract's status + error code.
 *
 * Two refusals carry structured detail worth putting on the wire and are
 * named individually; the rest are the code, the status and the message.
 * Anything that is not an {@link AffordanceError} is not a refusal at all —
 * a bug, or the database being gone — and is rethrown rather than translated
 * into a response.
 */
const toErrorResponse = (
  error: unknown,
  visibility: Visibility,
): ApiResponse => {
  if (!(error instanceof AffordanceError)) throw error
  const status = STATUS[error.code]

  if (error instanceof StepNotAvailableError) {
    // What the refusal may say — its prose included — is the audience
    // module's decision, not this router's.
    const refusal = visibleRefusal(error, visibility)
    return json(
      status,
      toErrorPayload(error.code, refusal.message, {
        possible: refusal.possible,
        permitted: refusal.permitted,
        unmet: refusal.unmet,
      }),
    )
  }
  if (error instanceof StepInputValidationError) {
    return json(
      status,
      toErrorPayload(error.code, error.message, { issues: error.issues }),
    )
  }
  return json(status, toErrorPayload(error.code, error.message))
}

/** `/cases/{id}/affordances` → `['cases', '{id}', 'affordances']`. */
const segments = (path: string): readonly string[] =>
  path
    .split('/')
    .filter((segment) => segment !== '')
    .map(decodeURIComponent)

/**
 * Accept a path with or without the mount point on it. A binding hands over
 * whatever the server saw (`/api/cases/…`); a direct caller — a test, a
 * queue consumer — passes the resource path (`/cases/…`). Both are the same
 * request, and the adapter should not care which side of the mount it is
 * being called from.
 */
const withoutBase = (path: string, basePath: string): string =>
  basePath !== '' && (path === basePath || path.startsWith(`${basePath}/`))
    ? path.slice(basePath.length)
    : path

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/**
 * A caller error found while reading the request. Thrown as the framework's
 * own `bad-request` refusal so the one translator below answers it — the
 * contract promises a caller's typo is a 400, and it must never surface
 * instead as an untranslated 500 — that would answer the typo as though it
 * were an infrastructure failure. This and
 * {@link toErrorResponse}'s rethrow are the two halves of one rule: a crash
 * is never answered as a refusal, and a caller's mistake is never surfaced
 * as a crash.
 */
const badRequest = (message: string): never => {
  throw new AffordanceError('bad-request', message)
}

/** An instant query parameter, validated with core's own reading of instants. */
const asInstant = (
  value: string | undefined,
  name: string,
): string | undefined => {
  if (value === undefined) return undefined
  if (toEpochMs(value) === null) {
    badRequest(
      `query parameter '${name}' must be an instant (ISO-8601), got '${value}'`,
    )
  }
  return value
}

/** A non-negative integer query parameter — `NaN` must never reach a SQL bind. */
const asCount = (
  value: string | undefined,
  name: string,
): number | undefined => {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    badRequest(
      `query parameter '${name}' must be a non-negative integer, got '${value}'`,
    )
  }
  return parsed
}

const isEntryKind = (value: string): value is JournalEntryType =>
  (JOURNAL_ENTRY_KINDS as readonly string[]).includes(value)

/**
 * The `entry` filter, validated against the contract's closed set of entry
 * kinds — a typo answers 400 like every other malformed parameter, never a
 * silently empty journal.
 */
const asEntryKinds = (
  value: string | undefined,
): readonly JournalEntryType[] | undefined => {
  if (value === undefined) return undefined
  const kinds = value.split(',')
  const unknown = kinds.find((kind) => !isEntryKind(kind))
  if (unknown !== undefined) {
    badRequest(
      `query parameter 'entry' must name journal entry kinds (${JOURNAL_ENTRY_KINDS.join(', ')}), got '${unknown}'`,
    )
  }
  return kinds.filter(isEntryKind)
}

const journalFilterFrom = (
  query: Readonly<Record<string, string | undefined>>,
): JournalFilter => {
  const scopeKey = asString(query['scopeKey'])
  const step = asString(query['step'])
  const executionId = asString(query['executionId'])
  const entry = asEntryKinds(asString(query['entry']))
  const since = asCount(asString(query['since']), 'since')
  const limit = asCount(asString(query['limit']), 'limit')
  return {
    ...(scopeKey !== undefined && { scopeKey }),
    ...(step !== undefined && { step }),
    ...(executionId !== undefined && { executionId }),
    ...(entry !== undefined && { entry }),
    ...(since !== undefined && { since }),
    ...(limit !== undefined && { limit }),
  }
}

/**
 * Memoize a registry read keyed by (case type, step). The values it guards
 * are static per key — a step's input descriptor, its human metadata — so
 * each is resolved once per adapter, not once per affordance per request.
 */
const perStepMemo = <T>(
  resolve: (caseTypeName: string, step: string) => T,
): ((caseTypeName: string, step: string) => T) => {
  const cache = new Map<string, T>()
  return (caseTypeName, step) => {
    const key = `${caseTypeName}\u0000${step}`
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const value = resolve(caseTypeName, step)
    cache.set(key, value)
    return value
  }
}

/**
 * Match a request against the contract's route table. The same table the
 * link builder fills, matched segment-for-segment — so a link the contract
 * hands out is parseable by construction.
 */
const matchRoute = (
  method: string,
  parts: readonly string[],
): { name: RouteName; params: Readonly<Record<string, string>> } | null => {
  for (const [name, route] of Object.entries(ROUTES)) {
    if (route.method !== method || route.pattern.length !== parts.length)
      continue
    const params: Record<string, string> = {}
    let matched = true
    for (let i = 0; i < route.pattern.length; i += 1) {
      const segment = route.pattern[i] as string
      const part = parts[i] as string
      if (segment.startsWith(':')) params[segment.slice(1)] = part
      else if (segment !== part) {
        matched = false
        break
      }
    }
    if (matched) return { name: name as RouteName, params }
  }
  return null
}

/**
 * Build the adapter over an engine port.
 *
 * Routing is the contract's own `ROUTES` table, matched here and filled by
 * the link builder — one grammar, two readers, no drift.
 */
export const createAffordanceApi = (options: ApiOptions): AffordanceApi => {
  const basePath = options.basePath ?? ''
  const defaultVisibility = options.visibility ?? 'permitted'

  // The descriptor is resolved and serialized once per (case type, step).
  const describeStep = perStepMemo((caseTypeName, step): InputDescriptor => {
    const schema = options.engine.inputSchemaFor(caseTypeName, step)
    return schema === null
      ? { required: false, schema: null, vendor: null }
      : {
          required: true,
          schema:
            options.describeInput === undefined
              ? null
              : options.describeInput(schema),
          vendor: schema['~standard'].vendor,
        }
  })

  // The step's human metadata, resolved once the same way. Unknown steps
  // answer with nulls — a serializer is translating a record that already
  // exists, so "unknown" here only means the definitions changed after the
  // record was written; the entry keeps its wire name.
  const NO_METADATA: StepMetadata = { title: null, description: null }
  const metadataFor = perStepMemo(
    (caseTypeName, step): StepMetadata =>
      options.engine.stepMetadataFor(caseTypeName, step) ?? NO_METADATA,
  )

  const contextFor = (visibility: Visibility): ContractContext => ({
    basePath,
    visibility,
    describeStep,
    metadataFor,
  })

  const route = async (
    request: ApiRequest,
    visibility: Visibility,
  ): Promise<ApiResponse> => {
    const parts = segments(withoutBase(request.path, basePath))
    const query = request.query ?? {}
    const method = request.method.toUpperCase()
    const context = contextFor(visibility)

    const matched = matchRoute(method, parts)
    if (matched === null) {
      return json(
        404,
        toErrorPayload('not-found', `no route for ${method} ${request.path}`),
      )
    }
    const { name, params } = matched

    switch (name) {
      case 'createCase': {
        const body = (request.body ?? {}) as {
          caseType?: unknown
          state?: unknown
        }
        if (typeof body.caseType !== 'string') {
          return json(
            400,
            toErrorPayload('bad-request', 'body must be { caseType, state }'),
          )
        }
        const created = await options.engine.createCase(
          body.caseType,
          body.state ?? {},
        )
        // Computed from the handle just returned — the row was written and
        // validated one statement ago, so a re-read would only fetch back
        // the same data.
        const affordances = options.engine.affordancesOf(created, request.actor)
        return json(201, toAffordancePayload(affordances, context))
      }

      case 'ingest': {
        const event = request.body as ExternalEvent | undefined
        if (
          event === undefined ||
          typeof event.system !== 'string' ||
          typeof event.externalId !== 'string' ||
          typeof event.type !== 'string'
        ) {
          return json(
            400,
            toErrorPayload(
              'bad-request',
              'body must be { system, externalId, type, … }',
            ),
          )
        }
        // Always 200 for an event we recorded, whatever became of it: a 5xx
        // teaches the provider to retry something that will never succeed.
        return json(200, toIngestionPayload(await options.engine.ingest(event)))
      }

      case 'deadLetters': {
        const system = asString(query['system'])
        const caseId = asString(query['caseId'])
        const limit = asCount(asString(query['limit']), 'limit')
        const filter: DeadLetterFilter = {
          ...(system !== undefined && { system }),
          ...(caseId !== undefined && { caseId }),
          ...(limit !== undefined && { limit }),
        }
        return json(
          200,
          toDeadLettersPayload(await options.engine.deadLetters(filter)),
        )
      }

      case 'affordances': {
        // `asOf` evaluates the affordances as of a caller-chosen instant, on
        // a read only. Only the instant moves — the state is the case's
        // current state — so this previews time-gated steps ("what becomes
        // possible once a seven-day clock runs out"); the journal, not this
        // read, answers what was possible in the past. It is deliberately
        // not accepted on the execute route — evaluating a claim as of an
        // instant the caller chose would let the caller get past a time
        // condition.
        const affordances = await options.engine.affordances(
          params['caseId'] as string,
          request.actor,
          asInstant(asString(query['asOf']), 'asOf'),
        )
        return json(200, toAffordancePayload(affordances, context))
      }

      case 'explain': {
        const scopeKey = asString(query['scopeKey'])
        const asOf = asInstant(asString(query['asOf']), 'asOf')
        const explanation = await options.engine.explain(
          params['caseId'] as string,
          params['step'] as string,
          {
            actor: request.actor,
            ...(scopeKey !== undefined && { scopeKey }),
            ...(asOf !== undefined && { asOf }),
          },
        )
        return json(200, toExplanationPayload(explanation, context))
      }

      case 'execute': {
        const body = (request.body ?? {}) as {
          scopeKey?: unknown
          input?: unknown
        }
        const result = await options.engine.execute(
          params['caseId'] as string,
          params['step'] as string,
          {
            actor: request.actor,
            ...(typeof body.scopeKey === 'string' && {
              scopeKey: body.scopeKey,
            }),
            ...(body.input !== undefined && { input: body.input }),
          },
        )
        return json(201, toExecutionPayload(result, context))
      }

      case 'journal': {
        const entries = await options.engine.journal(
          params['caseId'] as string,
          journalFilterFrom(query),
        )
        return json(200, toJournalPayload(entries, context))
      }
    }
  }

  return {
    handle: async (request) => {
      const visibility = request.visibility ?? defaultVisibility
      try {
        return await route(request, visibility)
      } catch (error) {
        return toErrorResponse(error, visibility)
      }
    },
  }
}

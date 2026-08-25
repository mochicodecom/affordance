/**
 * Wiring: the engine, the providers, the HTTP adapter — plus the demo
 * console.
 *
 * This is the whole of what an app has to do — bring a database,
 * register the case types, say what ingestion runs as, and
 * mount the adapter. Everything else in this package is domain: state,
 * steps, and the mock providers those steps call.
 *
 * The served app is two layers: the affordance contract under `/api`, and
 * a dev console quarantined under `/dev` (plus the demo page at `/`). The
 * console is *not* contract material and must never migrate into
 * `@affordance/http` — see `createDevConsole` below for why each route is
 * a recorded leak.
 */

import { readFile } from 'node:fs/promises'
import type { DatabaseAccess, Engine, Queryable } from '@affordance/core'
import {
  bootstrap,
  CASE_TABLES,
  CaseNotFoundError,
  createEngine,
  FRAMEWORK_SCHEMA,
  queryableOf,
  routedStep,
} from '@affordance/core'
import type { AffordanceApi } from '@affordance/http'
import { createAffordanceApi, createHonoApp } from '@affordance/http'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import { createPurchaseDefinition } from './purchase.js'
import type { MockServiceOptions, MockServices } from './services.js'
import { createMockServices } from './services.js'
import type { Purchase, PurchaseActor } from './state.js'
import { integration, wireLevers } from './state.js'

/** Options for {@link createPurchaseApp}. */
export interface PurchaseAppOptions {
  readonly db: DatabaseAccess
  /** Provider behaviour: latency, retry count. */
  readonly services?: MockServiceOptions | MockServices
  /** Mount point for the HTTP adapter (default `/api`). */
  readonly basePath?: string
  /**
   * Run the framework's DDL at start-up (default true). Set false when the
   * schema is managed elsewhere — a migration job, or a test suite that
   * bootstraps once for the whole run rather than once per app instance.
   */
  readonly bootstrapSchema?: boolean
}

/** Everything the app exposes to a caller (or a test). */
export interface PurchaseApp {
  readonly engine: Engine
  readonly services: MockServices
  readonly api: AffordanceApi
  /**
   * The root hono app: the demo page at `/`, the `/dev` console, and the
   * affordance contract mounted under it. Serve it or call `request()` on it.
   */
  readonly http: Hono
  /** Deliver every provider webhook now due. */
  settle(now?: number): Promise<void>
  stop(): Promise<void>
}

/**
 * The header names this host reads the acting persona from. The ui's data
 * layer restates the same pair (it cannot import server code); the
 * shadow-table test pins the two against each other.
 */
export const ACTOR_HEADERS = {
  id: 'x-actor-id',
  roles: 'x-actor-roles',
} as const

const isServices = (value: unknown): value is MockServices =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as MockServices).flush === 'function'

/** Row shape of the framework's cases table, as the list query selects it. */
type DevCaseRow = {
  id: string
  case_type: string
  seq: string | number
  state: unknown
  ended_at: Date | null
  created_at: Date
  updated_at: Date
}

/**
 * The demo console: everything the reference UI needs that is deliberately
 * not part of the affordance contract. One `/dev` prefix marks the seam.
 *
 * - `GET /` — the demo page: the built React console (`ui/dist`, made by
 *   `ui:build`). `GET /assets/*` serves the build's hashed assets. Never
 *   auto-builds; `serve` refuses to start without it, and this
 *   route answers 503 with the build command rather than serve nothing.
 * - `GET /dev/cases` — a case list. The store exports no list function and
 *   the `Engine` has no read model (apps own their read models), so this
 *   queries the framework's own table. **A recorded leak**, acceptable only
 *   under `/dev`; it must never migrate into `@affordance/http`.
 * - `GET /dev/cases/{id}` — one case, via `engine.case`: unconditional
 *   state. A decision, not an accident: `/dev` is the console's operator
 *   surface — it takes no actor and only the demo host mounts it. The
 *   contract's own journal redacts state and `permits` results for the
 *   audience, so this route is deliberately the one place the raw document
 *   is served whole.
 * - `GET /dev/world[?caseId=]` — what the outside world owes: every
 *   undelivered provider webhook (correlated to its case, so the page can
 *   say *whose* answer it is). With `caseId`, also
 *   that case's wire levers — which buyers' money the escrow company could
 *   announce, computed by the domain (`wireLevers` in state.ts, beside the
 *   `arrivedAmount` rule the close guard counts with), so the console
 *   cannot drift from the guard.
 * - `POST /dev/deliver` — deliver exactly one queued webhook, by event id.
 * - `POST /dev/settle` — everything at once (all due webhooks, in rounds);
 *   kept for the console and tests.
 *
 * No route here takes an actor.
 */
interface DevConsoleOptions {
  readonly db: Queryable
  readonly engine: Engine
  readonly services: MockServices
  readonly settle: (now?: number) => Promise<void>
}

/** Where `ui:build` puts the React console; absent until the first build. */
const UI_DIST = new URL('../ui/dist/', import.meta.url)

/** The asset types Vite emits into `dist/assets/`; anything else is a 404. */
const ASSET_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

const createDevConsole = ({
  db,
  engine,
  services,
  settle,
}: DevConsoleOptions): Hono => {
  const dev = new Hono()

  const servePage = async (c: Context) => {
    try {
      // no-cache: the shell references hashed assets, and a cached shell
      // pins a stale bundle long after a rebuild.
      c.header('cache-control', 'no-cache')
      return c.html(await readFile(new URL('index.html', UI_DIST), 'utf8'))
    } catch {
      return c.text(
        'ui/dist is missing — build the console first:\n' +
          '  pnpm --filter @affordance/reference-app ui:build\n',
        503,
      )
    }
  }
  dev.get('/', servePage)
  // The newcomer intro: same bundle, second page — main.tsx picks the page
  // by pathname, so this route only needs to serve the shell.
  dev.get('/intro', servePage)

  dev.get('/assets/:file', async (c) => {
    const file = c.req.param('file')
    const type = ASSET_TYPES[file.slice(file.lastIndexOf('.'))]
    if (type === undefined || file.includes('/') || file.includes('..'))
      return c.notFound()
    try {
      const body = await readFile(new URL(`assets/${file}`, UI_DIST))
      // The filenames are content-hashed, so a cached copy can never go
      // stale — the shell's no-cache is what picks up a rebuild.
      return c.body(new Uint8Array(body), 200, {
        'content-type': type,
        'cache-control': 'public, max-age=31536000, immutable',
      })
    } catch {
      return c.notFound()
    }
  })

  dev.get('/dev/cases', async (c) => {
    // `state` rides along so the console can label a case by what it is —
    // the interpretation (an address, for house-purchase) stays in the
    // UI's leak module; this route stays case-type-blind.
    const { rows } = await db.query<DevCaseRow>(
      `select id, case_type, seq, state, ended_at, created_at, updated_at
       from ${FRAMEWORK_SCHEMA}.cases order by created_at desc`,
    )
    return c.json({
      cases: rows.map((row) => ({
        id: row.id,
        caseTypeName: row.case_type,
        seq: Number(row.seq),
        state: row.state,
        endedAt: row.ended_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    })
  })

  dev.get('/dev/cases/:id', async (c) => {
    try {
      return c.json(await engine.case(c.req.param('id')))
    } catch (error) {
      if (error instanceof CaseNotFoundError) {
        return c.json({ error: 'not-found', message: error.message }, 404)
      }
      throw error
    }
  })

  // Delete a case outright — journal, claims, correlations, dedup rows and
  // all. Not contract material and never will be: the contract has no notion
  // of un-happening a case. This is the dev console hand-deleting rows from
  // a demo database, which is why it lives here and nowhere else. The table
  // set is the framework's own (CASE_TABLES) — a private copy went stale
  // once already, leaving deleted cases' ingested_events behind, and those
  // leftover dedup rows suppressed future deliveries that quoted the same
  // identifiers.
  dev.delete('/dev/cases/:id', async (c) => {
    const id = c.req.param('id')
    for (const { table, caseColumn } of CASE_TABLES) {
      await db.query(
        `delete from ${FRAMEWORK_SCHEMA}.${table} where ${caseColumn} = $1`,
        [id],
      )
    }
    return c.json({ ok: true })
  })

  dev.get('/dev/world', async (c) => {
    const events = await Promise.all(
      services.outbox.map(async (entry) => {
        const correlation = await engine.correlationOf(
          entry.system,
          entry.externalId,
        )
        return {
          ...entry,
          // The framework's own routing rule, so the panel's prediction of
          // where a webhook lands cannot drift from what `ingest` will do.
          step:
            correlation === null
              ? entry.step
              : (routedStep(entry, correlation) ?? undefined),
          ...(correlation !== null && {
            caseId: correlation.caseId,
            ...(correlation.scopeKey !== null && {
              scopeKey: correlation.scopeKey,
            }),
          }),
        }
      }),
    )
    // Levers are per-case and case-type-specific, so they appear only when a
    // case is named — and they are computed here, next to the definitions,
    // never re-derived by the page from raw state.
    const forCase = c.req.query('caseId')
    let levers: ReturnType<typeof wireLevers> = []
    if (forCase !== undefined && forCase !== '') {
      try {
        levers = wireLevers((await engine.case(forCase)).state as Purchase)
      } catch {
        // An unknown or unreadable case simply has no levers to offer.
      }
    }
    return c.json({ events, levers })
  })

  // The escrow company's hand: announce a wire, unprompted, exactly as the
  // real company would. No step requests a wire — that is the point of the
  // ingestion design — so without this lever a hand-driven case can never
  // fund. Announcing only ENQUEUES the webhook; the world panel's Deliver
  // button plays it like any other provider answer.
  dev.post('/dev/announce-wire', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      caseId?: unknown
      buyerId?: unknown
      amount?: unknown
      fromAccount?: unknown
    }
    if (
      typeof body.caseId !== 'string' ||
      typeof body.buyerId !== 'string' ||
      typeof body.amount !== 'number'
    ) {
      return c.json(
        {
          error: 'bad-request',
          message: 'caseId, buyerId and amount are required',
        },
        400,
      )
    }
    let applicationId: string | null
    try {
      const handle = await engine.case(body.caseId)
      // Through the one typed door — a structural cast here would keep
      // compiling across a state rename and silently 409 forever.
      applicationId = (handle.state as Purchase).escrow.applicationId
    } catch (error) {
      if (error instanceof CaseNotFoundError) {
        return c.json({ error: 'not-found', message: error.message }, 404)
      }
      throw error
    }
    if (applicationId === null) {
      return c.json(
        {
          error: 'no-escrow',
          message: 'this case has no escrow application to wire into',
        },
        409,
      )
    }
    const wireId = services.announceWire({
      applicationId,
      buyerId: body.buyerId,
      amount: body.amount,
      ...(typeof body.fromAccount === 'string' && {
        fromAccount: body.fromAccount,
      }),
    })
    return c.json({ ok: true, wireId })
  })

  dev.post('/dev/deliver', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { eventId?: unknown }
    const results =
      typeof body.eventId === 'string'
        ? await services.deliver(engine, body.eventId)
        : null
    if (results === null) {
      return c.json(
        {
          error: 'not-found',
          message: `no queued event '${String(body.eventId ?? '')}'`,
        },
        404,
      )
    }
    return c.json({ ok: true, deliveries: results.length })
  })

  dev.post('/dev/settle', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { now?: unknown }
    await settle(typeof body.now === 'number' ? body.now : undefined)
    return c.json({ ok: true })
  })

  return dev
}

/**
 * Build the app. The actor arriving on an HTTP request is resolved by the
 * host (here: a header, because this is a reference app and not an auth
 * system) — the framework never sees it.
 */
export const createPurchaseApp = async (
  options: PurchaseAppOptions,
): Promise<PurchaseApp> => {
  if (options.bootstrapSchema !== false)
    await bootstrap(queryableOf(options.db))

  const services = isServices(options.services)
    ? options.services
    : createMockServices(options.services)

  const caseTypes = [createPurchaseDefinition(services)]
  const engine = createEngine({
    db: options.db,
    caseTypes,
    // Ingestion runs as *this app's* actor shape, not as the
    // framework's marker: `permits` conditions here read `roles`.
    ingestion: { actor: (event) => integration(event.system) },
  })

  const basePath = options.basePath ?? '/api'

  const api = createAffordanceApi({
    engine,
    basePath,
    describeInput: (schema) => z.toJSONSchema(schema as z.ZodType),
  })

  const actorFromHeaders = (c: Context): PurchaseActor => ({
    id: c.req.header(ACTOR_HEADERS.id) ?? 'anonymous',
    roles: (c.req.header(ACTOR_HEADERS.roles) ?? '').split(',').filter(Boolean),
  })

  const contract = createHonoApp({ api, resolveActor: actorFromHeaders })

  /** Advance the world: deliver every provider webhook now due. */
  const settle = async (now?: number): Promise<void> => {
    await services.flush(engine, now)
  }

  // The root app: the page, the quarantined dev console, then the contract.
  // Hono prefers static routes over the contract app's `/*` catch-all, so
  // mounting the contract at root leaves every `/api` route untouched.
  const http = new Hono()
  const devConsole = createDevConsole({
    db: queryableOf(options.db),
    engine,
    services,
    settle,
  })
  // The one authorization rule this host enforces, at the same seam that
  // resolves the actor: creating a case takes the organizer role. Case
  // creation has no guard for a `permits` to live in — who may start a
  // matter is the host's decision, so it sits here in the wiring, not in
  // the framework. `not-permitted` is this host's auth refusal, not one of
  // the contract's closed refusal codes.
  http.post(`${basePath}/cases`, async (c, next) => {
    if (!actorFromHeaders(c).roles.includes('organizer')) {
      return c.json(
        {
          error: 'not-permitted',
          message: 'creating a case requires the organizer role',
        },
        403,
      )
    }
    await next()
  })
  http.route('/', devConsole)
  http.route('/', contract)

  return {
    engine,
    services,
    api,
    http,
    settle,
    stop: async () => {
      services.stop()
    },
  }
}

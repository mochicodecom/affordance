/**
 * A test harness that can only do what a client could do.
 *
 * Every test in this package drives the purchase through the HTTP adapter,
 * following links out of affordance payloads and never constructing a URL or
 * reaching into the engine to make something happen. That constraint is the
 * point: if the happy path is reachable this way, the HATEOAS claim is true
 * for this case type, and if it is not, no amount of green unit tests
 * matters.
 */

import type { JournalEntry } from '@affordance/core'
import type {
  AffordancePayload,
  ApiRequest,
  ExecutionPayload,
} from '@affordance/http'
import { TEST_DATABASE_URL } from '@affordance/testkit'
import pg from 'pg'
import {
  createPurchaseApp,
  type PurchaseApp,
  type PurchaseAppOptions,
} from '../src/app.js'
import { HOUSE_PURCHASE, newPurchase } from '../src/purchase.js'
import type { Purchase, PurchaseActor } from '../src/state.js'
import { buyerNamed } from '../src/state.js'

/**
 * These suites close their pool in the same afterAll that stops the app, so
 * they build it here rather than through the testkit's self-closing
 * `testPool` — only the address is shared.
 */
export const createPool = (): pg.Pool =>
  new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 10 })

/** A client that speaks only the affordance contract. */
export interface Client {
  readonly app: PurchaseApp
  /** Create a purchase and return its case id. */
  create(
    actor: PurchaseActor,
    house?: { address?: string; target?: number },
  ): Promise<string>
  /** What this actor can do on this case — now, or as of a given instant. */
  affordances(
    caseId: string,
    actor: PurchaseActor,
    asOf?: string,
  ): Promise<AffordancePayload>
  /** Take a named affordance by following its own execute link. */
  take(
    caseId: string,
    actor: PurchaseActor,
    step: string,
    options?: { scopeKey?: string; input?: unknown },
  ): Promise<ExecutionPayload>
  /** Attempt a step and return the raw response, for the rejection cases. */
  attempt(
    caseId: string,
    actor: PurchaseActor,
    step: string,
    options?: { scopeKey?: string; input?: unknown },
  ): Promise<{ status: number; body: unknown }>
  /** The per-condition explanation of one step. */
  explain(
    caseId: string,
    actor: PurchaseActor,
    step: string,
    scopeKey?: string,
    asOf?: string,
  ): Promise<unknown>
  journal(
    caseId: string,
    filter?: Record<string, string>,
  ): Promise<readonly JournalEntry[]>
  /** The Case State, read straight from the row — for assertions only. */
  state(caseId: string): Promise<Purchase>
  /** The server mints buyer ids — tests learn them back from state, by name. */
  buyerIdOf(caseId: string, name: string): Promise<string>
  /** Deliver provider webhooks now due. */
  settle(now?: number): Promise<void>
}

const call = (app: PurchaseApp, request: ApiRequest) => app.api.handle(request)

export const createClient = async (
  pool: pg.Pool,
  options: Omit<PurchaseAppOptions, 'db'> = {},
): Promise<Client> => {
  // The schema is bootstrapped once per run in `test/global-setup.ts`; DDL
  // interleaved with other suites' Executions is a lock-ordering problem
  // nobody needs in a test.
  const app = await createPurchaseApp({
    db: { pool },
    bootstrapSchema: false,
    ...options,
  })

  const affordances = async (
    caseId: string,
    actor: PurchaseActor,
    asOf?: string,
  ): Promise<AffordancePayload> => {
    const response = await call(app, {
      method: 'GET',
      path: `/cases/${caseId}/affordances`,
      ...(asOf !== undefined && { query: { asOf } }),
      actor,
    })
    if (response.status !== 200)
      throw new Error(`affordances: ${JSON.stringify(response.body)}`)
    return response.body as AffordancePayload
  }

  const attempt: Client['attempt'] = async (caseId, actor, step, opts = {}) => {
    const payload = await affordances(caseId, actor)
    const offered = payload.affordances.find(
      (entry) =>
        entry.step === step &&
        (opts.scopeKey === undefined || entry.scopeKey === opts.scopeKey),
    )
    // Follow the link the payload gave us when there is one; when there is
    // not, address the step directly — the request a client makes when the
    // step stopped being offered between its last read and its click — and
    // the contract says the server must reject it cleanly rather than 404.
    const href =
      offered?.links.execute.href ?? `/api/cases/${caseId}/steps/${step}`
    return call(app, {
      method: 'POST',
      path: href.replace(/^\/api/, ''),
      body: {
        ...(opts.scopeKey !== undefined && { scopeKey: opts.scopeKey }),
        ...(opts.input !== undefined && { input: opts.input }),
      },
      actor,
    })
  }

  return {
    app,
    affordances,
    attempt,

    create: async (actor, house = {}) => {
      const response = await call(app, {
        method: 'POST',
        path: '/cases',
        body: {
          caseType: HOUSE_PURCHASE,
          state: newPurchase(house.address, house.target),
        },
        actor,
      })
      if (response.status !== 201)
        throw new Error(`create: ${JSON.stringify(response.body)}`)
      return (response.body as AffordancePayload).case.id
    },

    take: async (caseId, actor, step, opts = {}) => {
      const response = await attempt(caseId, actor, step, opts)
      if (response.status !== 201) {
        throw new Error(
          `take ${identityOf(step, opts.scopeKey)}: ${JSON.stringify(response.body)}`,
        )
      }
      return response.body as ExecutionPayload
    },

    explain: async (caseId, actor, step, scopeKey, asOf) => {
      const response = await call(app, {
        method: 'GET',
        path: `/cases/${caseId}/affordances/${step}`,
        query: {
          ...(scopeKey !== undefined && { scopeKey }),
          ...(asOf !== undefined && { asOf }),
        },
        actor,
      })
      return response.body
    },

    journal: async (caseId, filter = {}) => {
      const response = await call(app, {
        method: 'GET',
        path: `/cases/${caseId}/journal`,
        query: filter,
        actor: null,
      })
      return (response.body as { entries: readonly JournalEntry[] }).entries
    },

    state: async (caseId) => (await app.engine.case(caseId)).state as Purchase,

    buyerIdOf: async (caseId, name) => {
      const state = (await app.engine.case(caseId)).state as Purchase
      return buyerNamed(state, name, caseId).id
    },

    settle: (now) => app.settle(now),
  }
}

/** One affordance identity, written `step` or `step(scopeKey)`. */
const identityOf = (step: string, scopeKey?: string): string =>
  scopeKey === undefined ? step : `${step}(${scopeKey})`

/** The affordance identities on offer, as `step` or `step(scopeKey)`. */
export const offered = (payload: AffordancePayload): readonly string[] =>
  payload.affordances.map((entry) => identityOf(entry.step, entry.scopeKey))

/** The blocked identities, same shape. */
export const blocked = (payload: AffordancePayload): readonly string[] =>
  payload.blocked.map((entry) => identityOf(entry.step, entry.scopeKey))

/** The named conditions holding one blocked step shut. */
export const unmetOf = (
  payload: AffordancePayload,
  step: string,
): readonly string[] =>
  payload.blocked
    .find((entry) => entry.step === step)
    ?.unmet.map((condition) => condition.name) ?? []

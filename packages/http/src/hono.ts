/**
 * The hono binding — and a demonstration of how little a binding is.
 *
 * Everything an HTTP framework contributes is here: parse a body, read a
 * query, set a status. The seam (`api.ts`) is where the contract lives, so
 * porting this to express, Fastify, or a Lambda handler is rewriting this
 * file and nothing else.
 *
 * Actor resolution is the host's, always. `resolveActor` receives
 * hono's context — with whatever a session or auth middleware has already put
 * on it — and returns the app's own actor value. The framework never learns
 * what a header is.
 */

import type { Context } from 'hono'
import { Hono } from 'hono'
import type { AffordanceApi, ApiRequest } from './api.js'
import type { Visibility } from './contract.js'

/** Options for {@link createHonoApp}. */
export interface HonoBindingOptions {
  readonly api: AffordanceApi
  /**
   * Resolve the Actor for a request. Runs *after* the host's own auth
   * middleware, so `c.get('user')` (or whatever the app put there) is what
   * this reads.
   */
  readonly resolveActor: (c: Context) => unknown | Promise<unknown>
  /** Per-request visibility override — an internal console can widen it. */
  readonly resolveVisibility?: (c: Context) => Visibility | undefined
}

const bodyOf = async (c: Context): Promise<unknown> => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return undefined
  const type = c.req.header('content-type') ?? ''
  if (!type.includes('json')) return undefined
  try {
    return await c.req.json()
  } catch {
    return undefined
  }
}

/**
 * Build a hono app that serves the affordance contract. Mount it wherever the
 * host app wants: `app.route('/api', createHonoApp({ … }))`.
 */
export const createHonoApp = (options: HonoBindingOptions): Hono => {
  const app = new Hono()

  app.all('/*', async (c) => {
    const url = new URL(c.req.url)
    const request: ApiRequest = {
      method: c.req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      body: await bodyOf(c),
      actor: await options.resolveActor(c),
      ...(options.resolveVisibility !== undefined && {
        visibility: options.resolveVisibility(c),
      }),
    }
    const response = await options.api.handle(request)
    return c.json(response.body as object, response.status as 200)
  })

  return app
}

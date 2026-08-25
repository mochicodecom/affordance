/**
 * Mock verification, e-sign and escrow banking — in-repo, and deliberately
 * unhelpful in the ways real providers are.
 *
 * A demo whose integrations resolve inline proves nothing: the whole point of
 * the materialize-on-event pattern is that the answer arrives
 * *later*, out of band, more than once, and sometimes about a case that has
 * since moved on. So these services behave like the real thing in the three
 * ways that make integration hard:
 *
 * 1. **They answer later.** A request queues a delivery; nothing happens
 *    until the queue is flushed (or the auto-delivery timer fires). A case
 *    sits in "waiting on the provider" exactly as it would in production.
 * 2. **They deliver more than once.** Every queued webhook is delivered
 *    `attempts` times, because every provider retries and the framework's
 *    dedup has to earn its keep on each one.
 * 3. **They quote their own identifiers.** A webhook names an envelope, not a
 *    case — so it only routes if the handler that started the interaction
 *    registered the correlation.
 *
 * `flush()` exists so tests are deterministic; `start()` exists so the
 * served app behaves like a real deployment. Both drive the same queue.
 */

import { randomUUID } from 'node:crypto'
import type { Engine, ExternalEvent, IngestionResult } from '@affordance/core'
import { registeredAccountOf } from './state.js'

/** One webhook waiting to be delivered. */
interface QueuedDelivery {
  readonly event: ExternalEvent
  readonly dueAt: number
}

/** Options for {@link createMockServices}. */
export interface MockServiceOptions {
  /** How long a provider takes to answer, in milliseconds (default 0). */
  readonly latencyMs?: number
  /** How many times each webhook is delivered — providers retry (default 3). */
  readonly attempts?: number
  /** Deterministic ids, for tests that assert on them. */
  readonly idFactory?: () => string
}

/**
 * Every `system`/`type` pair the mock providers deliver — the whole
 * vocabulary of answers the outside world can send this app. The enqueue
 * calls below spread these, so this list is the pairs' one declaration; the
 * console's world labels restate the pairs and are pinned against this list
 * by the shadow-table test.
 */
export const PROVIDER_EVENTS = {
  checkCompleted: { system: 'verify', type: 'check.completed' },
  envelopeCompleted: { system: 'esign', type: 'envelope.completed' },
  accountOpened: { system: 'escrow', type: 'account.opened' },
  wireReceived: { system: 'escrow', type: 'wire.received' },
} as const

/** One undelivered webhook, as the dev console's world view lists it. */
export interface OutboxEntry {
  /** The provider's delivery id — the handle `deliver()` takes. */
  readonly eventId: string
  readonly system: string
  readonly externalId: string
  readonly type: string
  /** Present when the event overrides its correlation's default step. */
  readonly step?: string
}

/** The three mock providers plus the queue they share. */
export interface MockServices {
  /**
   * Start a source-of-funds verification for a buyer; returns the provider's
   * check id.
   */
  startVerification(input: {
    readonly buyerId: string
    readonly hits?: readonly string[]
  }): string
  /** Send a co-ownership agreement envelope; returns the provider's envelope id. */
  sendEnvelope(input: { readonly buyerId: string }): string
  /** Apply for an escrow account; returns the provider's application id. */
  applyForEscrowAccount(input: { readonly address: string }): string
  /**
   * Announce a wire arriving. The escrow company does this unprompted — there
   * is no request to correlate against, so the app registers the account's
   * correlation when the account opens.
   */
  announceWire(input: {
    readonly applicationId: string
    readonly buyerId: string
    readonly amount: number
    readonly fromAccount?: string
  }): string
  /** Deliver every webhook now due, each `attempts` times. */
  flush(engine: Engine, now?: number): Promise<readonly IngestionResult[]>
  /**
   * Deliver one queued webhook by its event id, latency ignored — the demo
   * driver playing the provider by hand. `null` when no such event waits.
   */
  deliver(
    engine: Engine,
    eventId: string,
  ): Promise<readonly IngestionResult[] | null>
  /** The undelivered webhooks, oldest first — the dev console's world view. */
  readonly outbox: readonly OutboxEntry[]
  /** How many deliveries are waiting. */
  readonly pending: number
  /**
   * The most recent deliveries, for assertions about provider retries. Only
   * the last few hundred are kept: with the auto-delivery timer running, an
   * unbounded log would grow for the life of the process.
   */
  readonly delivered: readonly IngestionResult[]
  /** Drive `flush` on a timer, as a deployment would. */
  start(engine: Engine, intervalMs?: number): void
  stop(): void
  reset(): void
}

/**
 * Build the three providers over one delivery queue.
 *
 * The identifiers they hand out are the *only* thing that ties an eventual
 * webhook to a case: nothing in the payloads mentions a case id, because no
 * real provider knows one.
 */
export const createMockServices = (
  options: MockServiceOptions = {},
): MockServices => {
  const latencyMs = options.latencyMs ?? 0
  const attempts = Math.max(1, options.attempts ?? 3)
  const nextId = options.idFactory ?? (() => randomUUID().slice(0, 12))

  let queue: QueuedDelivery[] = []
  // The retention rule for the delivered log: keep the most recent entries
  // up to this many, drop the oldest beyond it.
  const DELIVERED_LIMIT = 300
  const delivered: IngestionResult[] = []
  let timer: ReturnType<typeof setInterval> | null = null

  const enqueue = (event: ExternalEvent): void => {
    queue.push({ event, dueAt: Date.now() + latencyMs })
  }

  /** One webhook, delivered `attempts` times — providers retry. */
  const deliverItem = async (
    engine: Engine,
    item: QueuedDelivery,
  ): Promise<IngestionResult[]> => {
    const results: IngestionResult[] = []
    // Provider retries: the identical delivery, more than once. Exactly one
    // of them should become an Execution.
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await engine.ingest(item.event)
      results.push(result)
      delivered.push(result)
      if (delivered.length > DELIVERED_LIMIT)
        delivered.splice(0, delivered.length - DELIVERED_LIMIT)
    }
    return results
  }

  /** Deliver everything due. */
  const drain = async (
    engine: Engine,
    now: number,
  ): Promise<readonly IngestionResult[]> => {
    const due = queue.filter((item) => item.dueAt <= now)
    queue = queue.filter((item) => item.dueAt > now)
    const results: IngestionResult[] = []
    for (const item of due) results.push(...(await deliverItem(engine, item)))
    return results
  }

  return {
    startVerification: (input) => {
      const checkId = `chk_${nextId()}`
      const hits = input.hits ?? []
      enqueue({
        ...PROVIDER_EVENTS.checkCompleted,
        externalId: checkId,
        eventId: `evt_${nextId()}`,
        payload: {
          status: hits.length === 0 ? 'clear' : 'review',
          hits,
          // When the provider completed the check. Fixed so assertions on
          // the recorded `flaggedAt` are exact.
          completedAt: '2026-08-05T10:00:00.000Z',
        },
      })
      return checkId
    },

    sendEnvelope: () => {
      const envelopeId = `env_${nextId()}`
      enqueue({
        ...PROVIDER_EVENTS.envelopeCompleted,
        externalId: envelopeId,
        eventId: `evt_${nextId()}`,
        payload: {
          signedAt: '2026-08-05T11:00:00.000Z',
        },
      })
      return envelopeId
    },

    applyForEscrowAccount: () => {
      const applicationId = `app_${nextId()}`
      enqueue({
        ...PROVIDER_EVENTS.accountOpened,
        externalId: applicationId,
        eventId: `evt_${nextId()}`,
        payload: {
          accountId: `acct_${nextId()}`,
          openedAt: '2026-08-05T09:00:00.000Z',
        },
      })
      return applicationId
    },

    announceWire: (input) => {
      const wireId = `wire_${nextId()}`
      enqueue({
        ...PROVIDER_EVENTS.wireReceived,
        // A wire notification quotes the *account*, not the wire: the escrow
        // company knows which account was credited and nothing about the
        // purchase.
        externalId: input.applicationId,
        // One correlation, two kinds of news: the account's correlation
        // defaults to `record-escrow-account`, so a wire has to name its own
        // step. Events overriding the correlation's default is exactly the
        // case this exercises.
        step: 'record-wire',
        eventId: `evt_${nextId()}`,
        payload: {
          wireId,
          buyerId: input.buyerId,
          amount: input.amount,
          fromAccount: input.fromAccount ?? registeredAccountOf(input.buyerId),
          receivedAt: '2026-08-05T12:00:00.000Z',
        },
      })
      return wireId
    },

    flush: (engine, now = Date.now()) => drain(engine, now),

    deliver: async (engine, eventId) => {
      const item = queue.find((entry) => entry.event.eventId === eventId)
      if (item === undefined) return null
      queue = queue.filter((entry) => entry !== item)
      return deliverItem(engine, item)
    },

    get outbox() {
      return queue.map(({ event }) => ({
        eventId: event.eventId ?? event.externalId,
        system: event.system,
        externalId: event.externalId,
        type: event.type,
        ...(event.step !== undefined && { step: event.step }),
      }))
    },

    get pending() {
      return queue.length
    },
    get delivered() {
      return delivered
    },

    start: (engine, intervalMs = 50) => {
      if (timer !== null) return
      timer = setInterval(() => {
        void drain(engine, Date.now()).catch(() => undefined)
      }, intervalMs)
      timer.unref?.()
    },
    stop: () => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
    reset: () => {
      queue = []
      delivered.length = 0
    },
  }
}

/**
 * The console's data layer: plain fetch, no query library. Every contract
 * request carries the persona as two client-set headers; /dev routes take
 * no actor.
 *
 * The contract's wire shapes are imported from `@affordance/contract` — the
 * one declaration of the wire, dependency-free, so this project stays
 * standalone in the sense that matters (no engine, no Node) without
 * hand-copying types that then drift. Only the `/dev` console routes'
 * shapes are declared here, because only this console and its host speak
 * them.
 */

import type {
  AffordanceEntry,
  AffordancePayload,
  JournalEntryPayload,
  RefusalCode,
} from '@affordance/contract'

import { ACTOR_HEADERS } from './actor-headers.js'

export type {
  AffordanceEntry,
  AffordancePayload,
  BlockedEntry,
  ConditionPayload as UnmetCondition,
  JournalEntryPayload as JournalEntry,
} from '@affordance/contract'

export type Persona = { id: string; roles: string }

/**
 * One case as both `/dev` case routes send it: the list rows of
 * `/dev/cases` and the single read of `/dev/cases/:id` carry the same
 * seven fields, state included.
 */
export type CaseHandle = {
  id: string
  caseTypeName: string
  seq: number
  /** Raw case state — read only by the leak module, which derives display labels from it. */
  state: unknown
  endedAt: string | null
  createdAt: string
  updatedAt: string
}

/** A list row of `/dev/cases` — the same shape, named for its call sites. */
export type CaseSummary = CaseHandle

/** How this console reads a wire input schema, when the host serialized one. */
export type JsonSchema = {
  type?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  enum?: unknown[]
  default?: unknown
}

/** One undelivered provider webhook, correlated to its case when known. */
export type WorldEvent = {
  eventId: string
  system: string
  externalId: string
  type: string
  step?: string
  caseId?: string
  scopeKey?: string
}

/** A wire the escrow company could announce — computed server-side, next to the guard it must agree with. */
export type WireLever = { buyerId: string; name: string; amount: number }

/** What the outside world owes: pending webhooks and the selected case's wire levers. */
export type WorldState = { events: WorldEvent[]; levers: WireLever[] }

/**
 * A deliberate no, rendered inline on the card it came from — code and all.
 * The code is one of the contract's closed refusal codes, or a code of the
 * host's own (the case-creation gate answers `not-permitted`), which is why
 * plain strings stay assignable without losing completion on the known set.
 */
export type Refusal = {
  status: number
  code: RefusalCode | (string & {})
  message: string
  issues?: unknown[]
}

/** The contract's "a guard said no" code — checked by name at the click site. */
export const STEP_NOT_AVAILABLE = 'step-not-available' satisfies RefusalCode

/** How a contract call ended: it worked, something said no, or nothing answered at all. */
export type CallOutcome =
  | { kind: 'ok' }
  | { kind: 'refusal'; refusal: Refusal }
  | { kind: 'crash'; message: string }

const personaHeaders = (persona: Persona) => ({
  [ACTOR_HEADERS.id]: persona.id || 'anonymous',
  [ACTOR_HEADERS.roles]: persona.roles || '',
})

async function getJson(path: string, headers?: Record<string, string>) {
  const response = await fetch(path, { headers })
  return { status: response.status, body: await response.json() }
}

export async function fetchCases(): Promise<CaseSummary[]> {
  const { status, body } = await getJson('/dev/cases')
  if (status !== 200) throw new Error(`GET /dev/cases → ${status}`)
  return (body as { cases: CaseSummary[] }).cases
}

/** The three reads behind everything on the page, refetched together. */
export async function fetchCaseReads(caseId: string, persona: Persona) {
  const [aff, handle, journal] = await Promise.all([
    getJson(`/api/cases/${caseId}/affordances`, personaHeaders(persona)),
    getJson(`/dev/cases/${caseId}`),
    getJson(`/api/cases/${caseId}/journal`, personaHeaders(persona)),
  ])
  if (aff.status !== 200 || handle.status !== 200 || journal.status !== 200) {
    throw new Error(
      `reading case ${caseId} failed (${aff.status}/${handle.status}/${journal.status})`,
    )
  }
  return {
    aff: aff.body as AffordancePayload,
    handle: handle.body as CaseHandle,
    journal: (journal.body as { entries: JournalEntryPayload[] }).entries,
  }
}

export async function fetchWorld(caseId?: string): Promise<WorldState> {
  const path =
    caseId === undefined
      ? '/dev/world'
      : `/dev/world?caseId=${encodeURIComponent(caseId)}`
  const { status, body } = await getJson(path)
  if (status !== 200) throw new Error(`GET /dev/world → ${status}`)
  return body as WorldState
}

/**
 * One persona's affordances, `null` when the read fails — called once per
 * persona to fill the cast strip's lanes. Lives here so this file stays
 * the only one that knows the wire (paths, persona headers).
 */
export async function fetchAffordances(
  caseId: string,
  persona: Persona,
): Promise<AffordancePayload | null> {
  const { status, body } = await getJson(
    `/api/cases/${caseId}/affordances`,
    personaHeaders(persona),
  )
  return status === 200 ? (body as AffordancePayload) : null
}

/** Deliver exactly one queued provider webhook, by event id. */
export async function deliverEvent(eventId: string): Promise<void> {
  const response = await fetch('/dev/deliver', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ eventId }),
  })
  if (response.status !== 200)
    throw new Error(`POST /dev/deliver → ${response.status}`)
}

/** Delete a case outright — a dev-console maintenance route, not a contract call. */
export async function deleteCase(caseId: string): Promise<void> {
  const response = await fetch(`/dev/cases/${caseId}`, { method: 'DELETE' })
  if (response.status !== 200)
    throw new Error(`DELETE /dev/cases/${caseId} → ${response.status}`)
}

/** The escrow company announces a wire, unprompted — it lands in the outbox. */
export async function announceWire(
  caseId: string,
  buyerId: string,
  amount: number,
): Promise<void> {
  const response = await fetch('/dev/announce-wire', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ caseId, buyerId, amount }),
  })
  if (response.status !== 200) {
    const body = (await response.json().catch(() => ({}))) as {
      message?: string
    }
    throw new Error(
      body.message || `POST /dev/announce-wire → ${response.status}`,
    )
  }
}

/**
 * Classify a failed response — the one place that decides whether it was a
 * refusal or a crash. A refusal is a body that declares itself one: it
 * carries the contract's `error` code (or the host's own — the
 * case-creation gate answers its own 403 the same way). Anything else —
 * hono's plain-text 500 for a rethrown bug, a dead proxy — is a crash,
 * shown as a page-level notice and never as an inline answer on the card
 * that happened to be clicked.
 */
const readFailure = async (response: Response): Promise<CallOutcome> => {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown
    message?: unknown
    issues?: unknown[]
  } | null
  if (
    body !== null &&
    typeof body.error === 'string' &&
    typeof body.message === 'string'
  ) {
    return {
      kind: 'refusal',
      refusal: {
        status: response.status,
        code: body.error,
        message: body.message,
        ...(body.issues !== undefined && { issues: body.issues }),
      },
    }
  }
  return {
    kind: 'crash',
    message: `the server did not answer (${response.status}) — see its log`,
  }
}

/** The human-readable message of whatever was thrown — Error or not. */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const asCrash = (error: unknown): CallOutcome => ({
  kind: 'crash',
  message: errorMessage(error),
})

/**
 * Execute one affordance via the entry's own links.execute — the console
 * never builds a step URL. Never throws: the outcome says whether it
 * worked, was refused (content for the originating card), or crashed
 * (content for the page, never the card).
 */
export async function executeAffordance(
  entry: AffordanceEntry,
  input: unknown,
  persona: Persona,
): Promise<CallOutcome> {
  try {
    const response = await fetch(entry.links.execute.href, {
      method: entry.links.execute.method,
      headers: {
        'content-type': 'application/json',
        ...personaHeaders(persona),
      },
      body: JSON.stringify({
        ...(entry.scopeKey !== undefined && { scopeKey: entry.scopeKey }),
        ...(input !== undefined && { input }),
      }),
    })
    if (response.status === 201) return { kind: 'ok' }
    return await readFailure(response)
  } catch (error) {
    return asCrash(error)
  }
}

export async function createCase(
  caseType: string,
  state: unknown,
  persona: Persona,
): Promise<{ kind: 'created'; caseId: string } | CallOutcome> {
  try {
    const response = await fetch('/api/cases', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...personaHeaders(persona),
      },
      body: JSON.stringify({ caseType, state }),
    })
    if (response.status === 201) {
      const body = (await response.json()) as { case: { id: string } }
      return { kind: 'created', caseId: body.case.id }
    }
    return await readFailure(response)
  } catch (error) {
    return asCrash(error)
  }
}

/**
 * THE SANCTIONED CASE-TYPE LEAK MODULE — the only place that may assume a
 * case type exists (together with `house-purchase-tables.ts`, its pure half,
 * split out so the server-side suite can pin every table key against the
 * real definitions). Everything else in this app renders contract-driven,
 * for any case type: delete this module's contents and the console still
 * works — forms fall back to the schema's own defaults, the buyer dropdown
 * simply doesn't render. Step labels are not a leak: every affordance and
 * blocked entry carries its definition's `title` on the wire.
 *
 * Leak #1: actor hints, done-detection, and the buyer-roster extractor.
 * Leak #2: the newcomer intro page's content (in the tables module).
 */

import type { Persona } from '@/lib/api'
import type { ActorKind } from './house-purchase-tables'

export * from './house-purchase-tables'

/* Leak #1 — the buyer roster, read from case state so the
 * cast strip can offer real buyers by name. Any other case type yields
 * an empty roster — the strip degrades to the preset personas; any other
 * actor still reaches the contract itself via the two headers. */
export type BuyerRosterEntry = { id: string; name: string }

export const buyerRoster = (state: unknown): BuyerRosterEntry[] => {
  const buyers = (state as { buyers?: unknown } | null | undefined)?.buyers
  return Array.isArray(buyers)
    ? buyers
        .filter((buyer): buyer is { id: string; name?: string } =>
          Boolean(buyer?.id),
        )
        .map((buyer) => ({ id: buyer.id, name: buyer.name ?? buyer.id }))
    : []
}

/* Leak #1 continued — the case list label: a house purchase is known by
 * its address. Any other case type returns null and the list falls back
 * to the case type's name. */
export const caseLabel = (row: {
  caseTypeName: string
  state?: unknown
}): string | null => {
  if (row.caseTypeName !== 'house-purchase') return null
  const address = (
    row.state as { purchase?: { address?: unknown } } | null | undefined
  )?.purchase?.address
  return typeof address === 'string' ? address : null
}

/* Leak #1 continued — scope keys by name. Buyer ids are server-minted
 * uuids, so wherever the case state knows a name for a scope key, the
 * interface shows the name; keys the roster can't resolve (wires, other
 * cases) stay raw. */
export const scopeLabel = (state: unknown, scopeKey: string): string =>
  buyerRoster(state).find((buyer) => buyer.id === scopeKey)?.name ?? scopeKey

/* Leak #1 continued — the persona roster: who gets a lane in the cast
 * strip, by name and in order. The two presets are house-purchase's stock
 * personas and deliberately render for ANY case type — the universal
 * fallback: a foreign case still shows what those roles could do (usually
 * nothing) and the user is never stranded without a persona switch. The
 * case's own buyers follow, in state order. That is the whole degradation
 * contract; any other actor still reaches the contract itself via the two
 * headers. */
export type PersonaRosterEntry = {
  key: string
  name: string
  kind: 'preset' | 'buyer'
  /** Which actor palette this lane belongs to (pills, section tints). */
  actorKind: ActorKind
  persona: Persona
}

/**
 * The stock organizer — the console's observer persona: the main read asks
 * as them, and creating a case runs as them (the one role the server lets
 * create).
 */
export const ORGANIZER: Persona = { id: 'org-1', roles: 'organizer' }

export const personaRoster = (state: unknown): PersonaRosterEntry[] => [
  {
    key: 'organizer',
    name: 'Organizer',
    kind: 'preset',
    actorKind: 'organizer',
    persona: ORGANIZER,
  },
  {
    key: 'escrow',
    name: 'Escrow officer',
    kind: 'preset',
    actorKind: 'escrow-officer',
    persona: { id: 'esc-1', roles: 'escrow-officer' },
  },
  ...buyerRoster(state).map((buyer) => ({
    key: `buyer:${buyer.id}`,
    name: buyer.name,
    kind: 'buyer' as const,
    actorKind: 'buyer' as const,
    persona: { id: buyer.id, roles: 'buyer' },
  })),
]

/* Wire levers — which buyers' money the escrow company could announce —
 * arrive on `/dev/world?caseId=`, computed server-side next to the
 * definitions with the same counting rule the close guard's `funded`
 * condition uses. The console renders them and never restates the rule. */

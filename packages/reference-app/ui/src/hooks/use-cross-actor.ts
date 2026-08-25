/**
 * Per-actor affordances for the cast strip: what *each* persona could do
 * right now, not just the acting one — "affordances are computed per
 * actor" made visible instead of imagined.
 *
 * Data shape: one `fetchAffordances` per persona — crossing the same
 * `lib/api` seam as every other read (a seam: the one swap point that
 * knows the wire), so this hook knows no paths and no headers. The
 * whole fan-out for four personas costs ~10ms, and it re-runs whenever the
 * main read's `asOf` moves — every mutation produces a fresh one.
 *
 * Which actors get lanes is not this hook's call: `personaRoster` in the
 * leak module — the one file allowed to know this case type — decides
 * (presets + the case's buyers), and this hook fetches for whatever it
 * returns. Machine actors (integration) get no
 * lane — the world panel already carries what the outside world owes, and
 * `permits` hides their steps from every human persona anyway.
 */

import { useEffect, useRef, useState } from 'react'
import {
  type AffordancePayload,
  type BlockedEntry,
  fetchAffordances,
} from '@/lib/api'
import { cardKey } from '@/lib/card-key'
import { type PersonaRosterEntry, personaRoster } from '@/lib/house-purchase'

export type ActorLane = PersonaRosterEntry & {
  /** null = the read failed; render the lane as unreadable, not empty. */
  aff: AffordancePayload | null
}

/**
 * The union of every lane's blocked entries, one row per step·scope — what
 * the waiting list renders. A pure function of the lanes, so it is
 * testable without rendering anything.
 */
export const blockedUnion = (lanes: readonly ActorLane[]): BlockedEntry[] => {
  const seen = new Map<string, BlockedEntry>()
  for (const lane of lanes)
    for (const entry of lane.aff?.blocked ?? []) {
      const key = cardKey(entry)
      if (!seen.has(key)) seen.set(key, entry)
    }
  return [...seen.values()]
}

export function useCrossActor(
  caseId: string | null,
  state: unknown,
  asOf: string | undefined,
) {
  const [lanes, setLanes] = useState<ActorLane[]>([])
  const seq = useRef(0)

  const roster = personaRoster(state)
  const rosterKey = roster.map((entry) => entry.key).join(',')

  // biome-ignore lint/correctness/useExhaustiveDependencies: rosterKey stands in for roster, which is a fresh array every render
  useEffect(() => {
    const mySeq = ++seq.current
    if (caseId === null) {
      setLanes([])
      return
    }
    void Promise.all(
      roster.map(async (entry) => ({
        ...entry,
        aff: await fetchAffordances(caseId, entry.persona),
      })),
    ).then((next) => {
      if (mySeq === seq.current) setLanes(next)
    })
  }, [caseId, asOf, rosterKey])

  return lanes
}

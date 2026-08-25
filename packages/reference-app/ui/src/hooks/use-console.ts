import { useEffect, useRef, useState } from 'react'
import {
  type AffordanceEntry,
  type AffordancePayload,
  announceWire,
  type CaseHandle,
  type CaseSummary,
  createCase,
  deleteCase,
  deliverEvent,
  errorMessage,
  executeAffordance,
  fetchCaseReads,
  fetchCases,
  fetchWorld,
  type JournalEntry,
  type Persona,
  STEP_NOT_AVAILABLE,
  type WorldState,
} from '@/lib/api'
import { cardKey } from '@/lib/card-key'

/** One inline error, rendered on the card it belongs to. */
export type CardError = {
  key: string
  message: string
  code?: string
  issues?: unknown[]
}

/** The key create-form errors report under (creating is not an affordance). */
export const CREATE_KEY = '__create'

type CaseReads = {
  aff: AffordancePayload
  handle: CaseHandle
  journal: JournalEntry[]
}

/**
 * The console's entire client-side state: the selected case, the last
 * fetched reads, one inline error, one page-level notice.
 *
 * There is no acting persona here. The lane a card sits in decides who
 * acts (`execute` takes the persona), and `observer` is who the main read
 * asks as — the console's widest human view, also the persona case
 * creation runs as.
 *
 * Refresh model: after any mutation — execute, create — and on any case
 * switch, refetch everything (affordances, /dev state, journal) and
 * re-render. No polling, no partial updates. A monotonic sequence number
 * drops reads that lost the race to a newer trigger.
 */
export function useConsole(observer: Persona) {
  const [caseId, setCaseId] = useState<string | null>(null)
  const [cases, setCases] = useState<CaseSummary[]>([])
  const [reads, setReads] = useState<CaseReads | null>(null)
  const [world, setWorld] = useState<WorldState | null>(null)
  const [cardError, setCardError] = useState<CardError | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const current = useRef({ caseId })
  current.current = { caseId }
  const readSeq = useRef(0)

  async function loadReads(nextCaseId: string | null) {
    const seq = ++readSeq.current
    setNotice(null)
    // The world is global — pending webhooks may belong to any case — so it
    // refreshes alongside the case reads, and even with no case selected.
    // The selected case rides along so the server can compute its levers.
    // A failure quietly hides the section rather than raising the notice.
    void fetchWorld(nextCaseId ?? undefined)
      .catch(() => null)
      .then((next) => {
        if (seq === readSeq.current) setWorld(next)
      })
    if (nextCaseId === null) {
      setReads(null)
      return
    }
    try {
      const next = await fetchCaseReads(nextCaseId, observer)
      if (seq === readSeq.current) setReads(next)
    } catch (error) {
      if (seq === readSeq.current) {
        setReads(null)
        setNotice(errorMessage(error))
      }
    }
  }

  /** Re-list cases, keep the selection when it still exists (else newest), reload reads. */
  async function reloadAll(preferredCaseId?: string | null) {
    const wanted =
      preferredCaseId !== undefined ? preferredCaseId : current.current.caseId
    try {
      const list = await fetchCases()
      const nextId = list.some((row) => row.id === wanted)
        ? wanted
        : (list[0]?.id ?? null)
      setCases(list)
      setCaseId(nextId)
      await loadReads(nextId)
    } catch (error) {
      setNotice(errorMessage(error))
    }
  }

  /**
   * Run one console action; a throw becomes the shared notice and `false`,
   * so each action reads as its own two lines instead of five of ceremony.
   */
  const tryOrNotice = async (fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn()
      return true
    } catch (error) {
      setNotice(errorMessage(error))
      return false
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only load
  useEffect(() => {
    void reloadAll()
  }, [])

  const selectCase = (next: string | null) => {
    setCaseId(next)
    setCardError(null)
    void loadReads(next)
  }

  /**
   * Execute as the given persona — the lane the card sits in decides who
   * acts. A refusal is content for the card; a crash is content for the
   * page — the distinction the contract draws is kept all the way to the
   * pixel. `step-not-available` means the step stopped being available
   * between the render and the click, and its payload carries an
   * affordances link for exactly one reason: the list this card came from
   * is stale, so refetch it under the refusal.
   */
  const execute = async (
    entry: AffordanceEntry,
    input: unknown,
    asPersona: Persona,
  ) => {
    const outcome = await executeAffordance(entry, input, asPersona)
    if (outcome.kind === 'crash') {
      setNotice(outcome.message)
      return
    }
    if (outcome.kind === 'refusal') {
      const { code, message, issues } = outcome.refusal
      setCardError({ key: cardKey(entry), message, code, issues })
      if (code === STEP_NOT_AVAILABLE) await loadReads(current.current.caseId)
      return
    }
    setCardError(null)
    await reloadAll()
  }

  /** Returns true when the case was created (the form closes itself on that). */
  const create = async (caseType: string, state: unknown): Promise<boolean> => {
    const result = await createCase(caseType, state, observer)
    if (result.kind === 'created') {
      setCardError(null)
      await reloadAll(result.caseId)
      return true
    }
    if (result.kind === 'crash') {
      setNotice(result.message)
      return false
    }
    if (result.kind === 'refusal') {
      const { code, message, issues } = result.refusal
      setCardError({ key: CREATE_KEY, message, code, issues })
    }
    return false
  }

  /** Delete the selected case; the newest remaining one takes its place. */
  const removeCase = async () => {
    const target = current.current.caseId
    if (target === null) return
    if (!(await tryOrNotice(() => deleteCase(target)))) return
    setCardError(null)
    await reloadAll(null)
  }

  /** The escrow company announces a wire; it lands in the world's outbox. */
  const announce = async (buyerId: string, amount: number) => {
    const target = current.current.caseId
    if (target === null) return
    if (!(await tryOrNotice(() => announceWire(target, buyerId, amount))))
      return
    await reloadAll()
  }

  /** Play one provider webhook, exactly as it would arrive in production. */
  const deliver = async (eventId: string) => {
    if (!(await tryOrNotice(() => deliverEvent(eventId)))) return
    setCardError(null)
    await reloadAll()
  }

  /** Client-side input problems (unparsable JSON) report through the same slot. */
  const reportCardError = (key: string, message: string) =>
    setCardError({ key, message })

  return {
    caseId,
    cases,
    aff: reads?.aff ?? null,
    handle: reads?.handle ?? null,
    journal: reads?.journal ?? null,
    world,
    cardError,
    notice,
    selectCase,
    execute,
    create,
    removeCase,
    announce,
    deliver,
    reportCardError,
  }
}

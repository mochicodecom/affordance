/** Focused lifecycle fixture with a virtual clock. The full non-SQL adapter
 * and shared contract tests live in test/storage/. */

import type {
  HeldClaim,
  JournalEntry,
  JournalEntryInput,
  LifecyclePort,
  LifecycleTx,
} from '../../src/execution/index.js'
import { projectEntry } from '../../src/execution/index.js'
import { CaseNotFoundError } from '../../src/store/index.js'

/** A case row as the fake observes it — a snapshot, not live storage. */
export interface MemoryCaseRow {
  readonly caseTypeName: string
  readonly state: unknown
  readonly seq: number
  readonly endedAt: Date | null
}

interface CaseCell {
  caseTypeName: string
  state: unknown
  seq: number
  endedAt: Date | null
}

interface ClaimCell {
  executionId: string
  step: string
  scopeKey: string | null
  attempt: number
  expiresAtMs: number
}

/** A pre-existing claim, as a test seeds it (another process's lease). */
export interface SeededClaim {
  readonly executionId: string
  readonly step: string
  readonly scopeKey?: string | null
  readonly attempt?: number
  readonly expiresAt: Date
}

export interface MemoryStore {
  readonly port: LifecyclePort
  /** The journal so far — observation only. */
  readonly journal: readonly JournalEntry[]
  /** Create (or reset) a case row, as inserting one would. */
  readonly seed: (caseId: string, caseTypeName: string, state: unknown) => void
  /** Place another process's claim on a case — the fixture a busy/takeover test starts from. */
  readonly seedClaim: (caseId: string, claim: SeededClaim) => void
  /** The case row as it stands, or `undefined` — observation only. */
  readonly caseRow: (caseId: string) => MemoryCaseRow | undefined
  /** The claim on a case through the port's own projection, `null` when nobody holds it. */
  readonly claim: (caseId: string) => HeldClaim | null
}

export const memoryStore = (now: () => Date): MemoryStore => {
  const cases = new Map<string, CaseCell>()
  const claims = new Map<string, ClaimCell>()
  const journal: JournalEntry[] = []
  let ordinal = 0

  const append = async (input: JournalEntryInput): Promise<JournalEntry> => {
    ordinal += 1
    const entry: JournalEntry = {
      ...projectEntry(input),
      ordinal,
      id: `jrnl:${ordinal}`,
      recordedAt: now().toISOString(),
    }
    journal.push(entry)
    return entry
  }

  const heldClaim = (caseId: string): HeldClaim | null => {
    const row = claims.get(caseId)
    if (!row) return null
    return {
      executionId: row.executionId,
      step: row.step,
      scopeKey: row.scopeKey,
      attempt: row.attempt,
      expiresAt: new Date(row.expiresAtMs).toISOString(),
      expired: row.expiresAtMs <= now().getTime(),
    }
  }

  const txFor = (caseId: string): LifecycleTx => ({
    loadCase: async () => {
      const row = cases.get(caseId)
      if (!row) throw new CaseNotFoundError(caseId)
      const handle = {
        id: caseId,
        caseTypeName: row.caseTypeName,
        state: row.state,
        seq: row.seq,
        endedAt: row.endedAt,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }
      return handle
    },
    currentClaim: async () => heldClaim(caseId),
    insertClaim: async (executionId, step, scopeKey, ttlMs) => {
      claims.set(caseId, {
        executionId,
        step,
        scopeKey,
        attempt: 1,
        expiresAtMs: now().getTime() + ttlMs,
      })
      return { claimedAt: now().toISOString() }
    },
    deleteClaim: async (executionId) => {
      if (claims.get(caseId)?.executionId === executionId) claims.delete(caseId)
    },
    appendEntry: append,
    updateCaseState: async (state, dormancy) => {
      const row = cases.get(caseId)
      if (!row) throw new CaseNotFoundError(caseId)
      row.state = state
      row.seq += 1
      if (dormancy === 'ended') row.endedAt = now()
      if (dormancy === 'reopened') row.endedAt = null
      return {
        seq: row.seq,
        endedAt: row.endedAt === null ? null : row.endedAt.toISOString(),
      }
    },
    applyEffects: async (effects) => {
      for (const effect of effects) {
        if (effect.kind === 'write') await effect.write(undefined)
        else
          throw new Error('Use the full memory adapter for correlation tests')
      }
    },
  })

  const port: LifecyclePort = {
    withCase: async (caseId, fn) => {
      if (!cases.has(caseId)) throw new CaseNotFoundError(caseId)
      // Rollback by snapshot: the pg adapter's transaction is what lets a
      // takeover's `expired` entry vanish when the guard then refuses.
      const before = {
        cases: new Map([...cases].map(([key, row]) => [key, { ...row }])),
        claims: new Map([...claims].map(([key, row]) => [key, { ...row }])),
        journalLength: journal.length,
        ordinal,
      }
      try {
        return await fn(txFor(caseId))
      } catch (error) {
        cases.clear()
        before.cases.forEach((row, key) => {
          cases.set(key, row)
        })
        claims.clear()
        before.claims.forEach((row, key) => {
          claims.set(key, row)
        })
        journal.length = before.journalLength
        ordinal = before.ordinal
        throw error
      }
    },
    appendEntry: append,
    heartbeat: async (caseId, executionId, ttlMs) => {
      const row = claims.get(caseId)
      if (row?.executionId === executionId)
        row.expiresAtMs = now().getTime() + ttlMs
    },
    bumpAttempt: async (caseId, executionId, attempt) => {
      const row = claims.get(caseId)
      if (row?.executionId === executionId) row.attempt = attempt
    },
    releaseClaim: async (caseId, executionId) => {
      if (claims.get(caseId)?.executionId === executionId) claims.delete(caseId)
    },
  }

  return {
    port,
    journal,
    seed: (caseId, caseTypeName, state) =>
      cases.set(caseId, { caseTypeName, state, seq: 0, endedAt: null }),
    seedClaim: (caseId, claim) =>
      claims.set(caseId, {
        executionId: claim.executionId,
        step: claim.step,
        scopeKey: claim.scopeKey ?? null,
        attempt: claim.attempt ?? 1,
        expiresAtMs: claim.expiresAt.getTime(),
      }),
    caseRow: (caseId) => {
      const row = cases.get(caseId)
      return row === undefined ? undefined : { ...row }
    },
    claim: heldClaim,
  }
}

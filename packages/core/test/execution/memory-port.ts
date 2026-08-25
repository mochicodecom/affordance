/**
 * The in-memory lifecycle adapter — the port's second adapter, which is what
 * makes the seam real.
 *
 * Honest about the two semantics the lifecycle actually leans on:
 * transactionality (a `withCaseLock` body that throws rolls its writes back
 * — the takeover-then-guard-refusal case depends on it) and lease expiry
 * against an injectable clock. Locking itself is vacuous: these tests are
 * single-threaded, and "exactly one of N concurrent claimants" stays proven
 * against the real row lock in `execute.pg.test.ts`.
 *
 * The fake's interface is deliberately no wider than seeding and observing.
 * Its maps are private: everything that *changes* mid-run goes through the
 * port's own verbs (the pg suites' equivalent is SQL fixtures before the
 * run, never writes around the engine during one), so a test cannot quietly
 * depend on state the port could never produce.
 */

import type {
  HeldClaim,
  JournalEntry,
  JournalEntryInput,
  LifecyclePort,
  LifecycleTx,
} from '../../src/execution/index.js'
import { projectEntry } from '../../src/execution/index.js'
import type { CaseTypeLookup, Transaction } from '../../src/store/index.js'
import { CaseNotFoundError, validateCaseState } from '../../src/store/index.js'

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

/** App `ctx.onCommit` writes receive a transaction handle; in memory it is inert. */
const inertTx = { query: async () => ({ rows: [] }) } as unknown as Transaction

export const memoryStore = (
  now: () => Date,
  caseTypeFor: CaseTypeLookup,
): MemoryStore => {
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
      const definition = caseTypeFor(row.caseTypeName)
      const handle = {
        id: caseId,
        caseTypeName: row.caseTypeName,
        state: row.state,
        seq: row.seq,
        endedAt: row.endedAt,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }
      // The real validation, not a stub of it — the resolved triple is the
      // port's contract, and both adapters go through the same load,
      // resolve, validate sequence.
      return {
        definition,
        handle,
        state: await validateCaseState(definition, row.state),
      }
    },
    lockCase: async () => {
      if (!cases.has(caseId)) throw new CaseNotFoundError(caseId)
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
    appWrites: async (writes) => {
      for (const write of writes) await write(inertTx)
    },
  })

  const port: LifecyclePort = {
    withCaseLock: async (caseId, fn) => {
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

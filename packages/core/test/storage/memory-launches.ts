import {
  ExecutionNotResolvableError,
  LaunchBlockedError,
  type LaunchedExecution,
  type LaunchPort,
} from '../../src/index.js'
/** Single synchronous mutation per transition models the adapter transaction. */
export const memoryLaunches = (now: () => number = Date.now): LaunchPort => {
  const records = new Map<string, LaunchedExecution>()
  const owners = new Map<string, string>()
  const get = (id: string): LaunchedExecution | null => {
    const r = records.get(id)
    if (!r) return null
    return structuredClone(
      r.status === 'running' && Date.parse(r.expiresAt) <= now()
        ? { ...r, status: 'unresolved', reason: 'expired' }
        : r,
    )
  }
  return {
    async claim(c) {
      if (owners.has(c.caseId)) throw new LaunchBlockedError(c.caseId)
      records.set(c.executionId, {
        executionId: c.executionId,
        caseId: c.caseId,
        step: c.step,
        scopeKey: c.scopeKey,
        actor: c.actor,
        status: 'unresolved',
        reason: 'startup',
        claimedAt: new Date(now()).toISOString(),
        expiresAt: new Date(now() + c.leaseMs).toISOString(),
        startedAt: null,
        completedAt: null,
        journal: null,
        resolution: null,
      })
      owners.set(c.caseId, c.executionId)
    },
    async start(id) {
      const r = records.get(id)
      if (
        r?.status !== 'unresolved' ||
        r.reason !== 'startup' ||
        r.startedAt ||
        Date.parse(r.expiresAt) <= now()
      )
        return false
      records.set(id, {
        ...r,
        status: 'running',
        reason: null,
        startedAt: new Date(now()).toISOString(),
      })
      return true
    },
    async release(id) {
      const r = records.get(id)
      if (
        r?.status === 'unresolved' &&
        r.reason === 'startup' &&
        !r.startedAt
      ) {
        records.delete(id)
        if (owners.get(r.caseId) === id) owners.delete(r.caseId)
      }
    },
    async complete(id, journal) {
      const r = get(id)
      if (r?.status !== 'running' || owners.get(r.caseId) !== id) return false
      records.set(id, {
        ...r,
        status: 'completed',
        completedAt: new Date(now()).toISOString(),
        journal,
      })
      owners.delete(r.caseId)
      return true
    },
    async fail(id, reason) {
      const r = records.get(id)
      if (r?.status === 'running')
        records.set(id, { ...r, status: 'unresolved', reason })
    },
    async get(id) {
      return get(id)
    },
    async resolve(id, actor, reason) {
      const r = get(id)
      if (r?.status !== 'unresolved') throw new ExecutionNotResolvableError(id)
      const resolved: LaunchedExecution = {
        ...r,
        status: 'resolved',
        resolution: {
          actor,
          reason,
          resolvedAt: new Date(now()).toISOString(),
        },
      }
      records.set(id, resolved)
      if (owners.get(r.caseId) === id) owners.delete(r.caseId)
      return structuredClone(resolved)
    },
  }
}

import { expect, it } from 'vitest'
import { z } from 'zod'
import {
  caseType,
  createEngine,
  isClaimedEntry,
  replayGuard,
  stepsOf,
} from '../../src/index.js'
import { memoryAdapter } from '../storage/memory.js'

const State = z.object({ count: z.number() })
const definition = caseType({
  name: 'replay',
  state: State,
  steps: [
    stepsOf(State)({
      name: 'check',
      requires: { ready: () => true },
      handler: async (s) => s,
    }),
  ],
})
const claimEntry = async () => {
  const { storage } = memoryAdapter()
  const engine = createEngine({ storage, caseTypes: [definition] })
  const created = await engine.createCase('replay', { count: 1 })
  await engine.execute(created.id, 'check', { actor: null })
  return (await engine.journal(created.id)).find(isClaimedEntry)!
}

it('evaluates the current schema output, including defaults, without modifying recorded state', async () => {
  const claim = await claimEntry()
  const Updated = State.extend({ ready: z.boolean().default(true) })
  const updated = caseType({
    name: 'replay',
    state: Updated,
    steps: [
      stepsOf(Updated)({
        name: 'check',
        requires: { ready: (s) => s.ready },
        handler: async (s) => s,
      }),
    ],
  })
  expect((await replayGuard(updated, claim)).matches).toBe(true)
  expect(claim.state).toStrictEqual({ count: 1 })
})

it('propagates a throwing validator rather than reporting it as schema rejection', async () => {
  const claim = await claimEntry()
  const bug = new Error('validator bug')
  const updated = caseType({
    name: 'replay',
    state: State.transform(() => {
      throw bug
    }),
    steps: [],
  })
  await expect(replayGuard(updated, claim)).rejects.toBe(bug)
})

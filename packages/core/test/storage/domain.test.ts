import { createBackgroundRuntime, createEngine } from '../../src/index.js'
import { domainContract } from './domain-contract.js'
import { createMemoryStorage } from './memory.js'

domainContract('memory', async (definition) => {
  const memory = createMemoryStorage()
  const binding = memory.bindCase(definition)
  const reference = definition.name
  const initial = {
    count: 0,
    buyers: [
      { id: 'a', name: 'Alice' },
      { id: 'b', name: 'Bob' },
    ],
  }
  await memory.seed(reference, initial)
  const runtime = createBackgroundRuntime()
  const engine = createEngine({
    storage: memory.storage,
    caseTypes: [binding],
    launch: { runtime, leaseMs: 60_000 },
  })
  const { id } = await engine.attachCase(definition.name, { reference })
  return {
    engine,
    storage: memory.storage,
    id,
    reference,
    externalCount: async (count) =>
      memory.seed(reference, { ...initial, count }),
    drain: () => runtime.drain(),
  }
})

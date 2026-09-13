import { createEngine } from '../../src/index.js'
import { domainContract } from './domain-contract.js'
import { createMemoryStorage } from './memory.js'

domainContract('memory', async (definition) => {
  const memory = createMemoryStorage()
  const binding = memory.bindCase(definition, (read, write) => ({
    setCount: async (count) => write({ ...read(), count }),
    rename: async (id, name) =>
      write({
        ...read(),
        buyers: read().buyers.map((b) => (b.id === id ? { ...b, name } : b)),
      }),
  }))
  const reference = definition.name
  await memory.seed(reference, {
    count: 0,
    buyers: [
      { id: 'a', name: 'Alice' },
      { id: 'b', name: 'Bob' },
    ],
  })
  const engine = createEngine({ storage: memory.storage, caseTypes: [binding] })
  const { id } = await engine.attachCase(definition.name, { reference })
  return {
    engine,
    storage: memory.storage,
    id,
    reference,
    externalCount: async (count) =>
      memory.seed(reference, {
        count,
        buyers: [
          { id: 'a', name: 'Alice' },
          { id: 'b', name: 'Bob' },
        ],
      }),
  }
})

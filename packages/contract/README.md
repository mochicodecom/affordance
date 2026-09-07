# @affordance/contract

Dependency-free wire types and constants for `affordance/v1`. Use this package
in clients that read the Affordance HTTP API without importing its engine or
Postgres dependencies. Ships ESM JavaScript and TypeScript declarations.

```bash
npm install @affordance/contract
```

```ts
import { CONTRACT, type AffordancePayload } from '@affordance/contract'

function nextSteps(payload: AffordancePayload) {
  if (payload.contract !== CONTRACT) throw new Error('Unsupported contract')
  return payload.affordances.map(({ title, step, links }) => ({
    title: title ?? step,
    execute: links.execute,
  }))
}
```

Types describe payloads; they do not validate untrusted JSON at runtime.
Follow the returned links to execute steps and request explanations.

Read the [HTTP contract](https://github.com/mochicodecom/affordance/blob/main/docs/affordance-contract.md)
or the [project introduction](https://github.com/mochicodecom/affordance/blob/main/docs/tutorial/README.md).
Licensed under [MIT](./LICENSE).

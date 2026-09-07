# @affordance/http

Expose an Affordance engine through an HTTP API. Responses describe available
steps, input, explanations, and links to the next requests. Includes a plain
request/response adapter and a Hono binding. Ships ESM JavaScript and TypeScript
declarations; requires Node 22.12+.

```bash
npm install @affordance/http @affordance/core
```

Given an engine configured with your database and case types:

```ts
import { createAffordanceApi, createHonoApp } from '@affordance/http'

const api = createAffordanceApi({ engine })
const response = await api.handle({
  method: 'GET',
  path: `/cases/${caseId}/affordances`,
  query: {},
  actor: { id: 'alice' },
})

// Alternatively, mount the Hono binding in your host application.
const app = createHonoApp({
  api,
  resolveActor: async (context) => authenticate(context.req.raw),
})
```

`engine`, `caseId`, and `authenticate` belong to the host application. The
adapter does not own identity or authentication. Clients follow execute links;
the engine rechecks guards when an execution is claimed.

Read the [HTTP contract](https://github.com/mochicodecom/affordance/blob/main/docs/affordance-contract.md),
[engine setup](https://github.com/mochicodecom/affordance/tree/main/packages/core),
and [project introduction](https://github.com/mochicodecom/affordance/blob/main/docs/tutorial/README.md).
Licensed under [MIT](./LICENSE).

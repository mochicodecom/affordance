# Codebase map

Updated: 2026-09-06

[Back to the introduction](../README.md)

Start with the [public core API](../../../packages/core/src/index.ts) and the
[reference app's steps](../../../packages/reference-app/src/steps.ts). The app
supplies case definitions and a storage adapter; the engine is an embedded
library. The HTTP adapter is optional.

| To understand… | Read… |
| --- | --- |
| State schemas, case types, and typed step authoring | [casetype.ts](../../../packages/core/src/model/casetype.ts), [step.ts](../../../packages/core/src/model/step.ts) |
| Handler context, commit writes, and correlation registration | [handler.ts](../../../packages/core/src/model/handler.ts) |
| Binding a step to one collection element | [target.ts](../../../packages/core/src/model/target.ts) |
| Named conditions and guard evaluation | [condition.ts](../../../packages/core/src/guards/condition.ts), [evaluate.ts](../../../packages/core/src/guards/evaluate.ts) |
| The API used by an application | [engine.ts](../../../packages/core/src/engine/engine.ts) |
| Computing available and blocked steps without I/O | [compute.ts](../../../packages/core/src/engine/compute.ts) |
| Claim, run, commit, retries, and takeover | [execute.ts](../../../packages/core/src/execution/execute.ts) |
| Journal records and state deltas | [journal.ts](../../../packages/core/src/execution/journal.ts), [delta.ts](../../../packages/core/src/execution/delta.ts) |
| Postgres tables and case persistence | [bootstrap.ts](../../../packages/pg/src/bootstrap.ts), [store.ts](../../../packages/pg/src/store.ts) |
| External event deduplication, correlation, and dead letters | [ingest.ts](../../../packages/core/src/ingestion/ingest.ts) |
| Public storage interfaces and adapter composition | [storage.ts](../../../packages/core/src/storage.ts), [Postgres adapter](../../../packages/pg/src/storage.ts) |
| Journaled state migrations | [migrate.ts](../../../packages/core/src/migration/migrate.ts) |
| HTTP routes, serialization, and visibility | [api.ts](../../../packages/http/src/api.ts), [contract.ts](../../../packages/http/src/contract.ts), [audience.ts](../../../packages/http/src/audience.ts) |
| Wire-format types for clients | [contract package](../../../packages/contract/src/index.ts) |

For a concrete request, follow `engine.execute` into `executeStep` and
`runLifecycle`. The lifecycle uses a
[storage interface](../../../packages/core/src/execution/port.ts) that its
[unit tests](../../../packages/core/test/execution) replace with memory. Guard
evaluation and affordance computation can also be read and tested without
Postgres. The shared [testkit](../../../packages/testkit/src/index.ts) supports
the database tests.

For the reasoning behind these boundaries, read the
[architecture](../../architecture.md).

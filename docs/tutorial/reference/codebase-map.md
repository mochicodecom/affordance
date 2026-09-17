# Codebase map

| Concern | Source |
| --- | --- |
| Case definitions and guards | [core/model](../../../packages/core/src/model/index.ts) |
| State validation and definition resolution | [resolve.ts](../../../packages/core/src/store/resolve.ts) |
| Engine reads, attachment, execution | [engine.ts](../../../packages/core/src/engine/engine.ts) |
| Launch ownership/status interface | [launch-port.ts](../../../packages/core/src/execution/launch-port.ts) |
| Domain execution and evidence | [run.ts](../../../packages/core/src/execution/run.ts) |
| Postgres bindings, reads, transactions | [storage.ts](../../../packages/pg/src/storage.ts) |
| Framework metadata schema | [bootstrap.ts](../../../packages/pg/src/bootstrap.ts) |
| Purchase domain tables and repositories | [repository.ts](../../../packages/reference-app/src/repository.ts) |
| Purchase guarded domain operations | [steps.ts](../../../packages/reference-app/src/steps.ts) |
| Application composition and external orchestration | [app.ts](../../../packages/reference-app/src/app.ts) |
| Shared memory/Postgres behavior tests | [domain-contract.ts](../../../packages/core/test/storage/domain-contract.ts) |

Background runtime and startup handshake live in `core/src/execution/background.ts` and `launch.ts`. The reference app owns its purchase transaction in `reference-app/src/operation.ts`.

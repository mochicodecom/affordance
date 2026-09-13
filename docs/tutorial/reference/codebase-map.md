# Codebase map

| Concern | Source |
| --- | --- |
| Case definitions and guards | [core/model](../../../packages/core/src/model/index.ts) |
| State validation and definition resolution | [resolve.ts](../../../packages/core/src/store/resolve.ts) |
| Engine reads, attachment, execution | [engine.ts](../../../packages/core/src/engine/engine.ts) |
| Database-independent atomic interface | [port.ts](../../../packages/core/src/execution/port.ts) |
| Domain execution and evidence | [execute.ts](../../../packages/core/src/execution/execute.ts) |
| Postgres bindings, reads, transactions | [storage.ts](../../../packages/pg/src/storage.ts) |
| Framework metadata schema | [bootstrap.ts](../../../packages/pg/src/bootstrap.ts) |
| Purchase domain tables and repositories | [repository.ts](../../../packages/reference-app/src/repository.ts) |
| Purchase guarded domain operations | [steps.ts](../../../packages/reference-app/src/steps.ts) |
| Application composition and external orchestration | [app.ts](../../../packages/reference-app/src/app.ts) |
| Shared memory/Postgres behavior tests | [domain-contract.ts](../../../packages/core/test/storage/domain-contract.ts) |

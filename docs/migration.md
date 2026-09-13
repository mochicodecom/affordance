# Domain evolution

Applications own their domain schema and data migrations. Affordance loads current
records through the application's binding and validates the assembled state
against the currently registered case definition.

Adding a guard or step changes available work immediately. Changing domain columns
requires updating the domain repository and loader together. Use the application's
normal rollout strategy when old and new deployments coexist. Schema defaults on
read do not write data back to the domain tables.

There is no document-transform `engine.migrate` API. For a business change that
needs framework execution evidence, author a domain step with explicit conditions
and repository operations. For structural table changes, use database migration
tooling. Arbitrary JSON patches are not translated into SQL updates.

Preserve stable scope keys and correlation identities when restructuring related
records. Journal snapshots remain historical evidence; they are not rewritten by
application data migrations. `replayGuard` can report that a historical snapshot
is no longer addressable by today's definition.

The domain-backed release replaces the earlier JSONB current-state store and
claim-based execution lifecycle. Existing framework schemas are unsupported.
Bootstrap refuses an incompatible schema and does not convert or drop any data.
Provision a fresh framework schema explicitly; decisions about retaining or
removing old data belong to the operator.

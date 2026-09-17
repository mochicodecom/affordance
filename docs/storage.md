# Domain storage and execution tracking

`EngineStorage` provides authoritative Case reads, journal observations, optional
launch tracking, correlations and delivery bookkeeping. There is no framework
domain transaction port. Handlers close over application services.

## Bind reads

```ts
const storage = createPgStorage({ db: { pool } })
const binding = storage.bindCase(definition, {
  load: (q, reference) => purchases(q).loadCaseState(reference),
})
const engine = createEngine({ storage, caseTypes: [binding] })
```

Postgres reads use short repeatable-read transactions. A loader must return the
current domain projection deterministically. `attachCase` validates the current
projection and stores its reference. The application may use
`storage.attachCase(tx, binding, reference)` inside its own creation transaction.
Framework transactions end before handler invocation. Applications own locks,
transactions, external calls, idempotency and final business admission.

## Optional journal observations

`journal.observe(entry, { timeoutMs })` is required for `run` and `launch`, even when a particular
handler returns void. Capability absence is detected before invocation. A handler
returning State causes one `observed` entry; void causes none. Observations use the
same validated Case schema on each side. They contain safe actor identity, Case,
Step/scope, execution ID, before-state, diff, evaluation/observation/storage times.
No raw request input is copied. The Case schema must exclude credentials and
unrelated private fields.

Core bounds the entire asynchronous evidence attempt including schema validation,
connection acquisition and persistence. It passes the remaining budget to storage.
Adapters must bound or isolate journal work so it cannot retain resources needed
for status finalization indefinitely. PostgreSQL counts acquisition against that
budget and uses a transaction-local `statement_timeout` for journal SQL. An
expired queued attempt skips the write; a blocked statement times out and rolls
back, returning its connection for status transitions. The connection's previous
timeout is restored when the transaction ends.

A write that commits near the deadline can still be observed after core reports
timeout. A partial unique index makes `observed` entries idempotent by execution
ID. A late observation never finalizes a lease or rewrites status. Successful
empty diffs still produce an entry. Missing observations never trigger replay.
Journals are not a state source or atomic-commit proof.

## Serialization contract

Snapshot serialization preserves Date, Set, bigint, null, undefined and absent
properties through `{ version: 1, json, meta? }`. Adapters encode/decode journal
state, actor and input columns with core helpers. Diffs compare serialized
documents including type metadata and are stored directly as RFC 6902 operations
with RFC 6901 paths, starting at `/json` or `/meta`. Sets compare structural
membership independently of insertion order; snapshots retain insertion order.
Unsupported evidence values produce a failed disposition after known business
success. Domain columns need not store serialization envelopes.

Journal readers retain distinct record kinds, including `observed`; folding an
observation yields `observed`, never atomic `completed`. Old reader shapes are not
used to convert prior data. Current API responses do not claim committed state,
sequence advancement or a domain commit timestamp.

## LaunchPort

| Method | Required atomic behavior |
| --- | --- |
| claim | Create execution identity and exclusive Case ownership. Running/unresolved predecessors block. |
| start | Conditional startup transition for an unexpired owned claim. |
| release | Delete only a known-safe pre-start claim with the selected identity. |
| complete | Check selected identity and unexpired running ownership; persist completion/journal disposition and release the block. |
| fail | Record a safe unresolved reason without clearing ownership or overwriting settled status. |
| get | Return durable status or null; recognize expiry without a worker. |
| resolve | Require unresolved status, record attribution/reason/time, and clear only the selected ownership. |

Postgres stores ownership in `launched_executions`: a partial unique index on
`case_id` includes running/unresolved records. Transitions lock the execution row
and check the database clock after acquiring it. Expiry does not remove index
membership. No transition executes domain code. The memory contract adapter uses
the same state machine with a controllable clock.

A lost claim/start/finalization acknowledgment is uncertain. Lookup may reconcile
it, but never invokes the handler. Expired/resolved callbacks cannot overwrite
settled or newer status. A lease does not fence domain or provider writes.

## Schema and application transactions

Bootstrap installs fresh framework schema v6. It rejects prior beta schemas;
there is no journal/lease migration, reset or domain-data conversion. Operators
explicitly reset disposable framework data before adopting this beta.

`withTransaction` is an application utility. It returns only after COMMIT and
rejects retained transaction use after its callback. Unknown acknowledgment raises
`CommitOutcomeUnknownError`; acknowledged rollback raises
`TransactionRolledBackError`. Those errors retain application meaning through
`run`. `registerCorrelation` accepts a query/transaction supplied by the app.

`deleteCase` deletes framework records, including launched status. It does not
cancel live work or remove application domain records; reconcile active handlers
before destructive administrative cleanup.

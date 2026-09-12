# Storage adapters

`@affordance/core` owns case definitions, guards, validation, execution decisions,
ingestion policy, and migration orchestration. `@affordance/pg` implements their
persistence using Postgres. Apps inject one coordinated `EngineStorage<TCommit>`.

```ts
import { createEngine } from '@affordance/core'
import { bootstrap, createPgStorage } from '@affordance/pg'

await bootstrap(pool)
const storage = createPgStorage({ db: { pool } })
const engine = createEngine({ storage, caseTypes: [purchase] })
```

## Implementing an adapter

Import `EngineStorage`, its repository interfaces, `LifecyclePort`, and
`LifecycleTx` from `@affordance/core/storage`. The same entry point exports
`projectEntry` for consistent journal defaults and `mintId` for framework IDs.

| Interface | Responsibility |
| --- | --- |
| `cases` | Create validated state, fetch raw records, list filtered pages. |
| `execution` | Give case operations exclusive access, persist claims and commit effects, maintain claim expiry and attempts. |
| `journal` | Read append-only evidence in ordinal order with filters. |
| `correlations` | Register/replace by `(system, externalId)`, preserving registration identity; look up and list mappings. |
| `deliveries` | Atomically acquire new or reopenable deliveries, settle outcomes, read dead letters. |
| `migrations` | Page through unmarked cases and inspect completed migration markers. |

Core resolves and validates records after loading them. During a claim that
validation happens inside `execution.withCase`; adapters do not receive or own
the case-type registry. Migration's temporary step definition follows the same
core path.

`withCase(caseId, callback)` must give the callback exclusive access to the case, invoke the
callback once, and atomically commit all its writes or roll them all back when
it throws. Missing cases throw `CaseNotFoundError`. An optimistic implementation
must report a serialization conflict rather than replay arbitrary callbacks.

The claim operation includes guard re-evaluation, takeover evidence, claim
creation and the claimed journal entry. The handler then runs outside that
operation. The commit operation verifies ownership and atomically writes state,
sequence, dormancy, ordered commit effects, completed evidence and claim removal.
A displaced handler must fail; an expired claim that still belongs to the same
execution may commit. Heartbeats and expiry use storage's authoritative clock.
Core's `now` supplies guard evaluation instants; stored timestamps are assigned
by the adapter.

All repositories in an adapter must participate in these guarantees. Independent
CRUD implementations alone cannot provide atomic state and correlation commits.
Provider calls remain outside storage transactions and must tolerate retries.
Delivery settlement remains separate from case execution, preserving the existing
crash/recovery behavior; this interface does not promise exactly-once external effects.

## Serialization contract

Core owns the storage format. Adapters exchange runtime values with the engine
and use `serializeValue` and `deserializeValue` from `@affordance/core/storage`
at their persistence boundary. Applications do not register codecs or change
their state schemas. Date, Set and bigint work at the document root and inside
objects, arrays and Sets. Null, explicit undefined and absent properties remain
distinct. JSON scalars, finite numbers (including negative zero), dense arrays
and plain objects are supported as well.

```ts
import { serializeValue, deserializeValue } from '@affordance/core/storage'

const document = serializeValue({ due: new Date(0), amount: 10n })
// {
//   version: 1,
//   json: { due: '1970-01-01T00:00:00.000Z', amount: '10' },
//   meta: { values: { due: ['Date'], amount: ['bigint'] }, v: 1 }
// }
const stored = JSON.stringify(document)
const restored = deserializeValue(JSON.parse(stored))
```

Persist the entire version 1 document, including metadata, for each current-state
value, claimed state snapshot, journaled actor and journaled input. Decode on all
reads: addressed loads, lists, transactional loads, journal reads and migration
candidate pages. Core schema-validates the decoded state before using it. Missing
actor/input fields in a journal append default to null; explicitly supplied
undefined is preserved. The engine records validated input on `claimed` entries;
later entries omit that evidence and their input defaults to null. The actor is
repeated on entries written by that execution, including explicit undefined.
Non-claimed entries have no snapshot and return null. A claimed snapshot whose
state is null or undefined still has its own encoded document. Use the entry kind
to distinguish absent evidence from a recorded null or undefined value.

A migration page returns each decoded state as `{ id, state }`. A row that cannot
be decoded returns `{ id, error: SerializationError }` instead. Core includes
that case in `failed` and reports progress before continuing through the remaining
rows and pages, for both real and dry-run migrations. Adapter query failures still
throw and stop the sweep; they must not be represented as individual bad rows.

Complete state is saved independently of the delta. Current-state reads never
need journal entries. `await replayGuard(definition, claimedEntry)` validates the
already decoded complete snapshot, then reevaluates today's guard against the
schema's output (including its defaults and transformations), recorded actor and
evaluation time. It supports asynchronous schemas. Schema rejection produces an
`unaddressable` replay result with the validation message and issues; a validator
that throws propagates its error. Replay does not
read, compute or apply a delta and does not run handlers.

Deltas are RFC 6902 JSON Patch operations comparing serialized documents. Paths
under `/json` describe value changes; paths under `/meta` describe runtime type
changes, such as a string becoming a Date with identical text. Store the delta
verbatim, without wrapping it in another serialization document. The completed
entry and execution result contain the same delta. Arrays compare positionally.
Diff encoding normalizes object key order: integer-index keys enumerate numerically,
then other keys lexicographically. Comparison visits existing keys before emitting
additions. This makes operation order deterministic; it does not impose an order
on application state objects.

For diffing only, Sets compare by structural membership, independent of insertion
order. Members sort lexicographically by their serialized representation,
including runtime type metadata and recursively sorted object keys and nested
Sets. Distinct object members with identical contents retain their multiplicity;
object identity itself is not journal evidence. Reordering equivalent membership
produces no delta. Complete snapshots retain Set iteration order, so guards that
inspect that order can reproduce their recorded decision. Repeated references
are copied as independent values; reference identity is not part of the contract.
Reference-equality metadata is omitted at every codec boundary, including nested
reserved-key objects. Equal bigint values keep independent type annotations.

Unsupported values throw `SerializationError` instead of being omitted, converted
to null, or replaced with a marker. These include functions, symbols and symbol
keys, cycles, non-finite numbers, invalid Dates, custom class instances, Map,
RegExp, typed arrays, sparse arrays, accessors, non-enumerable properties, and
custom properties on arrays, Dates or Sets. Objects containing the JSON keys
`__proto__`, `constructor` or `prototype` use an internal entry-array encoding
because SuperJSON reserves those names. Their keys and values round-trip as data,
and their delta paths address that encoded array. Null-prototype objects decode
as plain objects. Invalid format versions and deserialization failures also throw
`SerializationError`. An unsupported returned state fails the execution without
retry, state changes or commit effects; an invalid actor/input prevents the claim
transaction from committing. Framework encoding failures during commit are
non-retryable; a `SerializationError` raised by a handler or an application
`onCommit` callback follows the step's retry policy.

The public `SerializedValue`, `JsonValue` and `JsonObject` types are owned by core;
JSON Patch values also use `JsonValue`. Encode and decode helpers accept an optional
context string for diagnostics. Postgres supplies case IDs, journal row IDs and
column names. Wrapped encoder/decoder failures include the original cause's
message, so the journal preserves that detail along with the error name.

The format uses [SuperJSON](https://github.com/flightcontrolhq/superjson) with a
private instance and a supported-value check. SuperJSON supplies the Date, Set,
bigint and undefined codecs; core adds the reserved-key object encoding described
above. We also evaluated
[fast-json-patch](https://github.com/Starcounter-Jack/JSON-Patch); the existing
small comparer already handles JSON documents and JSON Pointer escaping, so
serializing its inputs meets the evidence contract without another dependency.
There is no patch-application API. This format is for newly written data; it has
no reader for previously persisted unwrapped state or journal values.

## Application commit contexts

The Postgres default context is its `Transaction`. Apps can expose repositories
with a stable interface instead:

```ts
import { actor, commitContext, stepsOf } from '@affordance/core'
import { createPgStorage } from '@affordance/pg'

type Repositories = {
  payments: { record(caseId: string, amount: number): Promise<void> }
}
const storage = createPgStorage({
  db: { pool },
  commitContext: tx => ({ payments: createPaymentRepository(tx) }),
})
const step = stepsOf(PurchaseState, actor<PurchaseActor>(), commitContext<Repositories>())
const recordPayment = step({
  name: 'record-payment',
  handler: async (state, ctx) => {
    ctx.onCommit(async ({ payments }) => {
      await payments.record(ctx.caseId, state.amount)
    })
    return state
  },
})
```

The factory must bind repositories to the supplied transaction. The context type
is retained through scoped handlers, steps, case definitions, and engine binding;
a handler requiring different repositories fails type checking. Unspecified
contexts default to `unknown`. `ctx.onCommit` and `ctx.correlate` share one ordered
queue, rebuilt on every attempt. A failed commit rolls back both kinds of effects.

## Case listing

`engine.listCases({ caseTypeName?, includeEnded?, limit?, cursor? })` returns
`{ cases, nextCursor }`. It lists only registered case types, newest first with a
stable tie breaker. Dormant cases are excluded by default. The page size defaults
to 100, with an integer maximum of 1000. Cursors belong to the adapter; reuse the
same filters on continuation. Pagination is a live traversal, not a frozen snapshot.

Each result is validated like `engine.case(id)`, including schema defaults.
Unreadable state fails the page; the engine does not silently drop it. Validation
uses the fetched records without per-case reloads. These reads expose state;
the host owns access control and any business-specific search or projection.
The reference console follows every page and derives its domain-specific labels
in the UI.

## Migrating existing applications

- Replace `createEngine({ db, caseTypes })` with
  `createEngine({ storage: createPgStorage({ db }), caseTypes })`.
- Import `bootstrap`, `DatabaseAccess`, `Queryable`, `PoolLike`, `Transaction`,
  `queryableOf`, and schema/table constants from `@affordance/pg`.
- Type SQL commit callbacks with `commitContext<Transaction>()`, or introduce
  transaction-bound application repositories as above.
- Pass storage to `hasMigrated(storage, caseId, name)` instead of a query handle.
- Use `engine.listCases()` for framework case listings. Demo deletion belongs to
  the Postgres administrative helper, outside the execution interface.

## Verification

Core has no Postgres dependency. An AST-based test restricts its imports and
rejects SQL persistence statements and query calls. A shared contract suite runs
against a serialized memory adapter with rollback and the Postgres adapter. It
covers listing/validation, concurrent claims, takeover, commit rollback and order,
retry discard, delivery deduplication/reopening, and migration continuation.
Postgres-specific suites cover connection mechanics and timestamp-precise paging.
The release smoke test installs the built packages outside the workspace to check
exports, declaration dependencies, and actual Postgres/HTTP execution.

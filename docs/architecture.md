# Architecture

Affordance computes work from current domain facts and actor permissions.
Applications own business persistence, transactions, provider calls, final
admission and idempotency. The framework owns validation, Guard evaluation,
invocation, optional diff observations and the launched execution protocol.

## Definitions and current state

A Case Type declares a Standard Schema and independent Steps. A Step declares
named `requires` and `permits` conditions, optional scope/input, and an async
handler. `stepsOf(schema, actor<Actor>())` preserves state, actor, scope and input
inference. Its handler returns `State | void` and receives state, actor, input,
Case/reference/execution identity and any scope binding. It receives no framework
transaction repositories, `onCommit`, `complete`, correlation or dormancy helpers.

A binding loads authoritative domain state. Neither a journal entry nor a returned
snapshot is current state. Guard evaluation is an observation; final business
admission belongs to the operation, including domain locks or accepted-command
replay checks. The reference purchase operation reevaluates admission under its
own parent lock. Other applications can preserve their existing command contracts.

## Ordinary runs

`run` validates the Case, Step/scope and input, evaluates its Guard, and captures a
copy of the validated before-state using typed serialization. It calls the handler
once without an encompassing domain transaction. A thrown error is preserved;
effects may already have committed. No success diff is fabricated on an error.

An explicit `undefined` return completes with `journal: { status: 'skipped' }`.
Otherwise the same Case schema validates the returned after-state, and the framework
computes and attempts to store an `observed` diff. An empty diff is still evidence.
This snapshot must describe established results, including database normalization.
It is never persisted as domain state, cached for subsequent reads, or replaced by
an automatic post-handler load.

Evidence validation, serialization/diff and adapter persistence are inside a
bounded asynchronous attempt, including storage acquisition. The default deadline
is 1000ms, configurable with `operations.journalTimeoutMs`. A timeout produces a
safe failed disposition; any storage write already in flight may still finish.
Adapters deduplicate by execution identity. JavaScript cannot preempt synchronous
CPU work, so validators and serializers must also avoid blocking the event loop.
A validation promise that completes after the deadline does not start a new write.
There is no diagnostic logger in the completion path that can throw or hang it.

Malformed evidence and storage failures do not turn successful handler completion
into business failure. They produce a safe `failed` journal disposition. There is
a deliberate crash gap between business commit and evidence persistence. Missing
history proves neither failure nor permission to retry. Each client call gets a
new execution identity; business idempotency remains application-owned.

## Background launch

`launch` describes what the caller awaits: handler entry, not business completion.
The host explicitly supplies a runtime and a fixed lease duration. A claim creates
durable identity and exclusive Case ownership before validation. Preparation
failures release known-safe claims. Ambiguous claims/start acknowledgments retain
ownership and expose the execution identity for inspection.

The runtime owns the task beyond request completion. The provided long-lived Node
runtime tracks tasks, keeps Node alive and exposes `drain()` for shutdown. It is
not suitable for a request host that freezes/kills processes. Custom runtimes must
invoke once and own lifetime independently. Queue acceptance is not startup; the
engine also waits for actual handler entry. Startup failure rejects launch;
post-entry handler errors appear in status. There is no automatic replay.

After return, the same optional diff protocol runs. A short framework-only
transaction conditionally completes the execution and releases ownership if its
identity still owns an unexpired lease. Journal success is not required. Lease
validity uses the storage adapter's clock. Fixed leases have no heartbeat.

## Status, uncertainty and resolution

`getExecution` reads durable launch records, independently from optional journals:

| Status | Meaning |
| --- | --- |
| running | Handler startup recorded, ownership not expired, not finalized. |
| completed | Successful handler completion durably finalized; journal may have failed or been skipped. |
| unresolved | Startup uncertainty, handler error, expiration or finalization uncertainty. |
| resolved | Explicit reconciliation recorded; no assertion about the old handler's business outcome. |

Unknown IDs return null. Ordinary `run` IDs do not create status records. A claim
awaiting startup is conservatively unresolved with reason `startup`; its startup
transition is conditional. Process death can occur between recording startup and
handler entry. No status reader replays work. Expiry is recognized on lookup
without a sweeper. If the status store is unavailable after a handler completes,
lookup may still show running until expiry; a successful but unacknowledged
finalization can instead be reconciled as completed.

Unresolved ownership blocks new launches even after expiration. Following
reconciliation, `resolveExecution` records actor, reason and time and clears only
that execution's ownership atomically. It rejects running/unexpired or already
settled records. Old callbacks cannot overwrite resolution or newer ownership.
Authorization and the correctness of reconciliation belong to the host.

## Exact boundary of the lease

Leases coordinate participating launches and protect framework status transitions.
They do not fence independently committed domain writes or provider effects.
A handler may write after expiration or resolution. Resolution does not cancel it.
Ordinary `run`, unrelated writers and external providers do not participate.
Applications requiring stale-write fencing must explicitly integrate their own
ownership check. There is no retry, resumption, compensation or recovery worker.

## Journal projection and ingestion

The Case schema defines comparable before/after journal shapes. Typed serialization
supports Dates, Sets, bigint and other documented values. New observations contain
safe identity/actor attribution, scope, observation times, before-state and diff;
they do not store raw request bodies or authentication objects. The default actor
projection is a string actor or its string `id`; hosts can supply `actorIdentity`.
An observation is not proof of an atomic commit or exact causality among writers.
Late observations retain their execution identity and never alter launch status.

Ingestion deduplicates events, correlates them and uses `run`. It records delivery
outcomes separately. A thrown handler may have committed, so redelivery does not
automatically reopen failed operations. Applications retain their own idempotency
and reconciliation procedures. Correlations and dormancy can be explicitly
managed by the application; they are no longer staged by handler-context helpers.

## Beta replacement

The public execution surface is `run`, `launch`, `getExecution` and
`resolveExecution`. `execute`, `executeNonAtomic` and the atomic storage port are
removed. Consumers must change transaction ownership deliberately. No historical
journal or lease data migration is provided; bootstrap requires fresh framework
tables. Domain data stays application-owned.

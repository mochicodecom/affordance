# Affordance

Code-first framework for adaptive case management: long-lived business cases whose available next steps are computed from guards over case state, rather than from a declared flow.

## Language

Definitions only. The reasoning behind them is in [`docs/architecture.md`](docs/architecture.md).

**Case**:
A long-lived stateful entity representing one instance of a business matter (e.g., one house purchase).
_Avoid_: workflow instance, process instance

**Case Type**:
The code definition of a kind of case: a state schema and a set of step definitions. Nothing else.
_Avoid_: workflow definition, flow

**Case State**:
The single mutable document belonging to a case; changed only by executions.
_Avoid_: context, payload, data

**Step**:
An independently-defined unit of possible work on a case: a guard plus a handler.
_Avoid_: task, activity, transition, action

**Guard**:
A step's full set of named conditions; the step is available when all hold.
_Avoid_: precondition block

**Condition**:
One named, pure, synchronous predicate within a guard; the unit of explainability.
_Avoid_: rule

**Condition address**:
Where one condition sits in its guard: `section.name` (`requires.escrowReady`), or `section.name.arm` inside an `anyOf`. Stable and unique within a guard, which is why a refusal names a condition by it.
_Avoid_: condition path, condition key

**Affordance**:
A step (with its scope binding, if scoped) currently available on a case for a given actor.
_Avoid_: available action, task, next step

**Scope**:
The collection-element binding of a scoped step (e.g., buyer #7); part of an affordance's identity.
_Avoid_: target, subject

**Step target**:
A step paired with the scope binding it is being considered for — an affordance's identity, named *before* asking whether the guard holds. Always the pair, never the element alone; the element is the Scope.
_Avoid_: resolved step, step instance

**Actor**:
Who or what executes a step: a human, an external system via event, or an agent.
_Avoid_: user, assignee

**Persona**:
An actor the reference app's console impersonates, set client-side as the two actor headers. The console holds no acting persona: each lane acts as its own, and one fixed observer persona makes the main read. A UI-layer stand-in for an Actor; carries no framework identity.
_Avoid_: user, login, account, tab

**Handler**:
A step's effect function; the only thing that mutates case state.
_Avoid_: task body

**Execution**:
One recorded run of a step on a case; the journal's unit.
_Avoid_: invocation

**Claim**:
The short-lived exclusive lease an execution takes on a case before its handler runs; it expires unless heartbeated, so a crashed handler releases the case rather than deadlocking it.
_Avoid_: lock, reservation, lease

**Journal**:
The immutable, append-only record of a case's executions.
_Avoid_: history, event log, audit log

**Delta**:
What one execution changed in case state, journaled as JSON Patch.
_Avoid_: changeset, state diff

**Completion**:
Whether a matter is finished — a fact about the matter, expressed in case state (`closedAt`, `withdrawnAt`) and computed by the app. Deliberately not modelled: the framework has no completion slot and no `complete` field. It models *attention* (see Dormancy), never outcome.
_Avoid_: terminal state, end node, engine status

**Dormancy**:
The condition of a case whose handler called `end()`: skipped by the queries that sweep cases. Never a freeze — a dormant case still computes affordances, and un-ending is an ordinary step. Stored, unlike Completion, because its consumers are SQL predicates.
_Avoid_: archived, closed, terminated

**Materialize**:
To bring an external fact into case state via an execution — on event or on demand.
_Avoid_: sync, cache

**Correlation**:
The mapping from an external identifier to a case (and scope). Registered by the handler that starts the external interaction, in the same commit.
_Avoid_: routing

**Ingestion**:
Turning one external event into one execution: dedup, correlate, claim/run/commit with the external system as the actor.
_Avoid_: webhook handler, consumer

**Dead letter**:
An ingested event that changed nothing, kept with the reason why. The reason is `unrouted`, `no-step`, or the code the refused Execution declared. Never a silent drop.
_Avoid_: error queue, failed message

**Refusal**:
A deliberate no from the framework — a guard that said no, a busy case, an address that does not resolve, an input its schema rejects — carrying a code that names the kind. The set of codes is closed, so an adapter translates kinds rather than enumerating error classes. A bug or an infrastructure failure is not a refusal and is never dressed up as one.
_Avoid_: exception, failure

**System runner**:
The lenient door for running a Step: a sweep (Ingestion, Migration) executes through it and is answered with a total outcome — committed, or settled with whatever the run threw (a Refusal keeps its identity and its code) — never a throw. Whether what settled was a Refusal is asked once, where a consumer needs the distinction (the dead-letter projection). The loud half is `Engine.execute`, which propagates because an addressed caller is owed the refusal.
_Avoid_: internal execute, silent mode

**Visibility**:
How much a read tells a caller about steps they cannot take. `permitted` (the default): no `permits` condition result leaves the process, and Case State stays off the wire. `all`: the operator's full view. One rule, applied to every outbound payload — blocked entries, explanations, refusals, and journal entries.
_Avoid_: redaction level, permission filtering

# Affordance

Updated: 2026-09-06

A framework for long-lived business cases whose available work is computed from
current state and actor permissions. For examples, read the
[introduction](docs/tutorial/README.md); for guarantees and reasoning, read the
[architecture](docs/architecture.md).

## Language

### Cases and available work

**Case**:
A persisted object representing one business matter, with state and behavior
defined by its case type.
_Avoid_: workflow instance, process instance

**Case Type**:
The definition of a kind of case: a state schema and a set of steps.
_Avoid_: workflow definition, flow

**Case State**:
The current document of facts belonging to a case.
_Avoid_: context, payload, data

**Step**:
An independently defined unit of work on a case, consisting of a guard and a handler.
_Avoid_: task, activity, transition, action

**Guard**:
The named conditions governing a step's availability, separated into case
requirements and actor permissions.
_Avoid_: precondition block

**Condition**:
One named, pure, synchronous predicate within a guard.
_Avoid_: rule

**Condition address**:
A condition's location within a guard: `section.name`, or `section.name.arm`
for an alternative within a group.
_Avoid_: condition path, condition key

**Affordance**:
A step, with its scope binding if scoped, currently available on a case for a
given actor.
_Avoid_: available action, task, next step

**Scope**:
The collection element a scoped step binds to, such as one buyer.
_Avoid_: target, subject

**Step target**:
A step paired with its scope binding, considered before evaluating availability.
_Avoid_: resolved step, step instance

**Actor**:
The person, external system, or agent on whose behalf work is considered or executed.
_Avoid_: user, assignee

**Persona**:
An actor impersonated by the reference console for viewing and taking affordances.
_Avoid_: login, account, tab

### Execution and evidence

**Handler**:
A step's effect function, which receives current case state and returns the next state.
_Avoid_: task body

**Execution**:
One recorded run of a step on a case.
_Avoid_: invocation

**Claim**:
An execution's exclusive, expiring right to change a case's state.
_Avoid_: lock, reservation, lease

**Journal**:
The append-only record of a case's executions and their evidence.
_Avoid_: history, event log, audit log

**Delta**:
The change in case state committed by one execution.
_Avoid_: changeset, state diff

**Refusal**:
A framework-declared rejection with a code identifying its kind. An unrelated
bug or infrastructure failure is not a refusal.
_Avoid_: exception, failure

**System runner**:
The execution entry point used by ingestion and migration to receive per-case
outcomes, including failures.
_Avoid_: internal execute, silent mode

### External facts and case outcomes

**Materialize**:
To record an external fact in case state through an execution.
_Avoid_: sync, cache

**Correlation**:
The association of an external identifier with a case, scope, and optional step.
_Avoid_: routing

**Ingestion**:
The handling of an external event through deduplication, correlation, and execution.
_Avoid_: webhook handler, consumer

**Dead letter**:
An ingested event that could not be applied, retained with the reason.
_Avoid_: error queue, failed message

**Completion**:
Whether the business matter is finished, expressed as facts in case state.
_Avoid_: terminal state, end node, engine status

**Dormancy**:
A reversible marker that a case no longer needs routine attention; it does not
prevent further work.
_Avoid_: archived, closed, terminated

**Visibility**:
The policy controlling how much an HTTP response reveals about unavailable
steps, condition results, and recorded case state.
_Avoid_: redaction level, permission filtering

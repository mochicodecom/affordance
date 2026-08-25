# The affordance JSON contract — `affordance/v1`

This is the wire format for "what can happen on this case, for this actor,
right now". It is where the HATEOAS bet becomes concrete: the response is not
a rendering of a case, it is the set of things the caller can do next, each
one carrying what it needs to be done. A client — a UI, a script, or an agent
consuming it as a tool list — should never need out-of-band knowledge of the
process to know what to offer.

Every payload carries `"contract": "affordance/v1"`. The version changes
only on a breaking change; new optional fields are additive and do not.

## Resources

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/cases/{id}/affordances[?asOf=]` | the affordance payload |
| `GET` | `/cases/{id}/affordances/{step}[?scopeKey=&asOf=]` | the full per-condition explanation of one step |
| `POST` | `/cases/{id}/steps/{step}` | the execution result, or the unmet conditions |
| `GET` | `/cases/{id}/journal[?scopeKey=&step=&entry=&since=&limit=]` | journal entries, oldest first |
| `POST` | `/cases` | a created case |
| `POST` | `/events` | the ingestion result for one external event |
| `GET` | `/dead-letters[?system=&caseId=&limit=]` | the dead-letter surface, newest first |

Paths are relative to the mount point; every `href` in a payload is absolute
from the same mount point, so a client follows links and never builds URLs.

## The affordance payload

```json
{
  "contract": "affordance/v1",
  "case": {
    "id": "5f1b…",
    "type": "house-purchase",
    "asOf": "2026-08-05T12:00:00.000Z",
    "endedAt": null
  },
  "affordances": [
    {
      "step": "escalate-verification",
      "scopeKey": "buyer_007",
      "title": "Escalate a stalled verification",
      "description": "Move a buyer whose verification sits in review into enhanced review.",
      "input": { "required": false, "schema": null, "vendor": null },
      "links": {
        "execute": { "method": "POST", "href": "/cases/5f1b…/steps/escalate-verification" },
        "explain": { "method": "GET", "href": "/cases/5f1b…/affordances/escalate-verification?scopeKey=buyer_007" }
      }
    }
  ],
  "blocked": [
    {
      "step": "close-purchase",
      "title": "Close the purchase",
      "description": null,
      "possible": false,
      "permitted": true,
      "unmet": [
        {
          "name": "allBuyersSigned",
          "section": "requires",
          "kind": "condition",
          "passed": false,
          "reason": "2 buyers have not signed"
        }
      ],
      "links": {
        "explain": { "method": "GET", "href": "/cases/5f1b…/affordances/close-purchase" }
      }
    }
  ],
  "links": {
    "self": { "method": "GET", "href": "/cases/5f1b…/affordances" },
    "journal": { "method": "GET", "href": "/cases/5f1b…/journal" }
  }
}
```

### `affordances[]`

A step the actor can take **now**. Identity is `(step, scopeKey)`: a scoped
step contributes one entry per selected element (a buyer, a wire), and
`scopeKey` is absent for an unscoped step. `input` describes what the execute
call expects: `schema` is the step's input schema serialized by the host
app's `describeInput` hook (JSON Schema, typically), `null` when the host did
not supply one; `vendor` names the schema library that produced it.

`title` and `description` are the step definition's own words — a short human
label and a what-and-when sentence, `null` when the definition declares none.
They are why a client (a UI, or an agent reading this payload as a tool list)
needs no out-of-band label table; `step` stays the identity, so a client
renders `title ?? step`. Both fields also appear on `blocked[]` entries and
on the explanation payload.

An affordance is **advice, not a reservation**. Between rendering it and
executing it, state can move and definitions can be deployed. The
execute call re-evaluates the guard transactionally, and a rejection is the
normal, expected outcome of that race — see below.

### `blocked[]`

A step that is not available, with the named conditions saying why.
`possible: false` means an unmet `requires` — not possible on this case, for
anyone. `permitted: false` means an unmet `permits` — possible, but not for
this actor.

**Visibility.** By default (`visibility: "permitted"`) the payload omits
entries the actor is not permitted to take, and reports only unmet `requires`
conditions on the entries it does include. Two reasons, both about not
leaking:

- Another buyer's affordances are not this buyer's business, and
  listing them as "blocked" would disclose that they exist at all.
- `permits` conditions encode internal policy — role names, thresholds,
  approval hierarchies. Naming the ones a caller failed tells them how to
  look like someone else.

A host serving an internal ops console can pass `visibility: "all"` to see
every blocked entry with its `permits` conditions named.

### Reserved condition names

One condition name in `unmet[]` (and in explanations) is the framework's
own rather than the case type's, and `@affordance/contract` declares it —
a client that switches on it imports the constant, never copies the
string:

- **`$scope`** (`SCOPE_FAILURE_CONDITION`) — a scoped step whose selector
  failed over this Case State. The blocked entry carries no `scopeKey`
  (fan-out itself failed), and following its `explain` link answers with
  this same single condition rather than an error.

### `asOf`

Both read endpoints accept an `asOf` instant and evaluate the whole payload
as of it. Only the instant moves: the evaluation always runs over the case's
**current** state, and conditions never read a clock, so handing them a
different instant is exact. That makes `asOf` a preview device — "what will
be possible once that seven-day clock runs out" — not a time machine.

It does not answer "what was possible last Tuesday": the state may have
changed since Tuesday, and this read never rewinds state. That audit
question belongs to the journal, whose `claimed` entries record the guard
evaluation, the instant it was made as of, and the Case State it ran
against.

It is accepted on the **read** routes only. Executing a step as of a
caller-chosen instant is how a caller talks their way past a time condition,
so the execute route always claims as of now.

### `case`

`asOf` is the instant everything in the payload was evaluated as of.
`endedAt` is the dormancy marker: the organisation has stopped spending
attention on this case. It is never a freeze — a dormant case still computes
affordances and still returns them, and un-ending is an ordinary step.

There is deliberately **no `complete` field**, and no other verdict on whether
the matter is finished. See below.

### Knowing there is nothing left to do

The contract answers "what can this actor do here" and nothing else, so "is
this case done" is answered by reading what it already sent you.

**Is there anything for me?** `affordances` is empty. That is the whole test.
It is per-actor by design: a buyer whose track is finished sees an empty
list on a purchase that is still running, which is the correct answer to the
question they asked.

**Is it empty because it is over, or because it is waiting?** Look at
`blocked[]`. Every blocked step carries its unmet conditions with their
stated reasons, so what the case is waiting on is data already in the
payload.

**Has the organisation filed this away?** `case.endedAt`.

**Did the matter end well?** That is a domain fact, and the contract does not
carry case state. A client that reads `purchase.closedAt` has re-acquired the
out-of-band knowledge this format exists to remove. Outcomes reach a client
through *which capabilities appear*: a purchase that offers `record-deed` has closed,
because closing is what `record-deed` requires. A client that needs the underlying
document is an app, and an app embeds the library.

## Executing a step

```http
POST /cases/{id}/steps/{step}
Content-Type: application/json

{ "scopeKey": "buyer_007", "input": { "callAmount": 250000 } }
```

`201` with the execution result:

```json
{
  "contract": "affordance/v1",
  "execution": {
    "executionId": "9a2c…",
    "caseId": "5f1b…",
    "caseType": "house-purchase",
    "step": "issue-funding-call",
    "scopeKey": null,
    "attempts": 1,
    "seq": 4,
    "delta": [{ "op": "add", "path": "/fundingCall", "value": { "amount": 250000 } }],
    "dormancy": null,
    "endedAt": null,
    "claimedAt": "2026-08-05T12:00:01.001Z",
    "committedAt": "2026-08-05T12:00:01.412Z"
  },
  "links": {
    "affordances": { "method": "GET", "href": "/cases/5f1b…/affordances" },
    "journal": { "method": "GET", "href": "/cases/5f1b…/journal?executionId=9a2c…" }
  }
}
```

### Rejections

| Status | `error` | Meaning |
| --- | --- | --- |
| `400` | `bad-request` | unknown step name, missing or unknown `scopeKey`, malformed body |
| `404` | `not-found` | no such case (or case type) |
| `409` | `step-not-available` | the guard said no — carries `possible`, `permitted`, `unmet` |
| `409` | `case-busy` | another Execution holds the case, or took it over mid-handler; retry |
| `422` | `invalid-input` | the input failed the step's schema — carries `issues` |
| `500` | `execution-failed` | the handler failed after its retries |
| `500` | `invalid-state` | the stored Case State no longer satisfies its schema |

**That table is the whole set.** `error` is not free text an adapter invents:
the framework declares the kind of every refusal it raises, from exactly these
seven codes, and the adapter maps kind to status. A client can therefore
branch on `error` exhaustively, and a refusal an adapter has never heard of is
not possible. The set's one declaration is `REFUSAL_CODES` in
`@affordance/contract` — the engine's error taxonomy and this table both
derive from it, so this prose can lag but cannot silently disagree with
running code that imports the constant.

The corollary matters as much. Anything that is *not* a refusal — a bug, a
database that has gone away — is not translated into a contract payload at
all; it propagates to the host, which is what a host's own error handling is
for. A `500 execution-failed` means the handler ran and failed, and nothing
else does.

`409 step-not-available` is the mid-click race made legible, and it is the one
every client must handle:

```json
{
  "contract": "affordance/v1",
  "error": "step-not-available",
  "message": "step 'close-purchase' is not available on case 5f1b…",
  "possible": false,
  "permitted": true,
  "unmet": [{ "name": "allBuyersSigned", "section": "requires", "kind": "condition", "passed": false }],
  "links": { "affordances": { "method": "GET", "href": "/cases/5f1b…/affordances" } }
}
```

The `unmet` list obeys the same visibility rule as `blocked[]`: a caller who
failed only `permits` is told `permitted: false` and nothing more.

## Explaining a step

`GET /cases/{id}/affordances/{step}` returns the full per-condition
evaluation — every condition, passed and failed, with `anyOf` groups showing
each arm. This is the
"why can't I" endpoint; it is subject to the same visibility rule.

A scoped step whose selector is defective answers with the single reserved
`$scope` condition (see [Reserved condition names](#reserved-condition-names))
instead of erroring: the listing published a blocked `$scope` entry with an
`explain` link, and every link the contract hands out is followable.

## The journal

`GET /cases/{id}/journal` returns entries oldest-first, filterable
by `scopeKey` (per-track audit), `step`, `executionId`, `entry`, `since`
(cursor), and `limit`.

The journal obeys the same visibility rule as every other read. A `claimed`
entry stores the full guard evaluation and the Case State it ran against;
that record is for the audit. Under `permitted` visibility the payload does
not show it: `guard.conditions` omits every `permits` result (the
`possible` / `permitted` verdicts stay), and `state` is omitted. Case State
stays off the wire on every route, the journal included. Under
`visibility: "all"` the operator gets the full record.

## Webhook ingestion

`POST /events` takes one external event and returns the ingestion result
(`executed`, `duplicate`, or `dead-lettered` with a reason). It always
answers `200` for an event it recorded, whatever became of it: a webhook
endpoint that returns 5xx because a guard said no teaches the provider to
retry something that will never succeed. Only an event the system could not
even record is a 5xx.

On `executed`, the result carries the same `execution` object as the
execute route. It never carries Case State or the guard evaluation. A
`dead-lettered` reason is `unrouted`, `no-step`, or the refused Execution's
own error code from the rejection table above.

## The dead-letter surface

`GET /dead-letters` returns ingested events that changed nothing, newest
first, each with its reason and the event kept verbatim for replay. This is
an **operator's read**: events carry other actors' payloads. Mount it the
way you would serve `visibility: "all"` — on an internal path.

## Actors

The framework never owns identity. The host app resolves the actor from
the request — a session, a JWT, an API key, a service account — and hands it
to the adapter; every condition, every journal entry, and every visibility
decision uses that value verbatim. There is no user model, no role table, and
no login endpoint anywhere in this contract.

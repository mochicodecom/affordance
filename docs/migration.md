# Migrating case state

Cases float to the latest definitions. A deploy changes the steps,
and every in-flight case is governed by the new ones from that moment — no
migration, no version pin, no in-flight case stuck on the definitions it
started under. That is the posture. This document is about the exception.

## The default: write a total condition

Conditions and selectors are **total over historical state**: they will be
evaluated against documents written before they existed, and they must handle
that deliberately rather than by accident. In practice that is the `??`
fallback:

```ts
requires: {
  splitFinal: s => s.split?.confirmed ?? false,
  inspected:  s => (s.property?.inspectionReportId ?? null) !== null,
}
```

Almost every change is additive, and additive changes need nothing else:

| Change | What to do |
| --- | --- |
| A new optional field | Read it with `?? fallback`. Nothing to migrate. |
| A new step | Add it. In-flight cases can take it immediately. |
| A new condition on an existing step | Add it. Cases that fail it are blocked, with the condition named in `explain` — which is the correct answer, not a problem to fix. |
| A new required field, with a sensible default | Give the schema a `.default(...)`. Old documents acquire it on read. |
| A field that changed meaning but not shape | Read both meanings in the condition, while both exist in the wild. |

If a total condition can read the old shape, **write the total condition**.
It costs one expression, it needs no coordination with a deploy, and it
leaves no execution history behind. A migration costs a run over every case,
a journal entry each, and a permanent artifact in the audit record.

## The exception: a restructure

Some changes are not readable by any expression over the old document:

- a field **renamed** (`s.buyer` → `s.coOwner`)
- one field **split into two** (`s.name` → `s.firstName` + `s.lastName`)
- a scalar that became a **collection** (`s.buyer` → `s.buyers[]`)
- a collection whose **element identity** changed (keys re-derived — and scope
  keys are affordance identity, so this one is not optional)

For these, run a migration. The test is not "would a migration be tidier" but
"is the old shape still readable at all".

## Running one

```ts
const report = await engine.migrate(
  'house-purchase',
  '2026-08-rename-buyer-to-co-owner',
  (s: any) => ({ ...s, coOwners: s.buyers ?? [], buyers: undefined }),
  { batchSize: 200, onProgress: p => console.log(p.processed, p.caseId, p.outcome) },
)
```

What happens per case: the ordinary claim → run → commit, under a synthetic
step named `migrate:<name>`, with a migration actor. The case row is locked,
an in-flight Execution blocks it (and is retried next run), the result is
validated against the state schema, and a `completed`
journal entry records the delta.

Properties worth knowing:

- **Idempotent.** The marker is the journal entry, not a flag in state. A case
  bearing a completed `migrate:<name>` entry is never examined again.
- **Resumable.** Interrupt it, run it again; it continues from where it
  stopped, because the marker is per case.
- **Non-fatal.** A case that fails — busy, transform threw, result rejected by
  the schema — is reported in `report.failed` and the run continues. It has no
  marker, so the next run retries it.
- **Auditable.** `engine.journal(caseId)` shows the migration among everything
  else that ever happened to the case, with its delta. Reconstruction
  `asOf` before and after the entry shows the two shapes.
- **Dry-runnable.** `{ dryRun: true }` computes every delta and writes
  nothing, leaving no marker.

## Writing the transform

The transform is code that must be **total**, exactly like a condition: it
will be handed documents written by every definition the case has floated
through, including ones the current schema barely recognizes.

- Returning the input unchanged must be safe. The run journals it as an
  unchanged case and marks it, which is what makes "this migration considered
  this case and had nothing to do" provable later.
- Never assume the *previous* migration ran. Order is not guaranteed across a
  fleet mid-deploy; check the shape, not the history.
- Keep it pure. It is a state transform, not a place to call an API — if the
  new shape needs a fact from outside, materialize that fact with an ordinary
  step first and migrate afterwards.

## Deploying one

1. Deploy definitions that read **both** shapes (`s.coOwners ?? s.buyers
   ?? []`). Nothing breaks while cases are mixed.
2. Run the migration. Cases restructure one at a time, and the running app
   keeps serving throughout.
3. Once `report.failed` is empty and `scanned` reaches zero on a re-run, drop
   the old-shape reads from the definitions.

The two-shape window is what makes step 2 uneventful. Skipping it means the
app is briefly wrong for every case the migration has not reached yet — which
is the failure mode that makes migrations feared.

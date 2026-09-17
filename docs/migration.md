# Adopting the run/launch beta

This is a breaking beta redesign. There are no compatibility execution methods
and no migration of old framework journals or lease records. Install into a fresh
framework schema; bootstrap never resets it automatically. Preserve application
domain data using the application's own migration procedures.

Replace transaction-bound handlers with calls to application operations that own
persistence, admission, transactions, provider calls and idempotency. Remove the
binding's `protect`/`repositories` fields; it supplies only `load`. Replace
`stepsOf(schema, actor(), repositories())` with `stepsOf(schema, actor())`.
The handler context no longer has `repos`, `correlate`, `end` or `reopen`. Move
correlation/dormancy writes into explicit application operations where needed.

Choose the handler result deliberately: return a truthful persisted Case snapshot
for a diff, or return nothing to skip it. `run` waits for completion and reports
journal disposition. A return snapshot is evidence only; it is never saved as
current Case State. A method rename cannot transfer transaction ownership or
preserve accepted-command replay rules automatically.

Choose `launch` only when the host owns a background runtime and the operation can
be reconciled after timeout/crash. Configure a fixed lease, expose authorized
status/resolution, and integrate application fencing if required. Do not enclose
launch in an operation retry wrapper that might replay external effects.

Sync adoption remains separately reviewed work. Refresh its consumer inventory,
preserve business locks/events/idempotency and refusal-as-value contracts, and
explicitly adapt refused results before reporting handler success. Keep existing
completion receipts as an application feature until their replacement is decided.
A void-returning operation creates no diff automatically. Existing application
writers do not participate in launch exclusion without explicit integration.

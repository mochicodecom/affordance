# The handler cast erases TInput/TElement, not TState/TActor

Asked (on Lesson 1's erasure excerpt) why `step()` needs the handler cast when generics already carry `TState`/`TActor`. Established the full answer: those two *are* preserved; the cast erases the per-step generics (`TInput`, `TElement`) that a homogeneous `steps` list cannot hold, and plain assignment fails because function parameters are contravariant — a handler demanding `ctx.input: T` cannot be typed as accepting `unknown`. Soundness rests on a runtime invariant in `execute.ts` (input validated, scope bound before invocation), which the comment at the cast site names.

## Evidence

The question itself shows Lesson 1/4 material being engaged at the type level — the user correctly identified that `TState`/`TActor` were in scope and pressed on the apparent redundancy.

## Implications

Variance-level TypeScript reasoning is inside the user's reach; future lessons or follow-ups can discuss contravariance, existential erasure, and brand types without extra scaffolding.

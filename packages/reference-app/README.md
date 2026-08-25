# A group house purchase — the reference app

The anchor use case, built for real. Not a demo of the framework's features:
several people pooling money to buy a house together, with the parts that
actually make case management hard — money that does not match and a
verification hit that ages.

```
pnpm db:up                                  # Postgres
pnpm --filter @affordance/reference-app ui:build  # build the demo console (once, and after ui/ changes)
pnpm --filter @affordance/reference-app serve     # serve the app, console at /
pnpm test                                   # the acceptance tests
```

The server seeds nothing — a case exists only when someone creates one
through the API. The acceptance tests stage their own.

The demo console served at `GET /` is a React + Mantine app living in
`ui/` — a standalone Vite project, deliberately not a workspace package. It
reads wire payloads against `@affordance/contract` (a `file:` link — types
only, no engine).
`serve` never builds it for you: run `ui:build` first (the server refuses
to start without `ui/dist`). For iterating on the console itself,
`pnpm --filter @affordance/reference-app ui:dev` runs Vite's dev server on
:5173, proxying `/api` and `/dev` to the app on :8787.

## What is here

| File | What it holds |
| --- | --- |
| `src/state.ts` | the Case State schema — no status field, no stage, no pointer |
| `src/steps.ts` | every step, as a flat list of guards. No ordering declared anywhere |
| `src/purchase.ts` | the house-purchase definition set |
| `src/services.ts` | mock verification, e-sign and escrow banking: they answer late, and they retry |
| `src/app.ts` | the wiring — engine, providers, HTTP adapter |
| `src/serve.ts` | the server entry — boots the app and serves, seeding nothing |
| `ui/` | the demo console: React + Mantine, served at `/` from `ui/dist` |

## The two exceptions

**Wire reconciliation.** `reconcile-wire` is auto-executing and scoped over
unreconciled wires. Its outcomes — `matched`, `short`, `over`,
`wrong-account` — are *state*, and each has its own resolution step guarded on
it. Nobody drew a branch; a short wire simply makes `accept-short-wire`
available for that wire and nothing else.

**Verification escalation.** A provider hit puts a buyer in `review` and
writes `flaggedAt`. `escalate-verification` declares
`after(days(7), b => b.verification.flaggedAt)` over the *buyer*, so the
scheduler knows the exact instant per buyer, and a case with three flagged
buyers has three independent clocks. Escalation is the escrow officer's step,
not the organizer's — which is a `permits` condition, not a workflow role.

## How the providers misbehave

Real integrations answer out of band, more than once, and about identifiers
that mean nothing to your database. So:

- `flush()` is when the webhooks arrive — until then a case sits waiting,
  exactly as it would in production;
- every webhook is delivered `attempts` times (default 3), so ingestion's
  dedup earns its keep on every single one;
- a webhook quotes an envelope or an account, never a case, so it routes only
  because the handler that started the interaction registered the correlation
  in the same commit.

## Driving it

Everything in `test/` goes through the HTTP adapter and follows links out of
affordance payloads — no test builds a URL or knows an order. If the happy
path is reachable that way, the HATEOAS claim holds for this case type; if it
were not, no amount of green unit tests would matter.

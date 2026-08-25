// Copyright © 2026 Mochicode LLC — mochicode.com

/**
 * @affordance/http — the thin, optional HTTP adapter.
 *
 * Two things live here, and the first matters more than the second:
 *
 * 1. **The affordance JSON contract** (`contract.ts`, specified in
 *    `docs/affordance-contract.md`) — the wire format for "what can happen on
 *    this case, for this actor, right now", precise enough that a future
 *    agent could consume it as a tool list. This is where the HATEOAS bet —
 *    responses carry the links a client may follow next — becomes something
 *    a client can actually rely on.
 * 2. **An adapter** (`api.ts`) that serves it: a framework-agnostic core over
 *    plain request/response objects, plus a hono binding (`hono.ts`) that
 *    stays small because the seam leaves it only translation to do.
 *
 * The framework never owns identity: the host resolves the actor and hands it
 * in. Nothing here has a user model, a role table, or a login route.
 */

export type {
  AffordanceEntry,
  AffordancePayload,
  BlockedEntry,
  CaseDescriptor,
  ConditionPayload,
  DeadLetterEntry,
  DeadLettersPayload,
  ErrorPayload,
  ExecutionDescriptor,
  ExecutionPayload,
  ExplanationPayload,
  GuardEvaluationPayload,
  IngestionDescriptor,
  IngestionPayload,
  InputDescriptor,
  JournalEntryPayload,
  JournalPayload,
  Link,
  Visibility,
} from '@affordance/contract'
export { CONTRACT } from '@affordance/contract'
// The package's whole public surface: the two constructors, the port they meet
// the engine at, and the wire types a client reads payloads against. The
// wire types are `@affordance/contract`'s — re-exported, not declared, so
// there is exactly one declaration of the wire. The serializers and the link
// builder are the contract's implementation — they stay internal, so the
// payload types are the only way to depend on them.
export type {
  AffordanceApi,
  ApiOptions,
  ApiRequest,
  ApiResponse,
  EnginePort,
} from './api.js'
export { createAffordanceApi } from './api.js'
export type { DescribeInput } from './contract.js'
export type { HonoBindingOptions } from './hono.js'
export { createHonoApp } from './hono.js'

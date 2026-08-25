// Copyright © 2026 Mochicode LLC — mochicode.com

/**
 * @affordance/contract — the wire shapes of `affordance/v1`, whole, and
 * nothing else.
 *
 * This package is deliberately dependency-free: no engine, no Node, no
 * schema library. It exists so the contract has exactly **one declaration**
 * with two kinds of reader:
 *
 * - `@affordance/http` serializes the framework's records *into* these types.
 *   Core records are inputs to that translation, never members of it — a
 *   core rename that would change the wire is a compile error in the
 *   serializer, not a silent `affordance/v1` break.
 * - A client (the reference console's `ui/`, a script, an agent) reads
 *   payloads *against* these types without acquiring a dependency on the
 *   engine. A client that hand-copies them has created a second declaration
 *   of the wire, one that can drift; that is why this package exists.
 *
 * Everything here is a plain JSON shape. The version constant changes only
 * on a breaking change; new optional fields are additive and do not.
 */

/** The contract version every payload carries. */
export const CONTRACT = 'affordance/v1'

/**
 * How much a caller is told about steps they cannot take.
 *
 * - `permitted` (default) — omit entries the actor is not permitted to take,
 *   and name only unmet `requires` conditions on the rest. A client sees why
 *   its own work is blocked and learns nothing about anyone else's.
 * - `all` — every blocked entry, every unmet condition, `permits` included.
 *   For an internal ops console, where the audience is the operator.
 */
export type Visibility = 'permitted' | 'all'

/** A followable link. */
export interface Link {
  readonly method: string
  readonly href: string
}

/** What the execute call expects, as far as it can be described on the wire. */
export interface InputDescriptor {
  readonly required: boolean
  /** The step's input schema, serialized by the host's `describeInput` hook. */
  readonly schema: unknown
  /** Which schema library produced it (`'zod'`, …), or `null` when there is no schema. */
  readonly vendor: string | null
}

/** Which guard section a condition came from. */
export type ConditionSection = 'requires' | 'permits'

/** Fields common to every per-condition result in a payload. */
export interface ConditionPayloadBase {
  /** The condition's name in its section map (or its arm name, within an anyOf group). */
  readonly name: string
  readonly section: ConditionSection
  readonly passed: boolean
  /** Present when the condition supplied one. */
  readonly reason?: string
}

/** One plain (predicate) condition's result. */
export interface SingleConditionPayload extends ConditionPayloadBase {
  readonly kind: 'condition'
}

/** An `anyOf` group's result: passed when at least one arm passed; every arm reported. */
export interface AnyOfConditionPayload extends ConditionPayloadBase {
  readonly kind: 'anyOf'
  readonly arms: readonly SingleConditionPayload[]
}

/** One condition result, as every payload carries it. */
export type ConditionPayload = SingleConditionPayload | AnyOfConditionPayload

/**
 * Condition names the framework itself puts on the wire, alongside the
 * case type's own. They are contract vocabulary — a client that switches on
 * them reads them from here, never from the engine and never as a copied
 * string:
 *
 * - {@link SCOPE_FAILURE_CONDITION} — a scoped step whose selector failed
 *   over this Case State. The blocked entry carries no `scopeKey` (fan-out
 *   itself failed), and its `explain` link answers with the same single
 *   condition.
 */
export const SCOPE_FAILURE_CONDITION = '$scope'

export interface AffordanceEntry {
  readonly step: string
  readonly scopeKey?: string
  /** The step's declared human label, `null` when undeclared — fall back to `step`. */
  readonly title: string | null
  /** The step's declared what-and-when sentence, `null` when undeclared. */
  readonly description: string | null
  readonly input: InputDescriptor
  readonly links: { readonly execute: Link; readonly explain: Link }
}

export interface BlockedEntry {
  readonly step: string
  readonly scopeKey?: string
  readonly title: string | null
  readonly description: string | null
  /** False when a `requires` condition is unmet: not possible on this case, for anyone. */
  readonly possible: boolean
  /** False when a `permits` condition is unmet: possible, but not for this actor. */
  readonly permitted: boolean
  readonly unmet: readonly ConditionPayload[]
  readonly links: { readonly explain: Link }
}

export interface CaseDescriptor {
  readonly id: string
  readonly type: string
  readonly asOf: string
  readonly endedAt: string | null
}

/** The affordance payload — the response of `GET /cases/{id}/affordances`. */
export interface AffordancePayload {
  readonly contract: typeof CONTRACT
  readonly case: CaseDescriptor
  readonly affordances: readonly AffordanceEntry[]
  readonly blocked: readonly BlockedEntry[]
  readonly links: { readonly self: Link; readonly journal: Link }
}

/** One JSON Patch operation of a state delta. */
export type PatchOpPayload =
  | { readonly op: 'add'; readonly path: string; readonly value: unknown }
  | { readonly op: 'remove'; readonly path: string }
  | { readonly op: 'replace'; readonly path: string; readonly value: unknown }

/** An Execution's state delta: the ops taking the previous Case State to the next. */
export type StateDeltaPayload = readonly PatchOpPayload[]

/** `end()` / `reopen()` called by the handler. */
export type DormancyPayload = 'ended' | 'reopened'

/** One committed Execution, as the wire carries it — never the Case State itself. */
export interface ExecutionDescriptor {
  readonly executionId: string
  readonly caseId: string
  readonly caseType: string
  readonly step: string
  readonly scopeKey: string | null
  readonly attempts: number
  readonly seq: number
  readonly delta: StateDeltaPayload
  readonly dormancy: DormancyPayload | null
  readonly endedAt: string | null
  readonly claimedAt: string
  readonly committedAt: string
}

/** The payload of a committed Execution — the response of `POST /cases/{id}/steps/{step}`. */
export interface ExecutionPayload {
  readonly contract: typeof CONTRACT
  readonly execution: ExecutionDescriptor
  readonly links: { readonly affordances: Link; readonly journal: Link }
}

/** The per-condition explanation payload — the "why can't I" endpoint's response. */
export interface ExplanationPayload {
  readonly contract: typeof CONTRACT
  readonly case: CaseDescriptor
  readonly step: string
  readonly scopeKey: string | null
  /** The step's declared human label, `null` when undeclared. */
  readonly title: string | null
  /** The step's declared what-and-when sentence, `null` when undeclared. */
  readonly description: string | null
  readonly available: boolean
  readonly possible: boolean
  readonly permitted: boolean
  readonly conditions: readonly ConditionPayload[]
  readonly links: { readonly affordances: Link }
}

/** A guard evaluation as a journal entry carries it, conditions filtered for the audience. */
export interface GuardEvaluationPayload {
  readonly asOf: string
  readonly possible: boolean
  readonly permitted: boolean
  readonly available: boolean
  readonly conditions: readonly ConditionPayload[]
}

/** A journaled failure — the error's identity, not a live Error object. */
export interface JournalErrorPayload {
  readonly name: string
  readonly message: string
}

/**
 * The lifecycle moments a journal entry can record — declared as a runtime
 * list so an adapter can *validate* a caller's `entry` filter against it
 * (a typo answers 400, never a silently empty journal), with the type
 * derived from it. Like {@link REFUSAL_CODES}, this is the set's one
 * declaration; the engine's journal derives from it.
 */
export const JOURNAL_ENTRY_KINDS = [
  'claimed',
  'attempt-failed',
  'completed',
  'failed',
  'expired',
] as const

/** The lifecycle moment a journal entry records. */
export type JournalEntryKind = (typeof JOURNAL_ENTRY_KINDS)[number]

/**
 * One journal entry on the wire.
 *
 * Not the framework's stored record verbatim: the journal is a read surface
 * like any other, so what a `claimed` entry recorded for the audit is
 * filtered for the audience before it leaves. Under `permitted` visibility
 * the guard's `permits` conditions are dropped from `guard.conditions` and
 * the evaluated-against Case State is omitted entirely; under `all` both are
 * present in full.
 */
export interface JournalEntryPayload {
  /** Total insertion order across all cases; per-case order is `(caseId, ordinal)`. */
  readonly ordinal: number
  readonly id: string
  readonly caseId: string
  /** The Execution this entry belongs to — several entries share one. */
  readonly executionId: string
  readonly entry: JournalEntryKind
  /** 1-based attempt this entry is about. */
  readonly attempt: number
  readonly step: string
  readonly scopeKey: string | null
  /** The acting Actor, as supplied by the app. */
  readonly actor: unknown
  /** The step input, post-validation, or `null`. */
  readonly input: unknown
  /** The instant the claim's guard re-evaluation was made as of, on `claimed` entries. */
  readonly asOf: string | null
  /** The claim-time guard evaluation, conditions filtered for the audience. */
  readonly guard: GuardEvaluationPayload | null
  /** The Case State the guard ran against — present only under `all` visibility. */
  readonly state?: unknown
  /** The committed state delta, on `completed` entries. */
  readonly delta: StateDeltaPayload | null
  readonly dormancy: DormancyPayload | null
  /** The failure, on `attempt-failed` / `failed` / `expired` entries. */
  readonly error: JournalErrorPayload | null
  readonly recordedAt: string
}

/** The journal payload — the response of `GET /cases/{id}/journal`. */
export interface JournalPayload {
  readonly contract: typeof CONTRACT
  readonly entries: readonly JournalEntryPayload[]
}

/** How an ingested event ended up. */
export type IngestionStatus = 'executed' | 'duplicate' | 'dead-lettered'

/**
 * The closed set of refusal codes — every deliberate no the framework can
 * answer with, by kind. **This is the set's one declaration.** The contract
 * owns it because the codes are what the rejection table and the dead-letter
 * surface are specified in terms of; the engine's error taxonomy derives
 * from this list, and the edges' policy maps (HTTP statuses, redelivery
 * reopens) are `Record`s over it, so a new code will not compile until
 * every policy has decided what to do with it.
 */
export const REFUSAL_CODES = [
  /** A guard said no. Carries the unmet conditions. */
  'step-not-available',
  /** Another Execution holds the case — "not now", not "never". */
  'case-busy',
  /** A step's input failed its declared schema. */
  'invalid-input',
  /** No such case, or no such case type. */
  'not-found',
  /** The caller addressed something that cannot be addressed: unknown step, bad scope key. */
  'bad-request',
  /** A handler ran and failed. */
  'execution-failed',
  /** A stored Case State no longer satisfies its schema. */
  'invalid-state',
] as const

/** One refusal code — see {@link REFUSAL_CODES}. */
export type RefusalCode = (typeof REFUSAL_CODES)[number]

/**
 * Why an event was dead-lettered. Two reasons are routing's own; the rest
 * are the refusal code the Execution itself declared.
 */
export type DeadLetterReason = 'unrouted' | 'no-step' | RefusalCode

/** Where an event routed, when it routed. */
export interface CorrelationPayload {
  readonly system: string
  readonly externalId: string
  readonly caseId: string
  readonly scopeKey: string | null
  readonly step: string | null
}

/** An event as an external system delivered it, kept verbatim for replay. */
export interface ExternalEventPayload {
  readonly system: string
  readonly externalId: string
  readonly type: string
  readonly eventId?: string
  readonly payload?: unknown
  readonly step?: string
  readonly idempotencyKey?: string
  readonly occurredAt?: string
}

/** How one delivery ended — the body of `POST /events`' response. */
export interface IngestionDescriptor {
  readonly id: string
  readonly status: IngestionStatus
  readonly system: string
  readonly externalId: string
  readonly idempotencyKey: string
  readonly correlation: CorrelationPayload | null
  /** The Execution it produced, on `executed`. */
  readonly execution: ExecutionDescriptor | null
  readonly reason: DeadLetterReason | null
  readonly detail: string | null
  readonly receivedAt: string
}

/** The ingestion payload — the response of `POST /events`. */
export interface IngestionPayload {
  readonly contract: typeof CONTRACT
  readonly ingestion: IngestionDescriptor
}

/** One row of the dead-letter surface. */
export interface DeadLetterEntry {
  readonly id: string
  readonly system: string
  readonly externalId: string
  readonly type: string
  readonly idempotencyKey: string
  readonly caseId: string | null
  readonly scopeKey: string | null
  readonly step: string | null
  readonly reason: DeadLetterReason
  readonly detail: string | null
  readonly event: ExternalEventPayload
  readonly receivedAt: string
}

/** The dead-letter payload — the response of `GET /dead-letters`. */
export interface DeadLettersPayload {
  readonly contract: typeof CONTRACT
  readonly deadLetters: readonly DeadLetterEntry[]
}

/** An error, as the contract renders it. */
export interface ErrorPayload {
  readonly contract: typeof CONTRACT
  readonly error: string
  readonly message: string
  readonly [key: string]: unknown
}

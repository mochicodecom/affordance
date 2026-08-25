/**
 * The affordance JSON contract — the wire format specified in
 * `docs/affordance-contract.md`.
 *
 * The payload *types* live in `@affordance/contract`, dependency-free, so a
 * client can read against them without acquiring the engine. This module is
 * the serializing side of that seam: every byte any route puts on the wire
 * is produced here, by translating the framework's records *into* the
 * contract's own leaf types. Core records are inputs to that translation and
 * never appear in an exported type — a core rename that would change the
 * wire is a compile error here, not a silent `affordance/v1` break.
 *
 * It is deliberately pure: given a record, a link builder and a visibility
 * policy, it produces the payload. No I/O, no engine, nothing to mock —
 * which is what makes the contract testable as a contract rather than as a
 * side effect of a server.
 *
 * The one piece of judgement — **visibility**, what a caller is allowed to
 * be told about steps they cannot take — is not encoded here. It lives in
 * `audience.ts`, once, and every serializer that carries condition results
 * or a recorded guard evaluation routes through it.
 */

import type {
  AffordanceEntry,
  AffordancePayload,
  BlockedEntry,
  DeadLetterEntry,
  DeadLettersPayload,
  ErrorPayload,
  ExecutionDescriptor,
  ExecutionPayload,
  ExplanationPayload,
  ExternalEventPayload,
  IngestionPayload,
  InputDescriptor,
  JournalEntryPayload,
  JournalPayload,
  Link,
  PatchOpPayload,
  StateDeltaPayload,
  Visibility,
} from '@affordance/contract'
import { CONTRACT } from '@affordance/contract'
import type {
  Affordance,
  AffordanceExplanation,
  BlockedStep,
  CaseAffordances,
  DeadLetter,
  ExecutionResult,
  ExternalEvent,
  IngestionResult,
  JournalEntry,
  PatchOp,
  StateDelta,
  StepMetadata,
} from '@affordance/core'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import {
  visibleAffordances,
  visibleConditions,
  visibleJournalEntry,
} from './audience.js'

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
export { CONTRACT }

/** How the host describes a step's input schema on the wire. */
export type DescribeInput = (schema: StandardSchemaV1) => unknown

/** What the serializers need beyond the records themselves. */
export interface ContractContext {
  /** Prefix every href with this (the adapter's mount point); `''` for root. */
  readonly basePath: string
  readonly visibility: Visibility
  /**
   * Describe a step's input for the wire. The adapter owns resolving and
   * serializing the schema (memoized — it is static per step); the contract
   * only places the descriptor in the payload.
   */
  readonly describeStep: (caseTypeName: string, step: string) => InputDescriptor
  /**
   * A step's declared human metadata for the wire — same registry read
   * discipline as `describeStep`, and the same memoization; `title` and
   * `description` are `null` when undeclared (or the step is unknown).
   */
  readonly metadataFor: (caseTypeName: string, step: string) => StepMetadata
}

// `:` is a legal pchar in a path segment (RFC 3986) and every framework id
// is typed (`case:<uuid>`), so hrefs keep it literal — `/cases/case:…`
// reads as written instead of `case%3A…`.
const encode = (value: string): string =>
  encodeURIComponent(value).replace(/%3A/gi, ':')

/**
 * The contract's URL grammar, whole, in one table. The link builder below
 * and the adapter's dispatcher both read it, so a route cannot be built one
 * way and parsed another — change a pattern here and both sides move
 * together.
 *
 * `:name` segments capture; everything else matches literally.
 */
export const ROUTES = {
  createCase: { method: 'POST', pattern: ['cases'] },
  ingest: { method: 'POST', pattern: ['events'] },
  deadLetters: { method: 'GET', pattern: ['dead-letters'] },
  affordances: { method: 'GET', pattern: ['cases', ':caseId', 'affordances'] },
  explain: {
    method: 'GET',
    pattern: ['cases', ':caseId', 'affordances', ':step'],
  },
  execute: { method: 'POST', pattern: ['cases', ':caseId', 'steps', ':step'] },
  journal: { method: 'GET', pattern: ['cases', ':caseId', 'journal'] },
} as const satisfies Record<
  string,
  { method: string; pattern: readonly string[] }
>

export type RouteName = keyof typeof ROUTES

/** Build the href of a named route by filling its pattern's captures. */
const fill = (
  pattern: readonly string[],
  params: Readonly<Record<string, string>>,
): string =>
  `/${pattern
    .map((segment) =>
      segment.startsWith(':')
        ? encode(params[segment.slice(1)] ?? '')
        : segment,
    )
    .join('/')}`

/** A followable {@link Link} for a named route — the only href constructor. */
export const routeLink = (
  basePath: string,
  name: RouteName,
  params: Readonly<Record<string, string>> = {},
  query = '',
): Link => ({
  method: ROUTES[name].method,
  href: `${basePath}${fill(ROUTES[name].pattern, params)}${query}`,
})

export const links = (basePath: string) => ({
  affordances: (caseId: string): Link =>
    routeLink(basePath, 'affordances', { caseId }),
  explain: (caseId: string, step: string, scopeKey?: string): Link =>
    routeLink(
      basePath,
      'explain',
      { caseId, step },
      scopeKey === undefined ? '' : `?scopeKey=${encode(scopeKey)}`,
    ),
  execute: (caseId: string, step: string): Link =>
    routeLink(basePath, 'execute', { caseId, step }),
  journal: (caseId: string, query = ''): Link =>
    routeLink(basePath, 'journal', { caseId }, query),
})

/** The link builders for one base path — built once per payload, passed down. */
type LinkSet = ReturnType<typeof links>

const toEntry = (
  record: CaseAffordances,
  affordance: Affordance,
  context: ContractContext,
  link: LinkSet,
): AffordanceEntry => {
  const metadata = context.metadataFor(record.caseTypeName, affordance.step)
  return {
    step: affordance.step,
    ...(affordance.scopeKey !== undefined && { scopeKey: affordance.scopeKey }),
    title: metadata.title,
    description: metadata.description,
    input: context.describeStep(record.caseTypeName, affordance.step),
    links: {
      execute: link.execute(record.caseId, affordance.step),
      explain: link.explain(
        record.caseId,
        affordance.step,
        affordance.scopeKey,
      ),
    },
  }
}

const toBlockedEntry = (
  record: CaseAffordances,
  blocked: BlockedStep,
  context: ContractContext,
  link: LinkSet,
): BlockedEntry => {
  const metadata = context.metadataFor(record.caseTypeName, blocked.step)
  return {
    step: blocked.step,
    ...(blocked.scopeKey !== undefined && { scopeKey: blocked.scopeKey }),
    title: metadata.title,
    description: metadata.description,
    possible: blocked.possible,
    permitted: blocked.permitted,
    unmet: visibleConditions(blocked.unmet, context.visibility),
    links: {
      explain: link.explain(record.caseId, blocked.step, blocked.scopeKey),
    },
  }
}

/**
 * Serialize an affordance record as the contract's payload. Which entries
 * the caller may see at all — notably other actors' blocked tracks — is the
 * audience module's decision, asked for up front; this function only
 * translates shape.
 */
export const toAffordancePayload = (
  affordances: CaseAffordances,
  context: ContractContext,
): AffordancePayload => {
  const visible = visibleAffordances(affordances, context.visibility)
  const link = links(context.basePath)
  return {
    contract: CONTRACT,
    case: {
      id: visible.caseId,
      type: visible.caseTypeName,
      asOf: visible.asOf,
      endedAt: visible.endedAt,
    },
    affordances: visible.affordances.map((affordance) =>
      toEntry(visible, affordance, context, link),
    ),
    blocked: visible.blocked.map((entry) =>
      toBlockedEntry(visible, entry, context, link),
    ),
    links: {
      self: link.affordances(visible.caseId),
      journal: link.journal(visible.caseId),
    },
  }
}

/**
 * The remaining leaf translations, spelled field by field for the same
 * reason the condition mapper in `audience.ts` is: core's records and the
 * contract's payloads are structurally identical today, and an explicit map
 * is what keeps a field core grows from silently reaching the wire.
 */
const toPatchOpPayload = (op: PatchOp): PatchOpPayload =>
  op.op === 'remove'
    ? { op: 'remove', path: op.path }
    : { op: op.op, path: op.path, value: op.value }

const toDeltaPayload = (delta: StateDelta): StateDeltaPayload =>
  delta.map(toPatchOpPayload)

const toEventPayload = (event: ExternalEvent): ExternalEventPayload => ({
  system: event.system,
  externalId: event.externalId,
  type: event.type,
  ...(event.eventId !== undefined && { eventId: event.eventId }),
  ...(event.payload !== undefined && { payload: event.payload }),
  ...(event.step !== undefined && { step: event.step }),
  ...(event.idempotencyKey !== undefined && {
    idempotencyKey: event.idempotencyKey,
  }),
  ...(event.occurredAt !== undefined && { occurredAt: event.occurredAt }),
})

/**
 * One committed Execution as the wire carries it. Deliberately not the
 * {@link ExecutionResult}: that record carries the committed Case State and
 * the full claim-time guard evaluation, and neither belongs on the wire —
 * state is deliberately absent from this contract everywhere, and the guard
 * record is the journal's to serve, filtered for the audience there.
 */
const toExecutionDescriptor = (
  result: ExecutionResult,
): ExecutionDescriptor => ({
  executionId: result.executionId,
  caseId: result.caseId,
  caseType: result.caseTypeName,
  step: result.step,
  scopeKey: result.scopeKey ?? null,
  attempts: result.attempts,
  seq: result.seq,
  delta: toDeltaPayload(result.delta),
  dormancy: result.dormancy,
  endedAt: result.endedAt,
  claimedAt: result.claimedAt,
  committedAt: result.committedAt,
})

export const toExecutionPayload = (
  result: ExecutionResult,
  context: ContractContext,
): ExecutionPayload => {
  const link = links(context.basePath)
  return {
    contract: CONTRACT,
    execution: toExecutionDescriptor(result),
    links: {
      affordances: link.affordances(result.caseId),
      journal: link.journal(
        result.caseId,
        `?executionId=${encode(result.executionId)}`,
      ),
    },
  }
}

export const toExplanationPayload = (
  explanation: AffordanceExplanation,
  context: ContractContext,
): ExplanationPayload => ({
  contract: CONTRACT,
  case: {
    id: explanation.caseId,
    type: explanation.caseTypeName,
    asOf: explanation.evaluation.asOf,
    endedAt: explanation.endedAt,
  },
  step: explanation.step,
  scopeKey: explanation.scopeKey ?? null,
  ...context.metadataFor(explanation.caseTypeName, explanation.step),
  available: explanation.evaluation.available,
  possible: explanation.evaluation.possible,
  permitted: explanation.evaluation.permitted,
  // The same rule as `blocked[]`: an explanation is the most detailed read
  // surface — the easiest place to leak a permits rule — so it is filtered
  // exactly like everything else.
  conditions: visibleConditions(
    explanation.evaluation.conditions,
    context.visibility,
  ),
  links: {
    affordances: links(context.basePath).affordances(explanation.caseId),
  },
})

const toJournalEntryPayload = (
  entry: JournalEntry,
  visibility: Visibility,
): JournalEntryPayload => {
  // The audience decides what survives — the guard's filtering and whether
  // the evidence state is present at all; this function only maps shape.
  const visible = visibleJournalEntry(entry, visibility)
  return {
    ordinal: visible.ordinal,
    id: visible.id,
    caseId: visible.caseId,
    executionId: visible.executionId,
    entry: visible.entry,
    attempt: visible.attempt,
    step: visible.step,
    scopeKey: visible.scopeKey,
    actor: visible.actor,
    input: visible.input,
    asOf: visible.asOf,
    guard: visible.guard,
    ...('state' in visible && { state: visible.state }),
    delta: visible.delta === null ? null : toDeltaPayload(visible.delta),
    dormancy: visible.dormancy,
    error: visible.error,
    recordedAt: visible.recordedAt,
  }
}

/** Serialize journal entries — a read surface like any other, filtered like any other. */
export const toJournalPayload = (
  entries: readonly JournalEntry[],
  context: ContractContext,
): JournalPayload => ({
  contract: CONTRACT,
  entries: entries.map((entry) =>
    toJournalEntryPayload(entry, context.visibility),
  ),
})

/** Serialize one delivery's outcome. The Execution, when there is one, is the wire's descriptor — never the record. */
export const toIngestionPayload = (
  result: IngestionResult,
): IngestionPayload => ({
  contract: CONTRACT,
  ingestion: {
    id: result.id,
    status: result.status,
    system: result.system,
    externalId: result.externalId,
    idempotencyKey: result.idempotencyKey,
    correlation:
      result.correlation === null
        ? null
        : {
            system: result.correlation.system,
            externalId: result.correlation.externalId,
            caseId: result.correlation.caseId,
            scopeKey: result.correlation.scopeKey,
            step: result.correlation.step,
          },
    execution:
      result.execution === null
        ? null
        : toExecutionDescriptor(result.execution),
    reason: result.reason,
    detail: result.detail,
    receivedAt: result.receivedAt,
  },
})

const toDeadLetterEntry = (letter: DeadLetter): DeadLetterEntry => ({
  id: letter.id,
  system: letter.system,
  externalId: letter.externalId,
  type: letter.type,
  idempotencyKey: letter.idempotencyKey,
  caseId: letter.caseId,
  scopeKey: letter.scopeKey,
  step: letter.step,
  reason: letter.reason,
  detail: letter.detail,
  event: toEventPayload(letter.event),
  receivedAt: letter.receivedAt,
})

/** Serialize the dead-letter surface — an operator's read; hosts mount it accordingly. */
export const toDeadLettersPayload = (
  letters: readonly DeadLetter[],
): DeadLettersPayload => ({
  contract: CONTRACT,
  deadLetters: letters.map(toDeadLetterEntry),
})

export const toErrorPayload = (
  error: string,
  message: string,
  extra: Record<string, unknown> = {},
): ErrorPayload => ({ contract: CONTRACT, error, message, ...extra })

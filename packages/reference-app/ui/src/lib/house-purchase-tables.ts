/**
 * The pure half of the sanctioned case-type leak (see `house-purchase.ts`
 * for the charter): the tables that deliberately restate knowledge the wire
 * will not carry, split into a leaf module — one that imports nothing: no
 * dependencies, no aliases — so the server-side test suite can import them and pin
 * every key against the real step definitions. A table that restates
 * definitions can drift from them silently; those membership tests exist to
 * catch exactly that.
 *
 * What stays here is the *irreducible* client-side knowledge:
 * - who normally acts (`STEP_ACTORS`) — the payload never says, because
 *   `permits` results are deliberately invisible on the wire;
 * - which unmet conditions mean "already happened" (`DONE_WHEN_UNMET`) —
 *   once-only is this app's semantics, not a framework concept;
 * - editorial content (`INTRO`, `WORLD_LABELS`).
 * Step labels are NOT here: the wire carries each entry's `title`, so live
 * surfaces read the payload and only this static content spells out labels.
 */

/* Who normally takes each step. Steps absent here get no hint badge; the
 * payload itself never says who may act (permits are deliberately
 * invisible on the wire). */
export type ActorKind = 'organizer' | 'buyer' | 'escrow-officer' | 'external'

export const STEP_ACTORS: Record<string, ActorKind> = {
  'accept-offer': 'organizer',
  'obtain-inspection-report': 'organizer',
  'open-escrow': 'organizer',
  'record-escrow-account': 'external',
  'invite-buyer': 'organizer',
  'record-commitment': 'buyer',
  'start-verification': 'organizer',
  'record-verification-result': 'external',
  'escalate-verification': 'escrow-officer',
  'clear-enhanced-review': 'escrow-officer',
  'send-agreement': 'organizer',
  'record-signature': 'external',
  'issue-funding-call': 'organizer',
  'record-wire': 'external',
  'accept-short-wire': 'organizer',
  'refund-over-wire': 'escrow-officer',
  'return-wire': 'escrow-officer',
  'close-purchase': 'organizer',
  'record-deed': 'organizer',
}

const ACTOR_WORDS: Record<ActorKind, string> = {
  organizer: 'the organizer',
  buyer: 'the buyer themselves',
  'escrow-officer': 'the escrow officer',
  external: 'an external system — deliver its answer below',
}

export const actorHint = (
  step: string,
): { kind: ActorKind; words: string } | null => {
  const kind = STEP_ACTORS[step]
  return kind ? { kind, words: ACTOR_WORDS[kind] } : null
}

/* Which unmet conditions mean "already happened" rather than "still
 * waiting". These are this case type's own once-only guards — each states
 * "my effect is not in state yet", so unmet means the step already ran —
 * plus `purchaseOpen`: once the purchase has closed, everything it blocks
 * is past, not pending. A blocked step whose every unmet condition is on
 * this list renders as done (a check), not as waiting (an amber dot). */
export const DONE_WHEN_UNMET = new Set([
  'offerNotYetAccepted',
  'noInspectionReportYet',
  'escrowNotYetApplied',
  'notYetCalled',
  'notRecorded',
  'purchaseOpen',
])

export const blockedBecauseDone = (entry: {
  unmet: readonly { name: string }[]
}): boolean =>
  entry.unmet.length > 0 &&
  entry.unmet.every((condition) => DONE_WHEN_UNMET.has(condition.name))

/* How the outside world's pending answers read as sentences. Fallback:
 * "system answers: type", so an unknown provider still gets a button. */
export const WORLD_LABELS: Record<string, string> = {
  'escrow/account.opened': 'The escrow company opens the account',
  'verify/check.completed': 'The identity check completes',
  'esign/envelope.completed': 'The signed agreement comes back',
  'escrow/wire.received': 'A wire lands in the escrow account',
}

export const worldLabel = (event: { system: string; type: string }) =>
  WORLD_LABELS[`${event.system}/${event.type}`] ??
  `${event.system} answers: ${event.type}`

/* The newcomer intro page's content: what the demo is, the first move, and
 * the example actor×step swimlane. The page (`/intro`) renders whatever
 * this says; delete it and the console header simply drops the link. The
 * swimlane is deliberately static — an example at a glance, its labels
 * editorial copy rather than values from the wire — and the cross-actor
 * behavior itself shows in the live cast strip, not in this picture. */
export const INTRO = {
  title: 'A group house purchase, as affordances',
  paragraphs: [
    'This console drives one case type — a group house purchase — through the affordance contract. At any moment the server computes what each actor could take next, and the page renders exactly that answer. No flowchart is coded anywhere: every card is the reply to "what can this persona do right now?", and the order you experience is a consequence of guarded steps meeting facts.',
    'Affordances are computed per actor. The cast strip at the top of the console asks the same case state once per persona and shows every answer side by side — the organizer, the escrow officer, and each invited buyer hold different cards at the same moment. Clicking a row acts as that persona.',
    "First move: act as the organizer — accept the offer, invite a buyer. Then hop to that buyer to commit funds (nobody else can, the organizer included) and watch every row recompute. The outside world — identity checks, e-sign envelopes, wires — answers on your click in the console's world panel, exactly as webhooks would in production.",
    'One name lever steers the verification mock: a buyer named "… (hit)" comes back flagged and lands in review, so the escrow officer can escalate and clear enhanced review on the spot.',
  ],
  /** Rough left-to-right phases; each step renders in its actor's lane. */
  phases: [
    {
      name: 'Set up',
      steps: [
        { step: 'accept-offer', label: 'Seller accepted our offer' },
        {
          step: 'obtain-inspection-report',
          label: 'Obtain the inspection report',
        },
        { step: 'open-escrow', label: 'Open escrow' },
        { step: 'record-escrow-account', label: 'Record the escrow account' },
      ],
    },
    {
      name: 'Buyers',
      steps: [
        { step: 'invite-buyer', label: 'Invite a buyer' },
        { step: 'record-commitment', label: 'Commit funds' },
      ],
    },
    {
      name: 'Verification',
      steps: [
        { step: 'start-verification', label: 'Start identity verification' },
        {
          step: 'record-verification-result',
          label: 'Record verification result',
        },
        {
          step: 'escalate-verification',
          label: 'Escalate a stalled verification',
        },
        { step: 'clear-enhanced-review', label: 'Clear enhanced review' },
      ],
    },
    {
      name: 'Agreement',
      steps: [
        { step: 'send-agreement', label: 'Send the purchase agreement' },
        { step: 'record-signature', label: 'Record a signature' },
      ],
    },
    {
      name: 'Funding',
      steps: [
        { step: 'issue-funding-call', label: 'Issue the funding call' },
        { step: 'record-wire', label: 'Record an incoming wire' },
        { step: 'accept-short-wire', label: 'Accept a short wire' },
        { step: 'refund-over-wire', label: 'Refund an over-payment' },
        { step: 'return-wire', label: 'Return a wrong-account wire' },
      ],
    },
    {
      name: 'Close',
      steps: [
        { step: 'close-purchase', label: 'Close the purchase' },
        { step: 'record-deed', label: 'Record the deed' },
      ],
    },
  ],
  /** Exception paths — rendered dashed in the swimlane. */
  exceptions: [
    'escalate-verification',
    'clear-enhanced-review',
    'accept-short-wire',
    'refund-over-wire',
    'return-wire',
  ],
  lanes: [
    { kind: 'organizer', label: 'The organizer' },
    { kind: 'buyer', label: 'The buyer' },
    { kind: 'escrow-officer', label: 'The escrow officer' },
    { kind: 'external', label: 'External systems' },
  ] as { kind: ActorKind; label: string }[],
}

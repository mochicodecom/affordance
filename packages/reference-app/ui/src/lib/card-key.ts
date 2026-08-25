/**
 * One affordance's identity on this page: its step name and scope key,
 * joined as `step|scopeKey` (empty scope for a case-wide step). Every
 * surface that keys a card, an error, or a de-duplicated row by affordance
 * uses this one function, so the identities can never disagree.
 */
export const cardKey = (entry: { step: string; scopeKey?: string }): string =>
  `${entry.step}|${entry.scopeKey ?? ''}`

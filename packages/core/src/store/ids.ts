import { randomUUID } from 'node:crypto'

/**
 * The kinds of id the framework mints. One entry per entity that gets an
 * id at runtime.
 */
export type IdKind = 'case' | 'execution' | 'journal' | 'correlation' | 'event'

/**
 * Mint a typed id: `kind:uuid`.
 *
 * Every framework-generated id carries its kind, so an id is
 * self-describing wherever it travels — a log line, a journal row's
 * `cause`, a correlation, a support ticket. The columns holding them are
 * `text`; nothing anywhere parses the id back apart — the prefix is for
 * humans, and equality is the only operation ids support.
 */
export const mintId = (kind: IdKind): string => `${kind}:${randomUUID()}`

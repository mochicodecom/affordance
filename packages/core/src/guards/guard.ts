/**
 * The guard model.
 *
 * A guard is two flat AND-maps of named conditions — a map is satisfied
 * only when every entry is: `requires` (case conditions — is this step
 * possible on this case?) and `permits` (actor conditions — is this actor
 * permitted to take it?). The algebra is
 * deliberately small: a map value is a plain condition or exactly one level
 * of named `anyOf` group. No nested and/or trees — the type of an `anyOf`
 * arm makes deeper nesting inexpressible.
 */

import type { Condition } from './condition.js'

/**
 * What may sit inside an `anyOf` group: a plain condition. Never another
 * `anyOf` — the algebra allows exactly one level of grouping, and this type
 * is what enforces it.
 */
export type AnyOfArm<TState, TActor = unknown> = Condition<TState, TActor>

/**
 * A named disjunction within a guard's AND-map: the group is satisfied when
 * at least one arm is. The group is named by its key in the map; each arm is
 * named by its key in `arms`, and every arm is always evaluated and reported
 * individually in the evaluation record.
 */
export interface AnyOfGroup<TState, TActor = unknown> {
  readonly kind: 'anyOf'
  readonly arms: Readonly<Record<string, AnyOfArm<TState, TActor>>>
}

/**
 * Declare a named disjunction: satisfied when at least one arm is.
 *
 * ```ts
 * requires: {
 *   financing: anyOf({
 *     preApproved:  s => s.buyer?.preApproved ?? false,
 *     proofOfFunds: s => s.buyer?.proofOfFunds ?? false,
 *   }),
 * }
 * ```
 *
 * Arms are plain conditions; nesting another `anyOf` is a type error (one
 * level only). Throws at definition time on an empty or malformed arms map —
 * a guard definition bug should fail the deploy, not an evaluation.
 */
export const anyOf = <TState, TActor = unknown>(
  arms: Readonly<Record<string, AnyOfArm<TState, TActor>>>,
): AnyOfGroup<TState, TActor> => {
  const names = Object.keys(arms ?? {})
  if (names.length === 0) {
    throw new TypeError('anyOf(arms): at least one named arm is required')
  }
  for (const name of names) {
    const arm: unknown = arms[name]
    if (typeof arm !== 'function') {
      throw new TypeError(
        `anyOf(arms): arm '${name}' must be a condition function — nested anyOf groups are not part of the guard algebra`,
      )
    }
  }
  return { kind: 'anyOf', arms: { ...arms } }
}

/**
 * Anything that may sit under a name in a guard section: a plain condition
 * or one `anyOf` group.
 */
export type ConditionMapEntry<TState, TActor = unknown> =
  | Condition<TState, TActor>
  | AnyOfGroup<TState, TActor>

/**
 * A flat AND-map of named conditions: the section is satisfied when every
 * entry is. An empty or absent map is vacuously satisfied. Entry names are
 * the unit of explainability — they surface verbatim in evaluation records,
 * `explain`, and the journal.
 */
export type ConditionMap<TState, TActor = unknown> = Readonly<
  Record<string, ConditionMapEntry<TState, TActor>>
>

/** The two sections of a guard: `requires` (case) and `permits` (actor). */
export type GuardSection = 'requires' | 'permits'

/**
 * A step's guard: the full set of named conditions under which the step is
 * available (CONTEXT.md).
 *
 * - `requires` — case conditions. When one fails, the step is **not
 *   possible** on this case, for anyone.
 * - `permits` — actor conditions. When one fails (and `requires` holds), the
 *   step is possible but **not permitted for this actor**.
 *
 * The two sections evaluate identically; the split exists so evaluation can
 * mechanically distinguish those two answers. An omitted section is
 * vacuously satisfied.
 */
export interface Guard<TState, TActor = unknown> {
  readonly requires?: ConditionMap<TState, TActor>
  readonly permits?: ConditionMap<TState, TActor>
}

/**
 * The stable address of one condition within a guard: `requires.escrowReady`,
 * or `requires.financing.preApproved` for an arm of an `anyOf` group.
 *
 * Human-legible and unique within a guard, which is why a refusal's list of
 * unmet conditions names each condition by it.
 */
export const conditionAddress = (
  section: GuardSection,
  name: string,
  arm?: string,
): string =>
  arm === undefined ? `${section}.${name}` : `${section}.${name}.${arm}`

/**
 * What kind of thing sits under a name in a guard section. `'unknown'` is an
 * entry that is neither: a definition bug, which `step()` rejects
 * at construction and evaluation absorbs into a failed condition — never a
 * crash.
 */
export type GuardEntryKind = 'condition' | 'anyOf' | 'unknown'

const entryKind = (entry: unknown): GuardEntryKind => {
  if (typeof entry === 'function') return 'condition'
  if (typeof entry !== 'object' || entry === null) return 'unknown'
  if ((entry as { kind?: unknown }).kind === 'anyOf') return 'anyOf'
  return 'unknown'
}

/** One arm of an `anyOf` group, located, classified and addressed. */
export interface GuardArm<TState, TActor = unknown> {
  readonly section: GuardSection
  /** The *group's* name in its section map. */
  readonly name: string
  /** This arm's name within the group. */
  readonly arm: string
  /** Never `'anyOf'` — the algebra allows exactly one level of grouping. */
  readonly kind: 'condition' | 'unknown'
  readonly entry: AnyOfArm<TState, TActor>
  /** `requires.financing.preApproved` — see {@link conditionAddress}. */
  readonly address: string
}

/** One named entry of a guard section, located, classified and addressed. */
export interface GuardEntry<TState, TActor = unknown> {
  readonly section: GuardSection
  readonly name: string
  readonly kind: GuardEntryKind
  readonly entry: ConditionMapEntry<TState, TActor>
  /** `requires.escrowReady` — see {@link conditionAddress}. */
  readonly address: string
  /** The group's arms when `kind` is `'anyOf'`; empty otherwise. */
  readonly arms: readonly GuardArm<TState, TActor>[]
}

const walkedEntries = new WeakMap<object, readonly GuardEntry<never, never>[]>()

/**
 * Walk a guard: every named entry of both sections, in declaration order
 * (`requires` first), classified and addressed, with `anyOf` arms attached.
 *
 * **This is the only place that knows the guard's shape.** Evaluation
 * (`evaluateGuard`) and definition-time validation (`step()`) are maps and
 * filters over this — so the algebra grows in one
 * edit instead of two, and a condition's address is spelled once instead
 * of twice.
 *
 * Total: a malformed entry is classified `'unknown'` and reported — the
 * walk itself never throws — because every consumer's own totality rests on
 * this walk.
 *
 * Cached per guard object: a guard is constructed once (by `step()`, or by
 * hand in a test) and never mutated afterwards — every map on it is declared
 * readonly — so the walk is a pure function of the guard's identity.
 * Evaluation calls this on every affordance computation, and the cache makes
 * each call after the first a lookup instead of a re-walk.
 */
export const guardEntries = <TState, TActor = unknown>(
  guard: Guard<TState, TActor>,
): readonly GuardEntry<TState, TActor>[] => {
  const cached = walkedEntries.get(guard)
  if (cached !== undefined) {
    return cached as readonly GuardEntry<TState, TActor>[]
  }
  const entries: GuardEntry<TState, TActor>[] = []
  for (const section of ['requires', 'permits'] as const) {
    for (const [name, entry] of Object.entries(guard[section] ?? {})) {
      const kind = entryKind(entry)
      const arms: GuardArm<TState, TActor>[] = []
      if (kind === 'anyOf') {
        const group = entry as AnyOfGroup<TState, TActor>
        for (const [arm, armEntry] of Object.entries(group.arms ?? {})) {
          const armKind = entryKind(armEntry)
          arms.push({
            section,
            name,
            arm,
            // A nested group is inexpressible in the type and meaningless
            // here, so it is classified as a malformed arm.
            kind: armKind === 'anyOf' ? 'unknown' : armKind,
            entry: armEntry,
            address: conditionAddress(section, name, arm),
          })
        }
      }
      entries.push({
        section,
        name,
        kind,
        entry,
        address: conditionAddress(section, name),
        arms,
      })
    }
  }
  walkedEntries.set(guard, entries)
  return entries
}

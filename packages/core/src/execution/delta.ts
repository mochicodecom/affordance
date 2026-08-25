/**
 * State deltas — what an Execution changed, as RFC 6902 JSON Patch.
 *
 * Every committed Execution journals the delta from the previous Case State
 * to the next. A standard patch format is deliberate: the delta is
 * an audit artifact read by people and machines that are not this library, so
 * it should not need a bespoke decoder. Paths are RFC 6901 JSON Pointers.
 *
 * Pure and total over JSON values — no clock, no I/O, no schema knowledge.
 */

/** One JSON Patch operation. */
export type PatchOp =
  | { readonly op: 'add'; readonly path: string; readonly value: unknown }
  | { readonly op: 'remove'; readonly path: string }
  | { readonly op: 'replace'; readonly path: string; readonly value: unknown }

/** An Execution's state delta: the ops taking the previous Case State to the next. */
export type StateDelta = readonly PatchOp[]

/** RFC 6901 escaping: `~` → `~0`, `/` → `~1`. */
const escapeToken = (token: string): string =>
  token.replace(/~/g, '~0').replace(/\//g, '~1')

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Structural equality over JSON values. `undefined` never appears in a
 * document that round-tripped through jsonb, but a handler's return value has
 * not round-tripped yet, so it is compared as-is.
 */
export const jsonEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length &&
      a.every((item, index) => jsonEqual(item, b[index]))
    )
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a)
    if (keys.length !== Object.keys(b).length) return false
    return keys.every(
      (key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]),
    )
  }
  return false
}

const diffInto = (
  ops: PatchOp[],
  path: string,
  previous: unknown,
  next: unknown,
): void => {
  if (previous === next) return

  if (Array.isArray(previous) && Array.isArray(next)) {
    const shared = Math.min(previous.length, next.length)
    for (let index = 0; index < shared; index += 1) {
      diffInto(ops, `${path}/${index}`, previous[index], next[index])
    }
    // Appends first, then trailing removals from the end backwards, so every
    // index a `remove` names is still valid when that op is applied.
    for (let index = previous.length; index < next.length; index += 1) {
      ops.push({ op: 'add', path: `${path}/-`, value: next[index] })
    }
    for (let index = previous.length - 1; index >= next.length; index -= 1) {
      ops.push({ op: 'remove', path: `${path}/${index}` })
    }
    return
  }

  if (isPlainObject(previous) && isPlainObject(next)) {
    for (const key of Object.keys(previous)) {
      const child = `${path}/${escapeToken(key)}`
      if (!Object.hasOwn(next, key)) ops.push({ op: 'remove', path: child })
      else diffInto(ops, child, previous[key], next[key])
    }
    for (const key of Object.keys(next)) {
      if (!Object.hasOwn(previous, key)) {
        ops.push({
          op: 'add',
          path: `${path}/${escapeToken(key)}`,
          value: next[key],
        })
      }
    }
    return
  }

  // Differing types, or two differing scalars: the whole node is replaced.
  // An equal pair never lands here — identical references return at the top,
  // equal scalars are identical, and matching containers recurse above
  // (a deeply-equal subtree just emits no ops) — so no deep comparison is
  // needed on the way down.
  ops.push({ op: 'replace', path, value: next })
}

/**
 * The delta from one Case State document to the next. An Execution that
 * changed nothing yields an empty delta — a real and unremarkable outcome
 * (a handler whose only effect was external, or a no-op retry landing).
 *
 * Arrays are diffed positionally: element *i* against element *i*, then
 * appends and trailing removals. Case State collections are keyed by the
 * app's own identifiers (scope keys), so a positional diff of a reordered
 * collection is verbose but never wrong.
 */
export const diffState = (previous: unknown, next: unknown): StateDelta => {
  const ops: PatchOp[] = []
  diffInto(ops, '', previous, next)
  return ops
}

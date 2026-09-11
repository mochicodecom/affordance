/** Core's JSON storage format for complete documents and journal evidence. */
import SuperJSON from 'superjson'

const codec = new SuperJSON()

// SuperJSON reserves these property names. Encode such objects as entries so
// ordinary JSON keys remain data, without assigning through a prototype setter.
codec.registerCustom(
  {
    isApplicable: (value): value is Record<string, unknown> =>
      value !== null &&
      typeof value === 'object' &&
      ['__proto__', 'constructor', 'prototype'].some((key) =>
        Object.hasOwn(value, key),
      ),
    serialize: (value) => {
      const { json, meta } = codec.serialize(Object.entries(value))
      return { json, ...(meta === undefined ? {} : { meta }) }
    },
    deserialize: (value) =>
      Object.fromEntries(codec.deserialize<[string, unknown][]>(value)),
  },
  'affordance-object',
)

/** A complete value plus the metadata needed to restore its runtime types. */
export type SerializedValue = ReturnType<typeof codec.serialize> & {
  readonly version: 1
}

/** A value cannot be recorded without losing information, or a stored document is invalid. */
export class SerializationError extends TypeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SerializationError'
  }
}

/**
 * Copy supported values before passing them to the codec. This rejects silent
 * JSON losses and cycles, and treats repeated references as independent values.
 * Snapshots retain Set iteration order; only diff inputs sort Set members.
 */
const normalize = (
  value: unknown,
  canonicalSets: boolean,
  ancestors = new Set<object>(),
  path = '$',
): unknown => {
  const fail = (reason: string): never => {
    throw new SerializationError(`${path}: ${reason}`)
  }
  if (value === null || value === undefined) return value
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  )
    return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('non-finite numbers are unsupported')
    return value
  }
  if (typeof value !== 'object') return fail(`unsupported ${typeof value}`)
  if (ancestors.has(value)) return fail('cyclic values are unsupported')
  const prototype = Object.getPrototypeOf(value)
  const date = prototype === Date.prototype
  const set = prototype === Set.prototype
  const array = prototype === Array.prototype
  if (
    !date &&
    !set &&
    !array &&
    prototype !== Object.prototype &&
    prototype !== null
  )
    return fail('only plain objects, arrays, Date and Set are supported')

  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === 'symbol') return fail('symbol keys are unsupported')
    if (array && key === 'length') continue
    const descriptor = descriptors[key]!
    if (date || set)
      return fail('custom properties on Date and Set are unsupported')
    if (!descriptor.enumerable || !('value' in descriptor))
      return fail('accessors and non-enumerable properties are unsupported')
    if (
      array &&
      (!/^(0|[1-9]\d*)$/.test(key) ||
        Number(key) >= (value as unknown[]).length)
    )
      return fail('custom array properties are unsupported')
  }
  if (date) {
    const time = Date.prototype.getTime.call(value)
    if (!Number.isFinite(time)) return fail('invalid Date')
    return new Date(time)
  }
  ancestors.add(value)
  try {
    if (set) {
      const members = [...(value as Set<unknown>)].map((member, index) =>
        normalize(member, canonicalSets, ancestors, `${path}[Set:${index}]`),
      )
      if (canonicalSets) {
        const keyed = members.map((member) => ({
          member,
          key: JSON.stringify(codec.serialize(member)),
        }))
        keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        return new Set(keyed.map(({ member }) => member))
      }
      return new Set(members)
    }
    if (array) {
      const result: unknown[] = []
      for (let index = 0; index < (value as unknown[]).length; index += 1) {
        if (!Object.hasOwn(descriptors, index))
          return fail('sparse arrays are unsupported')
        result.push(
          normalize(
            descriptors[index]!.value,
            canonicalSets,
            ancestors,
            `${path}[${index}]`,
          ),
        )
      }
      return result
    }
    const keys = Object.keys(descriptors)
    if (canonicalSets) keys.sort()
    return Object.fromEntries(
      keys.map((key) => [
        key,
        normalize(
          descriptors[key]!.value,
          canonicalSets,
          ancestors,
          `${path}[${JSON.stringify(key)}]`,
        ),
      ]),
    )
  } finally {
    ancestors.delete(value)
  }
}

const encode = (value: unknown, canonicalSets: boolean): SerializedValue => {
  try {
    return { version: 1, ...codec.serialize(normalize(value, canonicalSets)) }
  } catch (cause) {
    if (cause instanceof SerializationError) throw cause
    throw new SerializationError('Could not serialize value', { cause })
  }
}

/** Encode a full snapshot, actor or input. Adapters persist this document as JSON. */
export const serializeValue = (value: unknown): SerializedValue =>
  encode(value, false)

/** Serialize a comparison copy with unordered, structurally compared Set membership. */
export const serializeForDiff = (value: unknown): SerializedValue =>
  encode(value, true)

/** Restore a complete stored document. Callers schema-validate state after decoding. */
export const deserializeValue = (document: unknown): unknown => {
  try {
    if (
      typeof document !== 'object' ||
      document === null ||
      !('version' in document) ||
      document.version !== 1 ||
      !Object.hasOwn(document, 'json')
    )
      throw new SerializationError(
        'Invalid serialized value: expected a version 1 document',
      )
    const restored = codec.deserialize(document as SerializedValue)
    return normalize(restored, false)
  } catch (cause) {
    if (cause instanceof SerializationError) throw cause
    throw new SerializationError('Could not deserialize value', { cause })
  }
}

/** Core's JSON storage format for complete documents and journal evidence. */
import SuperJSON from 'superjson'
import { thrownMessage } from './errors.js'

const codec = new SuperJSON()

// All codec calls, including nested reserved-key documents, use this boundary.
// normalize removes shared object identity; equal bigint primitives still make
// SuperJSON emit references, which are redundant with its per-path type tags.
const serializeDocument = (value: unknown) => {
  const document = codec.serialize(value)
  if (document.meta) delete document.meta.referentialEqualities
  return document
}

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
      const { json, meta } = serializeDocument(Object.entries(value))
      return { json, ...(meta === undefined ? {} : { meta }) }
    },
    deserialize: (value) =>
      Object.fromEntries(codec.deserialize<[string, unknown][]>(value)),
  },
  'affordance-object',
)

/** JSON data produced by core's encoder; numeric values are finite. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | JsonObject

export interface JsonObject {
  readonly [key: string]: JsonValue
}

/** A complete value plus the metadata needed to restore its runtime types. */
export interface SerializedValue {
  readonly version: 1
  readonly json: JsonValue
  readonly meta?: JsonObject
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
 * Snapshots retain Set iteration order. Diff inputs sort object keys and Set
 * members, making comparison independent of either insertion order.
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
          key: JSON.stringify(serializeDocument(member)),
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

const encode = (
  value: unknown,
  canonicalSets: boolean,
  context: string,
): SerializedValue => {
  try {
    // SuperJSON's declaration allows undefined JSON leaves; supported values
    // always encode those as null plus a type tag, as the format tests assert.
    return {
      version: 1,
      ...serializeDocument(normalize(value, canonicalSets)),
    } as SerializedValue
  } catch (cause) {
    throw new SerializationError(
      `Could not encode ${context}: ${thrownMessage(cause)}`,
      { cause },
    )
  }
}

/** Encode a full snapshot, actor or input. Adapters persist this document as JSON. */
export const serializeValue = (
  value: unknown,
  context = 'value',
): SerializedValue => encode(value, false, context)

/** Serialize a comparison copy with unordered, structurally compared Set membership. */
export const serializeForDiff = (
  value: unknown,
  context: string,
): SerializedValue => encode(value, true, context)

/** Restore a complete stored document. Callers schema-validate state after decoding. */
export const deserializeValue = (
  document: unknown,
  context = 'value',
): unknown => {
  try {
    if (
      typeof document !== 'object' ||
      document === null ||
      !('version' in document) ||
      document.version !== 1 ||
      !('json' in document) ||
      !Object.hasOwn(document, 'json')
    )
      throw new SerializationError(
        'Invalid serialized value: expected a version 1 document',
      )
    const restored = codec.deserialize(
      document as Parameters<typeof codec.deserialize>[0],
    )
    return normalize(restored, false)
  } catch (cause) {
    throw new SerializationError(
      `Could not decode ${context}: ${thrownMessage(cause)}`,
      { cause },
    )
  }
}

import { deepStrictEqual } from 'node:assert'
import { describe, expect, it } from 'vitest'
import {
  deserializeValue,
  SerializationError,
  serializeValue,
} from '../../src/storage.js'

const roundTrip = (value: unknown) =>
  deserializeValue(JSON.parse(JSON.stringify(serializeValue(value))))

describe('complete value serialization', () => {
  it('restores nested runtime types and retains Set iteration order without deltas', () => {
    const value = {
      rows: [{ date: new Date(123), amount: 9007199254740993n }],
      members: new Set([new Date(2), new Date(1)]),
      nested: new Set([new Set([2n, 1n]), { date: new Date(3) }]),
    }
    expect(roundTrip(value)).toStrictEqual(value)
    const restored = roundTrip(value) as typeof value
    expect([...restored.members].map(Number)).toEqual([2, 1])
    expect(restored.rows[0]?.date).toBeInstanceOf(Date)
    expect(restored.nested).toBeInstanceOf(Set)
  })

  it.each([
    null,
    undefined,
    true,
    'text',
    42,
    -0,
    [],
    {},
    new Date(0),
    new Set(),
    0n,
  ])('supports a complete document rooted at %s', (value) => {
    expect(roundTrip(value)).toStrictEqual(value)
  })

  it('distinguishes null, present undefined and absent object properties', () => {
    const restored = roundTrip({
      nil: null,
      unset: undefined,
      array: [null, undefined],
    })
    expect(restored).toStrictEqual({
      nil: null,
      unset: undefined,
      array: [null, undefined],
    })
    expect(Object.hasOwn(restored as object, 'unset')).toBe(true)
    expect(Object.hasOwn(restored as object, 'absent')).toBe(false)
    expect(serializeValue(null)).not.toEqual(serializeValue(undefined))
  })

  it('keeps user fields separate from metadata and escapes nested metadata paths', () => {
    const value = {
      version: 1,
      json: { meta: 'user data' },
      meta: { values: 'user data' },
      'a.b': { 'c\\d': new Date(1), 'x/y~': 3n },
    }
    expect(roundTrip(value)).toStrictEqual(value)
  })

  it('preserves reserved JSON property names and their typed descendants as data', () => {
    const value = {
      ...JSON.parse(
        '{"__proto__":{"safe":true},"constructor":"user value","prototype":null}',
      ),
      nested: { constructor: { when: new Date(1), set: new Set([2n, 1n]) } },
    }
    const restored = roundTrip(value) as typeof value
    deepStrictEqual(restored, value)
    expect(Object.hasOwn(restored, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(restored)).toBe(Object.prototype)
    expect(Object.hasOwn(Object.prototype, 'safe')).toBe(false)
  })

  it('copies repeated references as independent values and does not mutate the input', () => {
    const shared = { date: new Date(0) }
    const value = { a: shared, b: shared }
    const restored = roundTrip(value) as typeof value
    expect(restored).toStrictEqual(value)
    expect(restored.a).not.toBe(restored.b)
    restored.a.date.setTime(5)
    expect(value.a.date.getTime()).toBe(0)
    expect(restored.b.date.getTime()).toBe(0)
  })

  it.each([
    () => {},
    Symbol('symbol'),
    new Map(),
    /regexp/,
    new Error('error'),
    new Uint8Array([1]),
    new Date(Number.NaN),
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Object.create({ inherited: 1 }),
    new Array(1),
    Object.assign([], { extra: 1 }),
    Object.assign(new Date(), { extra: 1 }),
    { [Symbol('key')]: 1 },
    Object.defineProperty({}, 'hidden', { value: 1 }),
  ])('rejects unsupported values explicitly: %s', (value) => {
    expect(() => serializeValue({ nested: value })).toThrow(SerializationError)
  })

  it('rejects cycles through containers, including Sets', () => {
    const object: { self?: unknown } = {}
    object.self = object
    const set = new Set<unknown>()
    set.add(set)
    expect(() => serializeValue(object)).toThrow(/cyclic/)
    expect(() => serializeValue(set)).toThrow(/cyclic/)
  })

  it('rejects accessors without invoking them', () => {
    let reads = 0
    const value = {
      get x() {
        reads += 1
        return 1
      },
    }
    expect(() => serializeValue(value)).toThrow(/accessors/)
    expect(reads).toBe(0)
  })

  it.each([
    null,
    {},
    { version: 2, json: {} },
    { version: 1 },
    { version: 1, json: 'bad', meta: { values: ['bigint'], v: 1 } },
    { version: 1, json: 'bad', meta: { values: ['Date'], v: 1 } },
    { version: 1, json: 'bad', meta: { values: ['unknown'], v: 1 } },
  ])('rejects invalid stored documents: %s', (document) => {
    expect(() => deserializeValue(document)).toThrow(SerializationError)
  })
})

import { expectJsonRoundTrips } from '@affordance/testkit'
import { describe, expect, it } from 'vitest'
import { diffState, jsonEqual } from '../../src/execution/delta.js'

describe('diffState', () => {
  it.each([
    ['Date', new Date(0), new Date(1)],
    ['Set', new Set(['a']), new Set(['b'])],
    ['bigint', 1n, 2n],
  ])('records %s changes as JSON-safe evidence', (_name, previous, next) => {
    const delta = diffState({ x: previous }, { x: next })
    expect(delta).not.toEqual([])
    expectJsonRoundTrips(delta)
  })

  it('records the changed typed leaves and keeps the evidence JSON-safe', () => {
    const delta = diffState(
      { nested: { date: new Date(0), members: new Set(['a']), amount: 1n } },
      { nested: { date: new Date(1), members: new Set(['b']), amount: 2n } },
    )
    expect(delta).toEqual([
      { op: 'replace', path: '/json/nested/amount', value: '2' },
      {
        op: 'replace',
        path: '/json/nested/date',
        value: '1970-01-01T00:00:00.001Z',
      },
      { op: 'replace', path: '/json/nested/members/0', value: 'b' },
    ])
    expectJsonRoundTrips(delta)
  })

  it.each([
    ['1970-01-01T00:00:00.000Z', new Date(0), 'Date'],
    ['1', 1n, 'bigint'],
    [['a'], new Set(['a']), 'set'],
    [null, undefined, 'undefined'],
  ])('records metadata-only changes from %s to %s', (previous, next, tag) => {
    const delta = diffState({ x: previous }, { x: next })
    expect(delta).toEqual([
      { op: 'add', path: '/meta', value: { values: { x: [tag] }, v: 1 } },
    ])
    expectJsonRoundTrips(delta)
    expect(diffState({ x: next }, { x: previous })).toEqual([
      { op: 'remove', path: '/meta' },
    ])
  })

  it('compares Set membership structurally, ignoring insertion order at every depth', () => {
    const a = {
      members: new Set<unknown>([
        3n,
        new Date(1),
        { b: 2, a: new Set(['b', 'a']) },
      ]),
    }
    const b = {
      members: new Set<unknown>([
        { a: new Set(['a', 'b']), b: 2 },
        new Date(1),
        3n,
      ]),
    }
    expect(diffState(a, b)).toEqual([])
    expect([...a.members][0]).toBe(3n)
    expect(
      diffState(new Set([{ a: 1 }, { a: 1 }]), new Set([{ a: 1 }])),
    ).not.toEqual([])
    expect(diffState(new Set([1n]), new Set(['1']))).not.toEqual([])
  })

  it('distinguishes removal from null and undefined, and detects unsupported unchanged values', () => {
    expect(diffState({ x: null }, {})).toEqual([
      { op: 'remove', path: '/json/x' },
    ])
    const delta = diffState({}, { x: undefined })
    expect(delta).toEqual([
      { op: 'add', path: '/json/x', value: null },
      {
        op: 'add',
        path: '/meta',
        value: { values: { x: ['undefined'] }, v: 1 },
      },
    ])
    expectJsonRoundTrips(delta)
    const value = { x: () => {} }
    expect(() => diffState(value, value)).toThrow(/unsupported function/)
  })

  it('records typed values under reserved JSON keys without losing their changes', () => {
    const previous = { constructor: new Date(0), prototype: new Set([2n, 1n]) }
    expect(
      diffState(previous, { ...previous, prototype: new Set([1n, 2n]) }),
    ).toEqual([])
    const delta = diffState(previous, { ...previous, constructor: new Date(1) })
    expect(delta).toEqual([
      {
        op: 'replace',
        path: '/json/json/0/1',
        value: '1970-01-01T00:00:00.001Z',
      },
    ])
    expectJsonRoundTrips(delta)
  })

  it('records only the changed bigint even when another field held the same value', () => {
    expect(
      diffState({ total: 5n, count: 5n }, { total: 6n, count: 5n }),
    ).toEqual([{ op: 'replace', path: '/json/total', value: '6' }])
    expect(
      diffState(
        { constructor: { a: 5n, b: 5n } },
        { constructor: { a: 6n, b: 5n } },
      ),
    ).toEqual([{ op: 'replace', path: '/json/json/0/1/a', value: '6' }])
  })

  it('orders existing object keys deterministically before additions', () => {
    expect(
      diffState({ z: 0, b: 0, 10: 0, 2: 0 }, { 2: 1, 10: 1, b: 1, z: 1, a: 1 }),
    ).toEqual([
      { op: 'replace', path: '/json/2', value: 1 },
      { op: 'replace', path: '/json/10', value: 1 },
      { op: 'replace', path: '/json/b', value: 1 },
      { op: 'replace', path: '/json/z', value: 1 },
      { op: 'add', path: '/json/a', value: 1 },
    ])
  })

  it('is empty when nothing changed', () => {
    const state = {
      purchase: { address: '12 Mochi Lane', target: 1 },
      buyers: [{ id: 'buyer_a' }],
    }
    expect(diffState(state, structuredClone(state))).toEqual([])
  })

  it('names the deepest changed leaf, not the branch above it', () => {
    const previous = {
      purchase: { address: '12 Mochi Lane', termsVersion: 1 },
      split: { confirmed: false },
    }
    const next = {
      purchase: { address: '12 Mochi Lane', termsVersion: 2 },
      split: { confirmed: false },
    }
    expect(diffState(previous, next)).toEqual([
      { op: 'replace', path: '/json/purchase/termsVersion', value: 2 },
    ])
  })

  it('adds and removes object keys', () => {
    expect(diffState({ a: 1, b: 2 }, { a: 1, c: 3 })).toEqual([
      { op: 'remove', path: '/json/b' },
      { op: 'add', path: '/json/c', value: 3 },
    ])
  })

  it('diffs arrays positionally and appends with the /- pointer', () => {
    const previous = { buyers: [{ id: 'buyer_a', committed: 0 }] }
    const next = {
      buyers: [
        { id: 'buyer_a', committed: 500 },
        { id: 'buyer_b', committed: 400 },
      ],
    }
    expect(diffState(previous, next)).toEqual([
      { op: 'replace', path: '/json/buyers/0/committed', value: 500 },
      {
        op: 'add',
        path: '/json/buyers/-',
        value: { id: 'buyer_b', committed: 400 },
      },
    ])
  })

  it('removes trailing array elements from the end backwards, so each index is still valid', () => {
    expect(diffState({ xs: [1, 2, 3] }, { xs: [1] })).toEqual([
      { op: 'remove', path: '/json/xs/2' },
      { op: 'remove', path: '/json/xs/1' },
    ])
  })

  it('replaces a whole node when its type changes', () => {
    expect(diffState({ escrow: { status: 'open' } }, { escrow: null })).toEqual(
      [{ op: 'replace', path: '/json/escrow', value: null }],
    )
    expect(diffState({ xs: [1] }, { xs: { 0: 1 } })).toEqual([
      { op: 'replace', path: '/json/xs', value: { 0: 1 } },
    ])
  })

  it('escapes RFC 6901 pointer characters in keys', () => {
    expect(diffState({ 'a/b': 1, 'c~d': 1 }, { 'a/b': 2, 'c~d': 2 })).toEqual([
      { op: 'replace', path: '/json/a~1b', value: 2 },
      { op: 'replace', path: '/json/c~0d', value: 2 },
    ])
  })

  it('replaces at the root pointer when the whole document changed shape', () => {
    expect(diffState({ a: 1 }, 'gone')).toEqual([
      { op: 'replace', path: '/json', value: 'gone' },
    ])
  })

  it('is JSON-serializable — the delta is journaled verbatim', () => {
    const delta = diffState({ a: 1, b: [1, 2] }, { a: 2, b: [1], c: null })
    expectJsonRoundTrips(delta)
  })
})

describe('jsonEqual', () => {
  it('compares structurally, not by reference', () => {
    expect(jsonEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
    expect(jsonEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(jsonEqual([1, 2], [2, 1])).toBe(false)
    expect(jsonEqual(null, undefined)).toBe(false)
    expect(jsonEqual(0, '0')).toBe(false)
  })
})

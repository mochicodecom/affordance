import { expectJsonRoundTrips } from '@affordance/testkit'
import { describe, expect, it } from 'vitest'
import { diffState, jsonEqual } from '../../src/execution/delta.js'

describe('diffState', () => {
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
      { op: 'replace', path: '/purchase/termsVersion', value: 2 },
    ])
  })

  it('adds and removes object keys', () => {
    expect(diffState({ a: 1, b: 2 }, { a: 1, c: 3 })).toEqual([
      { op: 'remove', path: '/b' },
      { op: 'add', path: '/c', value: 3 },
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
      { op: 'replace', path: '/buyers/0/committed', value: 500 },
      {
        op: 'add',
        path: '/buyers/-',
        value: { id: 'buyer_b', committed: 400 },
      },
    ])
  })

  it('removes trailing array elements from the end backwards, so each index is still valid', () => {
    expect(diffState({ xs: [1, 2, 3] }, { xs: [1] })).toEqual([
      { op: 'remove', path: '/xs/2' },
      { op: 'remove', path: '/xs/1' },
    ])
  })

  it('replaces a whole node when its type changes', () => {
    expect(diffState({ escrow: { status: 'open' } }, { escrow: null })).toEqual(
      [{ op: 'replace', path: '/escrow', value: null }],
    )
    expect(diffState({ xs: [1] }, { xs: { 0: 1 } })).toEqual([
      { op: 'replace', path: '/xs', value: { 0: 1 } },
    ])
  })

  it('escapes RFC 6901 pointer characters in keys', () => {
    expect(diffState({ 'a/b': 1, 'c~d': 1 }, { 'a/b': 2, 'c~d': 2 })).toEqual([
      { op: 'replace', path: '/a~1b', value: 2 },
      { op: 'replace', path: '/c~0d', value: 2 },
    ])
  })

  it('replaces at the root pointer when the whole document changed shape', () => {
    expect(diffState({ a: 1 }, 'gone')).toEqual([
      { op: 'replace', path: '', value: 'gone' },
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

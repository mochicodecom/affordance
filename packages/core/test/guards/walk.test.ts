/**
 * The guard walk, tested against guard literals — no case type, no engine,
 * no database.
 *
 * These used to be reachable only through their consumers: "does `step()`
 * reject a malformed entry" was a `step()` test — a separate setup for one
 * question about one walk. Now the walk has an interface, and the interface
 * is the test surface.
 */

import { describe, expect, it } from 'vitest'
import {
  anyOf,
  conditionAddress,
  type Guard,
  guardEntries,
} from '../../src/guards/index.js'

type State = { flaggedAt?: string; sentAt?: string; approved?: boolean }

const isApproved = (s: State): boolean => s.approved ?? false
const hasSent = (s: State): boolean => (s.sentAt ?? null) !== null
const isFlagged = (s: State): boolean => (s.flaggedAt ?? null) !== null
const isOps = (): boolean => true

const guard: Guard<State> = {
  requires: {
    approved: isApproved,
    flagged: isFlagged,
    timing: anyOf({
      sent: hasSent,
      manual: isApproved,
    }),
  },
  permits: { isOps },
}

describe('guardEntries', () => {
  it('walks both sections in declaration order, requires first', () => {
    expect(guardEntries(guard).map((entry) => entry.address)).toEqual([
      'requires.approved',
      'requires.flagged',
      'requires.timing',
      'permits.isOps',
    ])
  })

  it('classifies every entry, and attaches an anyOf group’s arms', () => {
    const byAddress = new Map(
      guardEntries(guard).map((entry) => [entry.address, entry]),
    )

    expect(byAddress.get('requires.approved')?.kind).toBe('condition')
    expect(byAddress.get('requires.flagged')?.kind).toBe('condition')
    expect(byAddress.get('permits.isOps')?.kind).toBe('condition')

    const group = byAddress.get('requires.timing')
    expect(group?.kind).toBe('anyOf')
    expect(group?.arms.map((arm) => [arm.address, arm.kind])).toEqual([
      ['requires.timing.sent', 'condition'],
      ['requires.timing.manual', 'condition'],
    ])
  })

  it('carries no arms on a non-group entry', () => {
    for (const entry of guardEntries(guard)) {
      if (entry.kind !== 'anyOf') expect(entry.arms).toEqual([])
    }
  })

  it('is empty for an empty guard, and for absent sections', () => {
    expect(guardEntries({})).toEqual([])
    expect(guardEntries({ requires: {} })).toEqual([])
    expect(guardEntries({ permits: { isOps } }).map((e) => e.address)).toEqual([
      'permits.isOps',
    ])
  })

  it('classifies a malformed entry as unknown rather than throwing', () => {
    const broken = { requires: { nonsense: 42 } } as unknown as Guard<State>
    expect(
      guardEntries(broken).map((entry) => [entry.address, entry.kind]),
    ).toEqual([['requires.nonsense', 'unknown']])
  })

  it('classifies a malformed anyOf arm as unknown, and refuses a nested group', () => {
    const broken = {
      requires: {
        group: {
          kind: 'anyOf',
          arms: { bad: 'not a condition', nested: anyOf({ a: isOps }) },
        },
      },
    } as unknown as Guard<State>
    const [group] = guardEntries(broken)
    expect(group?.arms.map((arm) => [arm.arm, arm.kind])).toEqual([
      ['bad', 'unknown'],
      ['nested', 'unknown'],
    ])
  })
})

describe('conditionAddress', () => {
  it('is `section.name`, and `section.name.arm` inside a group', () => {
    expect(conditionAddress('requires', 'flagged')).toBe('requires.flagged')
    expect(conditionAddress('requires', 'timing', 'sent')).toBe(
      'requires.timing.sent',
    )
    expect(conditionAddress('permits', 'isOps')).toBe('permits.isOps')
  })
})

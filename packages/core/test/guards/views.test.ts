/**
 * The evaluation's derived views — the one spelling of "the unmet
 * conditions" and their addresses.
 *
 * The property that matters: every address a view hands out is
 * `conditionAddress`'s spelling, arms included, evaluated from a real
 * guard rather than hand-built records — so a refusal, a blocked entry and
 * `explain` can never disagree about what a condition is called.
 */

import { describe, expect, it } from 'vitest'
import {
  anyOf,
  conditionAddress,
  describeUnmet,
  evaluateGuard,
  type Guard,
  guardEntries,
  unmetAddresses,
  unmetConditions,
} from '../../src/guards/index.js'

type S = { paid: boolean }

const guard: Guard<S, { roles: string[] }> = {
  requires: {
    paid: (s) => s.paid,
    financing: anyOf({
      preApproved: () => ({ ok: false, reason: 'no letter on file' }),
      cashProof: () => false,
    }),
  },
  permits: {
    isOrganizer: (_s, ctx) => ctx.actor.roles.includes('organizer'),
  },
}

const evaluation = evaluateGuard(guard, {
  state: { paid: false },
  actor: { roles: [] },
  asOf: '2026-08-05T00:00:00.000Z',
})

describe('the derived views', () => {
  it('unmetConditions is exactly the failed results, in declaration order', () => {
    expect(unmetConditions(evaluation).map((result) => result.name)).toEqual([
      'paid',
      'financing',
      'isOrganizer',
    ])
  })

  it('every address round-trips through conditionAddress, arms included', () => {
    const walked = new Set(
      guardEntries(guard).flatMap((entry) =>
        entry.kind === 'anyOf'
          ? entry.arms.map((arm) => arm.address)
          : [entry.address],
      ),
    )
    const addresses = unmetAddresses(evaluation).map((unmet) => unmet.address)
    expect(addresses).toEqual([
      conditionAddress('requires', 'paid'),
      conditionAddress('requires', 'financing', 'preApproved'),
      conditionAddress('requires', 'financing', 'cashProof'),
      conditionAddress('permits', 'isOrganizer'),
    ])
    for (const address of addresses) expect(walked).toContain(address)
  })

  it('describeUnmet names the arm, never just the group, and carries reasons', () => {
    expect(describeUnmet(evaluation)).toBe(
      'requires.paid; requires.financing.preApproved — no letter on file; requires.financing.cashProof; permits.isOrganizer',
    )
  })
})

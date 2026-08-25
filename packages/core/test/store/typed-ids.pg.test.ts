/**
 * Every framework-minted id is typed: `kind:uuid`. Self-describing in a log
 * line, a journal row, or a correlation — you never wonder what a bare uuid
 * refers to. This suite pins the format at the seams where ids surface.
 */

import { testPool } from '@affordance/testkit'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createEngine } from '../../src/engine/index.js'
import { caseType, step } from '../../src/model/index.js'

const ReviewState = z.object({
  flaggedAt: z.string().nullable().default(null),
})
type Review = z.output<typeof ReviewState>

const flagReview = step({
  name: 'flag-review',
  requires: { notFlagged: (s: Review) => s.flaggedAt === null },
  input: z.string(),
  handler: async (s: Review, ctx): Promise<Review> => ({
    ...s,
    flaggedAt: ctx.input,
  }),
})

const reviewCase = caseType({
  name: 'typed-ids-review',
  state: ReviewState,
  steps: [flagReview],
})

const officer = { id: 'esc-1', roles: ['escrow-officer'] }

const pool = testPool({ max: 5 })
const engine = createEngine({ db: { pool }, caseTypes: [reviewCase] })

const TYPED = (kind: string) =>
  new RegExp(
    `^${kind}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
  )

describe('typed ids', () => {
  it('mints case, execution, and journal ids as kind:uuid', async () => {
    const created = await engine.createCase(
      reviewCase.name,
      ReviewState.parse({}),
    )
    expect(created.id).toMatch(TYPED('case'))

    const result = await engine.execute(created.id, 'flag-review', {
      actor: officer,
      input: '2026-01-01T00:00:00.000Z',
    })
    expect(result.executionId).toMatch(TYPED('execution'))

    const entries = await engine.journal(created.id)
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(entry.id).toMatch(TYPED('journal'))
      expect(entry.executionId).toMatch(TYPED('execution'))
    }
  })
})

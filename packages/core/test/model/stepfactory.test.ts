import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ConditionContext } from '../../src/guards/index.js'
import { actor, caseType, step, stepsOf } from '../../src/model/index.js'

const State = z.object({
  approved: z.boolean().default(false),
  items: z
    .array(z.object({ id: z.string(), done: z.boolean().default(false) }))
    .default([]),
})
interface TestActor {
  readonly roles: readonly string[]
}

// The factory under test — and the claim under test: everything below is
// authored without a single state annotation. The state type flows from the
// schema value; a wrong property access in any condition, selector, or
// handler is a compile error in this file.
const testStep = stepsOf(State, actor<TestActor>())

describe('stepsOf() — the schema-anchored step factory', () => {
  it('builds an unscoped step identical in shape to a bare step()', () => {
    const definition = testStep({
      name: 'approve',
      requires: { notYet: (s) => !s.approved },
      permits: {
        canApprove: (_s, ctx) => ctx.actor.roles.includes('approver'),
      },
      handler: async (s) => s,
    })
    expect(definition.name).toBe('approve')
    expect(definition.scope).toBeNull()
    expect(definition.input).toBeNull()
    expect(Object.keys(definition.guard.requires ?? {})).toEqual(['notYet'])
    expect(Object.keys(definition.guard.permits ?? {})).toEqual(['canApprove'])
  })

  it('builds a scoped step: element type anchored on scope.select, ctx.scope typed', () => {
    const definition = testStep({
      name: 'complete-item',
      scope: {
        select: (s) => s.items.filter((i) => !i.done),
        key: (i) => i.id,
      },
      requires: { stillOpen: (_s, ctx) => !ctx.scope.done },
      handler: async (s) => s,
    })
    expect(definition.scope).not.toBeNull()
    const state = State.parse({
      items: [{ id: 'one' }, { id: 'two', done: true }],
    })
    const selected = definition.scope!.select(state)
    expect(selected).toEqual([{ id: 'one', done: false }])
    expect(definition.scope!.key(selected[0])).toBe('one')
  })

  it('infers the input type from the input schema, like bare step()', () => {
    const definition = testStep({
      name: 'approve-with-note',
      input: z.object({ note: z.string() }),
      handler: async (s, ctx) => {
        const _note: string = ctx.input.note
        return s
      },
    })
    expect(definition.input).not.toBeNull()
  })

  it('returns step itself — factory-authored steps mix freely into a caseType', () => {
    const viaFactory = testStep({
      name: 'via-factory',
      handler: async (s) => s,
    })
    const viaBare = step({
      name: 'via-bare',
      requires: { approved: (s: z.output<typeof State>) => s.approved },
      handler: async (s: z.output<typeof State>) => s,
    })
    const definition = caseType({
      name: 'mixed',
      state: State,
      steps: [viaFactory, viaBare],
    })
    expect(definition.getStep('via-factory')).toBe(viaFactory)
    expect(definition.getStep('via-bare')).toBe(viaBare)
  })

  it('keeps step()-level definition-time validation', () => {
    expect(() => testStep({ name: '', handler: async (s) => s })).toThrow(
      TypeError,
    )
    expect(() =>
      testStep({
        name: 'broken',
        requires: { bad: 42 as never },
        handler: async (s) => s,
      }),
    ).toThrow(/step 'broken': requires\.bad must be/)
  })

  it('rejects a state that is not a Standard Schema, at factory-creation time', () => {
    expect(() => stepsOf({ parse: () => ({}) } as never)).toThrow(
      /stepsOf: state must be a Standard Schema/,
    )
  })

  it('actor() carries no runtime information', () => {
    expect(actor<TestActor>()).toEqual({})
  })

  it('rejects a wrongly-typed condition at compile time', () => {
    const definition = testStep({
      name: 'typo',
      requires: {
        // @ts-expect-error — `aproved` is not a property of the schema's state
        typo: (s) => s.aproved,
      },
      handler: async (s) => s,
    })
    expect(definition.name).toBe('typo')
  })

  it('types the permits context with the declared actor', () => {
    const definition = testStep({
      name: 'actor-typed',
      permits: {
        roled: (_s, ctx: ConditionContext<TestActor>) =>
          ctx.actor.roles.length > 0,
      },
      handler: async (s) => s,
    })
    expect(Object.keys(definition.guard.permits ?? {})).toEqual(['roled'])
  })
})

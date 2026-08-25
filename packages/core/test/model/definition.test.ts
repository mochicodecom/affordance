import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { anyOf, type ConditionContext } from '../../src/guards/index.js'
import {
  caseType,
  type ScopedStepOptions,
  type StepHandler,
  StepInputValidationError,
  type StepOptions,
  step,
  validateStepInput,
} from '../../src/model/index.js'

const State = z.object({
  approved: z.boolean().default(false),
  items: z
    .array(z.object({ id: z.string(), done: z.boolean().default(false) }))
    .default([]),
})
type TestState = z.output<typeof State>
type Item = TestState['items'][number]
interface TestActor {
  readonly roles: readonly string[]
}

const handler = async (state: TestState): Promise<TestState> => state

describe('step() definition-time validation', () => {
  it('builds an unscoped step: guard normalized, scope null, input null', () => {
    const definition = step({
      name: 'approve',
      requires: { notYet: (s: TestState) => !s.approved },
      permits: {
        canApprove: (_s: TestState, ctx: ConditionContext<TestActor>) =>
          ctx.actor.roles.includes('approver'),
      },
      handler,
    })
    expect(definition.name).toBe('approve')
    expect(definition.scope).toBeNull()
    expect(definition.input).toBeNull()
    expect(Object.keys(definition.guard.requires ?? {})).toEqual(['notYet'])
    expect(Object.keys(definition.guard.permits ?? {})).toEqual(['canApprove'])
  })

  it('omitted guard sections stay omitted (vacuously satisfied)', () => {
    const definition = step({ name: 'noop', handler })
    expect(definition.guard).toEqual({})
  })

  it('accepts anyOf() entries in an unscoped guard', () => {
    const definition = step({
      name: 'escalate',
      requires: {
        approved: (s: TestState) => s.approved,
        either: anyOf<TestState, TestActor>({ a: () => true, b: () => false }),
      },
      handler,
    })
    expect(Object.keys(definition.guard.requires ?? {})).toEqual([
      'approved',
      'either',
    ])
  })

  it('builds a scoped step: scope callable through the erased definition', () => {
    const definition = step({
      name: 'complete-item',
      scope: {
        select: (s: TestState) => s.items.filter((i) => !i.done),
        key: (i) => i.id,
      },
      requires: { stillOpen: (_s, ctx) => !ctx.scope.done },
      handler: async (state) => state,
    })
    expect(definition.scope).not.toBeNull()
    const state = State.parse({
      items: [{ id: 'one' }, { id: 'two', done: true }],
    })
    const selected = definition.scope!.select(state)
    expect(selected).toEqual([{ id: 'one', done: false }])
    expect(definition.scope!.key(selected[0])).toBe('one')
  })

  it('rejects an empty or missing name', () => {
    expect(() => step({ name: '', handler })).toThrow(TypeError)
    expect(() => step({ name: '   ', handler })).toThrow(TypeError)
  })

  it('rejects a non-function handler', () => {
    expect(() => step({ name: 'broken', handler: 'nope' as never })).toThrow(
      /handler must be an async function/,
    )
  })

  it('rejects a malformed guard entry loudly, naming the section and entry', () => {
    expect(() =>
      step({ name: 'broken', requires: { bad: 42 as never }, handler }),
    ).toThrow(/step 'broken': requires\.bad must be/)
    expect(() =>
      step({
        name: 'broken',
        permits: { weird: { kind: 'mystery' } as never },
        handler,
      }),
    ).toThrow(/step 'broken': permits\.weird must be/)
  })

  it('rejects a malformed scope declaration', () => {
    const options = {
      name: 'broken-scope',
      scope: { select: (s: TestState) => s.items },
      handler,
    }
    expect(() => step(options as never)).toThrow(
      /scope must be \{ select: state => elements, key: element => string \}/,
    )
  })

  it('rejects an anyOf entry in a scoped guard (outside the scoped surface)', () => {
    const group = anyOf<TestState, TestActor>({ a: () => true })
    expect(() =>
      step({
        name: 'scoped-anyof',
        scope: { select: (s: TestState) => s.items, key: (i) => i.id },
        requires: { grouped: group as never },
        handler: async (state) => state,
      }),
    ).toThrow(/anyOf is not part of the scoped guard surface/)
  })

  it('rejects an input that is not a Standard Schema', () => {
    expect(() =>
      step({
        name: 'broken-input',
        input: { parse: () => ({}) } as never,
        handler,
      }),
    ).toThrow(/input must be a Standard Schema/)
  })

  it('normalizes the retry policy, defaulting to three attempts with backoff', () => {
    const defaulted = step({ name: 'defaulted', handler })
    expect(defaulted.retry.maxAttempts).toBe(3)
    expect(defaulted.retry.delayMs(1)).toBe(100)
    expect(defaulted.retry.delayMs(2)).toBe(200)

    const fixed = step({
      name: 'fixed',
      retry: { maxAttempts: 5, delayMs: 25 },
      handler,
    })
    expect(fixed.retry.maxAttempts).toBe(5)
    expect(fixed.retry.delayMs(3)).toBe(25)

    const none = step({ name: 'no-retry', retry: { maxAttempts: 1 }, handler })
    expect(none.retry.maxAttempts).toBe(1)
  })

  it('rejects a malformed retry policy at definition time', () => {
    expect(() =>
      step({ name: 'zero', retry: { maxAttempts: 0 }, handler }),
    ).toThrow(/retry.maxAttempts must be an integer >= 1/)
    expect(() =>
      step({ name: 'fractional', retry: { maxAttempts: 1.5 }, handler }),
    ).toThrow(/retry.maxAttempts must be an integer >= 1/)
    expect(() =>
      step({ name: 'negative-delay', retry: { delayMs: -1 }, handler }),
    ).toThrow(/retry.delayMs must be a non-negative number or a function/)
    expect(() =>
      step({ name: 'bad-delay', retry: { delayMs: 'soon' as never }, handler }),
    ).toThrow(/retry.delayMs must be a non-negative number or a function/)
    expect(() =>
      step({ name: 'bad-retry', retry: 3 as never, handler }),
    ).toThrow(/retry must be \{ maxAttempts\?, delayMs\? \}/)
  })
})

describe('caseType() definition-time validation', () => {
  const approve = step({ name: 'approve', handler })
  const archive = step({ name: 'archive', handler })

  it('builds a case type exposing name, schema, steps, and step lookup', () => {
    const definition = caseType({
      name: 'test-case',
      state: State,
      steps: [approve, archive],
    })
    expect(definition.name).toBe('test-case')
    expect(definition.state).toBe(State)
    expect(definition.steps.map((s) => s.name)).toEqual(['approve', 'archive'])
    expect(definition.getStep('archive')).toBe(archive)
    expect(definition.getStep('missing')).toBeUndefined()
  })

  it('declares two things and nothing else — there is no completion slot', () => {
    const definition = caseType({
      name: 'two-things',
      state: State,
      steps: [approve],
    })
    expect(Object.keys(definition).sort()).toEqual([
      'getStep',
      'name',
      'state',
      'steps',
    ])
  })

  it('rejects duplicate step names — affordance identity would be ambiguous', () => {
    const clone = step({ name: 'approve', handler })
    expect(() =>
      caseType({ name: 'dupes', state: State, steps: [approve, clone] }),
    ).toThrow(/duplicate step name 'approve'/)
  })

  it('rejects a non-schema state and non-step steps', () => {
    expect(() =>
      caseType({ name: 'bad-state', state: {} as never, steps: [] }),
    ).toThrow(/state must be a Standard Schema/)
    expect(() =>
      caseType({
        name: 'bad-steps',
        state: State,
        steps: [{ name: 'raw' }] as never,
      }),
    ).toThrow(/every step must be built with step\(\.\.\.\)/)
  })
})

describe('validateStepInput (the plumbing the claim runs before a handler)', () => {
  const Input = z.object({
    amount: z.number().positive(),
    note: z.string().default(''),
  })
  const call = step({ name: 'call', input: Input, handler })
  const noInput = step({ name: 'no-input', handler })

  it('returns the schema output — defaults materialized', async () => {
    await expect(validateStepInput(call, { amount: 50 })).resolves.toEqual({
      amount: 50,
      note: '',
    })
  })

  it('rejects invalid input with a StepInputValidationError naming the step', async () => {
    const error = await validateStepInput(call, { amount: -1 }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(StepInputValidationError)
    expect((error as StepInputValidationError).stepName).toBe('call')
    expect((error as StepInputValidationError).issues.length).toBeGreaterThan(0)
  })

  it('a step without an input schema accepts only undefined', async () => {
    await expect(validateStepInput(noInput, undefined)).resolves.toBeUndefined()
    await expect(
      validateStepInput(noInput, { stray: true }),
    ).rejects.toBeInstanceOf(StepInputValidationError)
  })
})

// Type-level assertions, verified by `tsc --noEmit`; deliberately never executed.
const typeLevelAssertions = (): void => {
  // @ts-expect-error — handlers are async by type: a synchronous handler is inexpressible
  const syncHandler: StepHandler<TestState> = (state: TestState) => state
  void syncHandler

  // Scoped conditions see the element typed and non-optional on ctx.scope,
  // and the whole case state as their first argument.
  const scoped: ScopedStepOptions<TestState, Item, TestActor> = {
    name: 'typed-scope',
    scope: { select: (s) => s.items, key: (i) => i.id },
    requires: { open: (s, ctx) => !ctx.scope.done && !s.approved },
    handler: async (state, ctx) => {
      const key: string = ctx.scopeKey
      const item: Item = ctx.scope
      void key
      void item
      return state
    },
  }
  void scoped

  const unscoped: StepOptions<TestState, TestActor> = {
    name: 'x',
    // @ts-expect-error — an unscoped step's options do not admit a scope declaration
    scope: {},
    handler,
  }
  void unscoped
}
void typeLevelAssertions

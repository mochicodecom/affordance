/**
 * The pin on the console's shadow tables.
 *
 * The tables in `ui/src/lib/house-purchase-tables.ts` deliberately restate
 * knowledge the wire will not carry (who acts, which unmet conditions mean
 * "already happened", the intro swimlane). Their failure mode is silent
 * drift: a step or condition rename in `steps.ts` degrades the console —
 * a lost hint badge, a done-check reverting to "waiting" — with nothing
 * red anywhere. This suite makes that drift a failing test: every key in
 * every table must name something the real definitions declare.
 */

import { describe, expect, it } from 'vitest'
import { ACTOR_HEADERS } from '../src/app.js'
import { createPurchaseDefinition } from '../src/purchase.js'
import { createMockServices, PROVIDER_EVENTS } from '../src/services.js'
import { ACTOR_HEADERS as UI_ACTOR_HEADERS } from '../ui/src/lib/actor-headers.js'
import {
  DONE_WHEN_UNMET,
  INTRO,
  STEP_ACTORS,
  WORLD_LABELS,
} from '../ui/src/lib/house-purchase-tables.js'

const definition = createPurchaseDefinition(createMockServices())

const stepNames = new Set(definition.steps.map((step) => step.name))

const conditionNames = new Set(
  definition.steps.flatMap((step) => [
    ...Object.keys(step.guard.requires ?? {}),
    ...Object.keys(step.guard.permits ?? {}),
  ]),
)

describe('the shadow tables agree with the definitions', () => {
  it('every actor hint names a real step', () => {
    for (const step of Object.keys(STEP_ACTORS)) {
      expect(stepNames, `STEP_ACTORS['${step}']`).toContain(step)
    }
  })

  it('every done-when-unmet name is a declared condition', () => {
    for (const name of DONE_WHEN_UNMET) {
      expect(conditionNames, `DONE_WHEN_UNMET '${name}'`).toContain(name)
    }
  })

  it('every intro swimlane step is real and has an actor lane', () => {
    for (const phase of INTRO.phases) {
      for (const { step } of phase.steps) {
        expect(stepNames, `INTRO phase '${phase.name}'`).toContain(step)
        // The swimlane places a step by its actor hint; a step missing from
        // STEP_ACTORS silently vanishes from the picture.
        expect(Object.keys(STEP_ACTORS), `lane for '${step}'`).toContain(step)
      }
    }
    for (const step of INTRO.exceptions) {
      expect(stepNames, `INTRO exception '${step}'`).toContain(step)
    }
  })

  it('every step declares a title — the wire is the label table now', () => {
    for (const step of definition.steps) {
      expect(step.title, `step '${step.name}'`).not.toBeNull()
    }
  })

  it('the world labels cover exactly the events the providers deliver', () => {
    const pairs = new Set(
      Object.values(PROVIDER_EVENTS).map(
        (event) => `${event.system}/${event.type}`,
      ),
    )
    expect(Object.keys(WORLD_LABELS).sort()).toEqual([...pairs].sort())
  })

  it('the ui addresses the persona headers the host reads', () => {
    expect(UI_ACTOR_HEADERS).toEqual(ACTOR_HEADERS)
  })
})

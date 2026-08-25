/**
 * The affordance engine.
 *
 * An **affordance** is a step (× scope binding) currently available on a
 * case for an actor — computed from guards over state, queryable,
 * explainable (CONTEXT.md; spec §Core model). This module is the
 * framework's public face: the pure computation (`computeAffordances`,
 * `computeExplanation`) and the store-bound engine (`createEngine` →
 * `affordances` / `explain` / `execute` / `journal`). Nothing in the
 * computation ever invokes a handler — that is `../execution`'s job alone.
 */

export type {
  Affordance,
  AffordanceExplanation,
  BlockedStep,
  CaseAffordances,
  CaseSnapshot,
  ExplainRequest,
} from './compute.js'
export {
  computeAffordances,
  computeExplanation,
  explainContext,
} from './compute.js'
export type { Engine, EngineOptions, ExplainOptions } from './engine.js'
export { createEngine } from './engine.js'
export { UnknownCaseTypeError } from './errors.js'

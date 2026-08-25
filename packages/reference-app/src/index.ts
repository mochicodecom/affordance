// Copyright © 2026 Mochicode LLC — mochicode.com

/**
 * @affordance/reference-app — a group house purchase, built for real.
 *
 * The anchor use case the framework was designed against, as a first-class
 * deliverable rather than a demo: several people pooling money to buy a
 * house together, as a real case type with real guards, real scoped steps,
 * real ingestion from providers that answer late and retry,
 * and the two exception paths the design kept promising would be ordinary
 * steps — wire reconciliation and verification escalation.
 *
 * - `state.ts` — the Case State schema. No status field anywhere in it.
 * - `steps.ts` — every step, as a flat list of guards. No ordering declared.
 * - `purchase.ts` — the house-purchase definition set.
 * - `services.ts` — mock verification, e-sign and escrow banking that answer
 *   later and retry.
 * - `app.ts` — the wiring: engine, providers, HTTP adapter.
 */

export type { PurchaseApp, PurchaseAppOptions } from './app.js'
export { createPurchaseApp } from './app.js'
export {
  createPurchaseDefinition,
  HOUSE_PURCHASE,
  newPurchase,
} from './purchase.js'
export type { MockServiceOptions, MockServices } from './services.js'
export { createMockServices } from './services.js'
export * from './state.js'
export * from './steps.js'

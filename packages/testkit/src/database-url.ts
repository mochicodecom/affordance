/**
 * The test database's address — stated once for every package's pg suites.
 * Importable from both sides: the global-setup path runs outside any test
 * context, where importing vitest's test API is an error, so this module
 * has no imports at all.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/affordance_test'

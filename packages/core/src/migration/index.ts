/**
 * The migration primitive for the one change float cannot cover.
 *
 * Explicit state restructures — renames, splits, a scalar becoming a
 * collection — run as journaled system Executions, never as silent
 * mutation. Everything else should be handled by writing total conditions
 * over the old shape; see `docs/migration.md` for where the line is.
 */

export type {
  MigrationActor,
  MigrationFailure,
  MigrationOptions,
  MigrationProgress,
  MigrationReport,
  MigrationTransform,
} from './migrate.js'
export { hasMigrated, migrate, migrationStepName } from './migrate.js'

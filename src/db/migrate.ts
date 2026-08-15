import type { Database } from "bun:sqlite";
import { MIGRATIONS, type Migration } from "./migrations.ts";

/** A migration's SQL (or its version bump) failed; the whole migration rolled back. */
export class MigrationError extends Error {
  override readonly name = "MigrationError";
}

// sqlite's `user_version` is a signed 32-bit integer; a value at or above 2^31 cannot round-trip
// (it silently reads back as something else, and non-finite/non-integer values silently write 0).
const MAX_MIGRATION_VERSION = 2 ** 31 - 1;

/**
 * Refuses the whole set before applying anything if any version is malformed, duplicated, or out
 * of order, so a bad entry can never partially apply.
 */
function assertWellFormed(migrations: readonly Migration[]): void {
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version < 1 || migration.version > MAX_MIGRATION_VERSION) {
      throw new MigrationError(
        `reviewzy: migration "${migration.name}" has an invalid version (${migration.version}); versions must be finite integers between 1 and ${MAX_MIGRATION_VERSION}.`,
      );
    }
    if (migration.version <= previous) {
      throw new MigrationError(
        `reviewzy: migration ${migration.version} (${migration.name}) is out of order or duplicates a version already seen; migrations must have strictly ascending version numbers.`,
      );
    }
    previous = migration.version;
  }
}

/**
 * Applies every migration newer than `PRAGMA user_version`, oldest first, each inside its own
 * transaction so a failure rolls back cleanly and never leaves a half-applied schema. A
 * migration already recorded in `user_version` is skipped, never re-run.
 */
export function runMigrations(db: Database, migrations: readonly Migration[] = MIGRATIONS): void {
  assertWellFormed(migrations);

  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;

  // A database written by a newer reviewzy carries a version this build has no migration for;
  // booting anyway would silently run with no schema at all.
  const highestKnown = migrations.at(-1)?.version ?? 0;
  if (current > highestKnown) {
    throw new MigrationError(
      `reviewzy: this database is at schema version ${current}, newer than the highest migration this build knows (${highestKnown}); it was written by a newer reviewzy. Upgrade reviewzy, or point REVIEWZY_DB at a different file.`,
    );
  }

  // `assertWellFormed` already guarantees `migrations` is strictly ascending, so `filter` alone
  // preserves application order without a separate sort.
  const pending = migrations.filter((m) => m.version > current);

  for (const migration of pending) {
    const apply = db.transaction(() => {
      db.run(migration.sql);
      // PRAGMA does not accept bound parameters; `version` is validated above, never user input.
      db.run(`PRAGMA user_version = ${migration.version}`);
    });

    try {
      apply();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new MigrationError(`reviewzy: migration ${migration.version} (${migration.name}) failed: ${detail}`);
    }
  }
}

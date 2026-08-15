import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../config.ts";
import { runMigrations } from "./migrate.ts";

export type Store = {
  readonly db: Database;
  close(): void;
};

/** The operator-supplied `REVIEWZY_DB` path rejected a required setting, distinct from a bug in the daemon. */
export class StoreError extends Error {
  override readonly name = "StoreError";
}

/**
 * Opens (creating if absent) the sqlite file at `config.REVIEWZY_DB`, enables WAL journaling and
 * foreign-key enforcement, and applies every pending migration before returning. Both pragmas
 * reset on every new connection, so they are set here rather than assumed from a prior boot.
 */
export function openStore(config: Config): Store {
  mkdirSync(dirname(config.REVIEWZY_DB), { recursive: true });

  const db = new Database(config.REVIEWZY_DB, { create: true });

  // `PRAGMA journal_mode = WAL` silently falls back (e.g. `memory` for `:memory:`, or `delete` on
  // a filesystem that can't do WAL) instead of erroring, so read the mode it actually landed on.
  const { journal_mode: journalMode } = db.query("PRAGMA journal_mode = WAL").get() as {
    journal_mode: string;
  };
  if (journalMode.toLowerCase() !== "wal") {
    throw new StoreError(
      `reviewzy: sqlite at ${config.REVIEWZY_DB} could not enable WAL journaling (landed on '${journalMode}' instead); WAL needs a local filesystem, not a network mount. Point REVIEWZY_DB at local disk.`,
    );
  }

  db.run("PRAGMA foreign_keys = ON");

  runMigrations(db);

  return {
    db,
    close: () => db.close(),
  };
}

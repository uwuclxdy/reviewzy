import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../config.ts";
import type { EntryStatus } from "./queries.ts";
import { runMigrations } from "./migrate.ts";

export type Store = {
  readonly db: Database;
  /**
   * The store-scoped status-change bus, one per `openStore`: `await_approved` waits on it, and the
   * write paths dispatch on it. Never module-global — tests run several apps in one process, and a
   * shared bus would cross-talk between stores.
   */
  readonly events: EventTarget;
  /** Dispatches a status change on the bus; every status-writing path calls it after a successful transition. */
  notifyStatusChange(id: string, status: EntryStatus): void;
  /** Registers an in-flight `await_approved` waiter for the drain path; returns the unregister call. */
  registerWaiter(resolve: () => void): () => void;
  /** Resolves every registered waiter; the `/drain` route calls it before shutdown, so long-poll responses flush while the server still serves. */
  resolveInFlightWaiters(): void;
  /** The number of registered waiters; the teardown pins read it to prove a settled wait unregistered itself. */
  waiterCount(): number;
  close(): void;
};

/** The one bus event: an entry's status changed. The detail carries {id, status}; a listener that only cares that something changed may ignore it. */
export const STATUS_CHANGE_EVENT = "entry-status-changed";

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

  const events = new EventTarget();
  const waiters = new Set<() => void>();

  return {
    db,
    events,
    notifyStatusChange: (id, status) => {
      events.dispatchEvent(new CustomEvent(STATUS_CHANGE_EVENT, { detail: { id, status } }));
    },
    registerWaiter: (resolve) => {
      waiters.add(resolve);
      return () => {
        waiters.delete(resolve);
      };
    },
    // A snapshot copy: a waiter unregisters itself while resolving, so iterating the live set
    // while calling the handlers would skip a later waiter.
    resolveInFlightWaiters: () => {
      for (const resolve of [...waiters]) resolve();
    },
    waiterCount: () => waiters.size,
    close: () => db.close(),
  };
}

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MigrationError, runMigrations } from "../../src/db/migrate.ts";
import type { Migration } from "../../src/db/migrations.ts";

function userVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function tableNames(db: Database): string[] {
  return (
    db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((r) => r.name);
}

const m = (version: number, name: string, sql: string): Migration => ({ version, name, sql });

/** Wraps the real db so the migration's transaction commits and the error lands right after it: the deterministic stand-in for a crash between commit and any later write. */
function crashAfterCommit(db: Database): Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "transaction") {
        return (fn: (...a: never[]) => unknown) => {
          const real = target.transaction((...a: never[]) => fn(...a));
          return (...a: never[]) => {
            real(...a);
            throw new Error("crash after commit");
          };
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Database;
}

describe("runMigrations", () => {
  test("applies pending migrations in order and stamps user_version", () => {
    const db = new Database(":memory:");
    const migrations = [m(1, "a", "CREATE TABLE a (x TEXT)"), m(2, "b", "CREATE TABLE b (y TEXT)")];

    runMigrations(db, migrations);

    expect(userVersion(db)).toBe(2);
    expect(tableNames(db).sort()).toEqual(["a", "b"]);
  });

  test("does not re-run a migration already recorded in user_version", () => {
    const db = new Database(":memory:");
    const migrations = [m(1, "a", "CREATE TABLE a (x TEXT)")];

    runMigrations(db, migrations);
    // A second call replaying migration 1 would throw "table a already exists" if the
    // version gate did not skip it.
    expect(() => runMigrations(db, migrations)).not.toThrow();
    expect(userVersion(db)).toBe(1);
  });

  test("rolls back a failing migration and fails fast, naming the migration number and the sqlite error", () => {
    const db = new Database(":memory:");
    const migrations = [
      m(1, "a", "CREATE TABLE dup (x TEXT)"),
      // The second statement collides with migration 1's table; the first statement in
      // this migration must roll back too, not merely stop where it failed.
      m(2, "b", "CREATE TABLE ok (z TEXT); CREATE TABLE dup (x TEXT);"),
    ];

    runMigrations(db, [migrations[0]!]);

    let caught: unknown;
    try {
      runMigrations(db, migrations);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MigrationError);
    expect((caught as Error).message).toContain("migration 2");
    expect((caught as Error).message).toMatch(/dup/i);
    expect((caught as Error).message).toMatch(/already exists/i);
    expect(userVersion(db)).toBe(1);
    expect(tableNames(db)).not.toContain("ok");
  });

  test("a crash after the migration's commit leaves the version stamped with the schema, because the version bump rides in the same transaction", () => {
    const db = new Database(":memory:");

    // If the bump ran OUTSIDE the transaction, this simulated crash lands between the DDL
    // commit and the bump: schema applied at version 0, and the next boot would replay
    // migration 1 forever. Inside it, both land or neither does.
    expect(() =>
      runMigrations(crashAfterCommit(db), [m(1, "a", "CREATE TABLE probe (x TEXT)")]),
    ).toThrow(MigrationError);

    expect(userVersion(db)).toBe(1);
    expect(tableNames(db)).toContain("probe");
  });

  test("rejects a migration set with duplicate version numbers before applying anything", () => {
    const db = new Database(":memory:");
    const migrations = [m(1, "a", "CREATE TABLE a (x TEXT)"), m(1, "b", "CREATE TABLE b (y TEXT)")];

    expect(() => runMigrations(db, migrations)).toThrow(MigrationError);
    expect((() => { try { runMigrations(db, migrations); } catch (e) { return (e as Error).message; } })()).toContain("1");
    expect(userVersion(db)).toBe(0);
    expect(tableNames(db)).toEqual([]);
  });

  test("rejects an out-of-order migration set before applying anything", () => {
    const db = new Database(":memory:");
    const migrations = [m(2, "b", "CREATE TABLE b (y TEXT)"), m(1, "a", "CREATE TABLE a (x TEXT)")];

    let message = "";
    try {
      runMigrations(db, migrations);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("out of order");
    expect(message).toContain("1");
    expect(userVersion(db)).toBe(0);
    expect(tableNames(db)).toEqual([]);
  });

  test.each([0, -1, 1.5, Number.NaN, 2 ** 31])(
    "rejects version %s as a malformed version number",
    (version) => {
      const db = new Database(":memory:");
      expect(() => runMigrations(db, [m(version, "bad", "CREATE TABLE bad (x TEXT)")])).toThrow(
        MigrationError,
      );
      expect(userVersion(db)).toBe(0);
    },
  );

  test("refuses to boot a database at a schema version newer than this build knows", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA user_version = 99");

    let message = "";
    try {
      runMigrations(db, [m(1, "a", "CREATE TABLE a (x TEXT)")]);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("99");
    expect(message).toContain("1");
    expect(message).toMatch(/newer reviewzy|upgrade/i);
  });

  test("migration SQL itself runs under foreign-key enforcement when the connection enables it", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");

    const migrations = [
      m(
        1,
        "fk",
        `CREATE TABLE parent (id TEXT PRIMARY KEY);
         CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));
         INSERT INTO child (id, parent_id) VALUES ('c1', 'missing');`,
      ),
    ];

    expect(() => runMigrations(db, migrations)).toThrow(/FOREIGN KEY/i);
    expect(tableNames(db)).toEqual([]);
    expect(userVersion(db)).toBe(0);
  });
});

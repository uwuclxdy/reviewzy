import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ulid } from "ulid";
import { loadConfig } from "../../src/config.ts";
import { openStore, StoreError } from "../../src/db/store.ts";
import type { Store } from "../../src/db/store.ts";
import { sweepArchive } from "../../src/db/sweep.ts";

const tempDirs: string[] = [];

/** A path under a fresh temp dir, so every test boots an unshared, disposable database file. */
function tempDbPath(...nestedDirs: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-store-test-"));
  tempDirs.push(dir);
  return join(dir, ...nestedDirs, "reviewzy.db");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function configWithDb(dbPath: string) {
  return loadConfig({ REVIEWZY_DB: dbPath });
}

function openTempStore(): Store {
  return openStore(configWithDb(tempDbPath()));
}

function insertProject(db: Database, overrides: { id?: string; slug?: string } = {}) {
  const row = {
    id: overrides.id ?? ulid(),
    slug: overrides.slug ?? `project-${ulid()}`,
    created_at: Date.now(),
  };
  db.run("INSERT INTO projects (id, slug, created_at) VALUES (?, ?, ?)", [
    row.id,
    row.slug,
    row.created_at,
  ]);
  return row;
}

type EntryOverrides = Partial<{
  project_id: string | null;
  id: string;
  batch_id: string;
  repo: string;
  file: string;
  anchor_text: string;
  anchor_before: string;
  anchor_after: string;
  anchor_hash: string;
  file_hash: string;
  agent_draft: string | null;
  human_text: string | null;
  status: string;
  context: string | null;
  constraints: string | null;
  filed_by: string | null;
  stale_note: string | null;
  created_at: number | string;
  updated_at: number | string;
  applied_at: number | string | null;
  archived_at: number | string | null;
}>;

function insertEntry(db: Database, projectId: string, overrides: EntryOverrides = {}) {
  const now = Date.now();
  const row = {
    id: ulid(),
    batch_id: ulid(),
    repo: "https://example.com/repo.git",
    file: "src/index.ts",
    anchor_text: "hello world",
    anchor_before: "",
    anchor_after: "",
    anchor_hash: "hash-1",
    file_hash: "filehash-1",
    agent_draft: "hello world draft",
    human_text: null,
    status: "draft",
    context: "{}",
    constraints: "{}",
    filed_by: "agent",
    stale_note: null,
    created_at: now,
    updated_at: now,
    applied_at: null,
    archived_at: null,
    ...overrides,
    project_id: overrides.project_id !== undefined ? overrides.project_id : projectId,
  };
  db.run(
    `INSERT INTO entries (
      id, project_id, batch_id, repo, file, anchor_text, anchor_before, anchor_after,
      anchor_hash, file_hash, agent_draft, human_text, status, context, constraints,
      filed_by, stale_note, created_at, updated_at, applied_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.project_id,
      row.batch_id,
      row.repo,
      row.file,
      row.anchor_text,
      row.anchor_before,
      row.anchor_after,
      row.anchor_hash,
      row.file_hash,
      row.agent_draft,
      row.human_text,
      row.status,
      row.context,
      row.constraints,
      row.filed_by,
      row.stale_note,
      row.created_at,
      row.updated_at,
      row.applied_at,
      row.archived_at,
    ],
  );
  return row;
}

describe("openStore", () => {
  test("boots a fresh database at a temp path and lands on the pinned schema version", () => {
    const store = openTempStore();
    const version = (store.db.query("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    expect(version).toBe(5);
    store.close();
  });

  test("creates the six tables the contract specifies", () => {
    const store = openTempStore();
    const tables = (
      store.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    )
      .map((r) => r.name)
      .sort();
    expect(tables).toEqual([
      "entries",
      "entries_archive",
      "entry_revisions",
      "entry_revisions_archive",
      "projects",
      "style_guides",
    ]);
    store.close();
  });

  test("creates the parent directory of REVIEWZY_DB when absent", () => {
    const dbPath = tempDbPath("nested", "sub");
    expect(existsSync(dirname(dbPath))).toBe(false);
    const store = openStore(configWithDb(dbPath));
    expect(existsSync(dbPath)).toBe(true);
    store.close();
  });

  test("enables WAL journaling and foreign-key enforcement", () => {
    const store = openTempStore();
    const journalMode = (
      store.db.query("PRAGMA journal_mode").get() as { journal_mode: string }
    ).journal_mode;
    const foreignKeys = (
      store.db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }
    ).foreign_keys;
    expect(journalMode).toBe("wal");
    expect(foreignKeys).toBe(1);
    store.close();
  });

  test("refuses a database that cannot take WAL, naming the path and the mode it landed on", () => {
    // An in-memory file always reports 'memory', the one deterministic non-WAL answer.
    let message = "";
    try {
      openStore(configWithDb(":memory:"));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(":memory:");
    expect(message).toContain("'memory'");
    expect(message).toMatch(/wal/i);
  });

  test("re-opening an existing database does not re-run migrations and keeps prior data", () => {
    const dbPath = tempDbPath();
    const first = openStore(configWithDb(dbPath));
    const project = insertProject(first.db, { slug: "keep-me" });
    first.close();

    const second = openStore(configWithDb(dbPath));
    const version = (second.db.query("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    expect(version).toBe(5);

    const row = second.db.query("SELECT slug FROM projects WHERE id = ?").get(project.id) as {
      slug: string;
    } | null;
    expect(row?.slug).toBe("keep-me");
    second.close();
  });
});

describe("the entry identity key", () => {
  test("(project_id, repo, file, anchor_hash) rejects a duplicate identity", () => {
    const store = openTempStore();
    const project = insertProject(store.db);
    insertEntry(store.db, project.id, { repo: "r", file: "f", anchor_hash: "h" });

    expect(() =>
      insertEntry(store.db, project.id, { repo: "r", file: "f", anchor_hash: "h" }),
    ).toThrow(/UNIQUE constraint failed/i);

    store.close();
  });

  test("anchor_text is not part of the key: a shared anchor_hash with different anchor_text still collides", () => {
    const store = openTempStore();
    const project = insertProject(store.db);
    insertEntry(store.db, project.id, {
      repo: "r",
      file: "f",
      anchor_hash: "h",
      anchor_text: "first wording",
    });

    expect(() =>
      insertEntry(store.db, project.id, {
        repo: "r",
        file: "f",
        anchor_hash: "h",
        anchor_text: "second wording",
      }),
    ).toThrow(/UNIQUE constraint failed/i);

    store.close();
  });

  test("is composite: changing any one of its four columns allows a second row", () => {
    const store = openTempStore();
    const project = insertProject(store.db);
    insertEntry(store.db, project.id, { repo: "r", file: "f", anchor_hash: "h" });

    expect(() =>
      insertEntry(store.db, project.id, { repo: "r2", file: "f", anchor_hash: "h" }),
    ).not.toThrow();
    expect(() =>
      insertEntry(store.db, project.id, { repo: "r", file: "f2", anchor_hash: "h" }),
    ).not.toThrow();
    expect(() =>
      insertEntry(store.db, project.id, { repo: "r", file: "f", anchor_hash: "h2" }),
    ).not.toThrow();

    const otherProject = insertProject(store.db);
    expect(() =>
      insertEntry(store.db, otherProject.id, { repo: "r", file: "f", anchor_hash: "h" }),
    ).not.toThrow();

    store.close();
  });

  test.each(["project_id", "repo", "file", "anchor_hash"] as const)(
    "%s is NOT NULL, so the unique key cannot be silently evaded with NULL",
    (column) => {
      const store = openTempStore();
      const project = insertProject(store.db);
      const base = { repo: "r", file: "f", anchor_hash: "h" } as const;
      const withNull = { ...base, [column]: null };
      expect(() => insertEntry(store.db, project.id, withNull)).toThrow(
        new RegExp(`NOT NULL constraint failed: entries\\.${column}`, "i"),
      );
      store.close();
    },
  );

  const ID_TABLES = [
    "projects",
    "entries",
    "entry_revisions",
    "entries_archive",
    "entry_revisions_archive",
  ] as const;

  test.each([...ID_TABLES])(
    "%s.id rejects NULL, naming the table and column (sqlite TEXT primary keys admit NULL by default)",
    (table: (typeof ID_TABLES)[number]) => {
      const store = openTempStore();
      const db = store.db;
      const project = insertProject(db);
      const entry = insertEntry(db, project.id);
      // entry_revisions_archive.entry_id points at entries_archive, so that leg needs one archived row.
      db.run(
        `INSERT INTO entries_archive (
          id, project_id, batch_id, repo, file, anchor_text, anchor_before, anchor_after,
          anchor_hash, file_hash, status, context, constraints, filed_by, stale_note,
          created_at, updated_at, applied_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', '{}', '{}', NULL, NULL, ?, ?, ?, ?)`,
        [
          "archived-entry",
          project.id,
          entry.batch_id,
          entry.repo,
          entry.file,
          entry.anchor_text,
          entry.anchor_before,
          entry.anchor_after,
          entry.anchor_hash,
          entry.file_hash,
          entry.created_at,
          entry.updated_at,
          entry.applied_at,
          Date.now(),
        ],
      );

      const inserts: Record<(typeof ID_TABLES)[number], () => void> = {
        projects: () =>
          db.run("INSERT INTO projects (id, slug, created_at) VALUES (?, ?, ?)", [
            null,
            "null-id",
            Date.now(),
          ]),
        entries: () =>
          db.run(
            `INSERT INTO entries (
              id, project_id, batch_id, repo, file, anchor_text, anchor_before, anchor_after,
              anchor_hash, file_hash, status, context, constraints, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', '{}', '{}', ?, ?)`,
            [
              null,
              project.id,
              entry.batch_id,
              "r",
              "f",
              "t",
              "",
              "",
              "h",
              "fh",
              Date.now(),
              Date.now(),
            ],
          ),
        entry_revisions: () =>
          db.run(
            "INSERT INTO entry_revisions (id, entry_id, human_text, status, created_at) VALUES (?, ?, ?, ?, ?)",
            [null, entry.id, "prose", "approved", Date.now()],
          ),
        entries_archive: () =>
          db.run(
            `INSERT INTO entries_archive (
              id, project_id, batch_id, repo, file, anchor_text, anchor_before, anchor_after,
              anchor_hash, file_hash, status, context, constraints, created_at, updated_at, archived_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', '{}', '{}', ?, ?, ?)`,
            [
              null,
              project.id,
              entry.batch_id,
              "r",
              "f",
              "t",
              "",
              "",
              "h",
              "fh",
              Date.now(),
              Date.now(),
              Date.now(),
            ],
          ),
        entry_revisions_archive: () =>
          db.run(
            "INSERT INTO entry_revisions_archive (id, entry_id, human_text, status, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?)",
            [null, "archived-entry", "prose", "approved", Date.now(), Date.now()],
          ),
      };

      expect(() => inserts[table]()).toThrow(
        new RegExp(`NOT NULL constraint failed: ${table}\\.id`, "i"),
      );
      store.close();
    },
  );
});

describe("the status enum", () => {
  test.each(["draft", "approved", "applied", "rejected"] as const)(
    "%s is an accepted status",
    (status) => {
      const store = openTempStore();
      const project = insertProject(store.db);
      expect(() => insertEntry(store.db, project.id, { status })).not.toThrow();
      store.close();
    },
  );

  test.each(["bogus", "deleted", "Draft", "APPROVED", "", " approved"])(
    "'%s' is refused by the CHECK constraint, naming the constraint",
    (status) => {
      const store = openTempStore();
      const project = insertProject(store.db);
      expect(() => insertEntry(store.db, project.id, { status })).toThrow(
        /CHECK constraint failed/i,
      );
      store.close();
    },
  );

  test("entry_revisions statuses are constrained the same way", () => {
    const store = openTempStore();
    const project = insertProject(store.db);
    const entry = insertEntry(store.db, project.id);
    expect(() =>
      store.db.run(
        "INSERT INTO entry_revisions (id, entry_id, human_text, status, created_at) VALUES (?, ?, ?, ?, ?)",
        [ulid(), entry.id, "text", "deleted", Date.now()],
      ),
    ).toThrow(/CHECK constraint failed/i);
    store.close();
  });
});

describe("timestamps", () => {
  test.each(["created_at", "updated_at"] as const)(
    "entries.%s refuses a non-integer timestamp value, including ISO strings",
    (column) => {
      const store = openTempStore();
      const project = insertProject(store.db);
      expect(() =>
        insertEntry(store.db, project.id, { anchor_hash: "iso", [column]: "2026-08-15T00:00:00Z" }),
      ).toThrow(/CHECK constraint failed/i);
      expect(() => insertEntry(store.db, project.id, { anchor_hash: "float", [column]: 1.5 })).toThrow(
        /CHECK constraint failed/i,
      );
      store.close();
    },
  );

  test("entries.applied_at and entries.archived_at accept NULL or integer ms, nothing else", () => {
    const store = openTempStore();
    const project = insertProject(store.db);

    expect(() => insertEntry(store.db, project.id, { anchor_hash: "null-ok" })).not.toThrow();
    expect(() =>
      insertEntry(store.db, project.id, {
        anchor_hash: "int-ok",
        applied_at: Date.now(),
        archived_at: Date.now(),
      }),
    ).not.toThrow();
    expect(() =>
      insertEntry(store.db, project.id, { anchor_hash: "iso-bad", applied_at: "2026-08-15T00:00:00Z" }),
    ).toThrow(/CHECK constraint failed/i);
    expect(() =>
      insertEntry(store.db, project.id, { anchor_hash: "iso-bad2", archived_at: "2026-08-15T00:00:00Z" }),
    ).toThrow(/CHECK constraint failed/i);

    store.close();
  });

  test("every timestamp column on every table is declared INTEGER", () => {
    const store = openTempStore();
    for (const table of ["projects", "entries", "entry_revisions", "entries_archive", "entry_revisions_archive"]) {
      const columns = store.db.query(`PRAGMA table_info(${table})`).all() as {
        name: string;
        type: string;
      }[];
      const timestampColumns = columns.filter((c) => /_at$/.test(c.name));
      expect(timestampColumns.length).toBeGreaterThan(0);
      for (const column of timestampColumns) {
        expect(`${table}.${column.name}: ${column.type}`).toBe(`${table}.${column.name}: INTEGER`);
      }
    }
    store.close();
  });

  test("entries.archived_at exists per the contract's entry schema", () => {
    const store = openTempStore();
    const columns = (store.db.query("PRAGMA table_info(entries)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).toContain("archived_at");
    store.close();
  });

  test("applied_hash exists on entries and entries_archive, which mirrors it (migration 3)", () => {
    const store = openTempStore();
    for (const table of ["entries", "entries_archive"]) {
      const columns = (store.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(columns, table).toContain("applied_hash");
    }
    store.close();
  });

  test("title exists and is nullable on entries and entries_archive (migration 4)", () => {
    const store = openTempStore();
    for (const table of ["entries", "entries_archive"]) {
      const columns = (store.db.query(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number }[]);
      const title = columns.find((c) => c.name === "title");
      expect(title, `${table}.title column`).toBeDefined();
      expect(title?.notnull, `${table}.title is nullable`).toBe(0);
    }
    store.close();
  });

  test("images exists with an '[]' default on entries and entries_archive (migration 5)", () => {
    const store = openTempStore();
    for (const table of ["entries", "entries_archive"]) {
      const columns = (store.db.query(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number; dflt_value: string | null }[]);
      const images = columns.find((c) => c.name === "images");
      expect(images, `${table}.images column`).toBeDefined();
      expect(images?.notnull, `${table}.images is NOT NULL`).toBe(1);
      expect(images?.dflt_value, `${table}.images defaults to '[]'`).toBe("'[]'");
    }
    store.close();
  });

  test("the archive sweep copies images across whole (migration 5)", () => {
    const store = openTempStore();
    const project = insertProject(store.db);
    const entry = insertEntry(store.db, project.id, { status: "applied", applied_at: 0 });
    const images = ["https://example.com/shot.png", "data:image/png;base64,AAAA"];
    store.db.run("UPDATE entries SET images = ? WHERE id = ?", [JSON.stringify(images), entry.id]);

    const moved = sweepArchive(store, Date.now(), 90);

    expect(moved).toBe(1);
    const archived = store.db.query("SELECT images FROM entries_archive WHERE id = ?").get(entry.id) as {
      images: string;
    };
    expect(JSON.parse(archived.images)).toEqual(images);
    store.close();
  });
});

describe("referential integrity", () => {
  test("enforces the foreign key from entries to projects", () => {
    const store = openTempStore();
    expect(() => insertEntry(store.db, "does-not-exist")).toThrow(/FOREIGN KEY/i);
    store.close();
  });

  test("entry_revisions references entries", () => {
    const store = openTempStore();
    const project = insertProject(store.db);
    const entry = insertEntry(store.db, project.id);

    store.db.run(
      "INSERT INTO entry_revisions (id, entry_id, human_text, status, created_at) VALUES (?, ?, ?, ?, ?)",
      [ulid(), entry.id, "cloudy's prose", "approved", Date.now()],
    );
    const row = store.db
      .query("SELECT human_text FROM entry_revisions WHERE entry_id = ?")
      .get(entry.id) as { human_text: string };
    expect(row.human_text).toBe("cloudy's prose");

    expect(() =>
      store.db.run(
        "INSERT INTO entry_revisions (id, entry_id, human_text, status, created_at) VALUES (?, ?, ?, ?, ?)",
        [ulid(), "does-not-exist", "x", "approved", Date.now()],
      ),
    ).toThrow(/FOREIGN KEY/i);

    store.close();
  });

  test("entries_archive references projects", () => {
    const store = openTempStore();
    const keys = store.db.query("PRAGMA foreign_key_list(entries_archive)").all() as {
      table: string;
      from: string;
      to: string | null;
    }[];
    const fk = keys.find((k) => k.from === "project_id");
    expect(fk?.table).toBe("projects");
    expect(fk?.to).toBe("id");
    store.close();
  });

  test("entry_revisions_archive references entries_archive", () => {
    const store = openTempStore();
    const keys = store.db.query("PRAGMA foreign_key_list(entry_revisions_archive)").all() as {
      table: string;
      from: string;
      to: string | null;
    }[];
    const fk = keys.find((k) => k.from === "entry_id");
    expect(fk?.table).toBe("entries_archive");
    expect(fk?.to).toBe("id");
    expect(() =>
      store.db.run(
        "INSERT INTO entry_revisions_archive (id, entry_id, human_text, status, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?)",
        [ulid(), "no-such-entry", "prose", "approved", Date.now(), Date.now()],
      ),
    ).toThrow(/FOREIGN KEY/i);
    store.close();
  });

  test("deleting an entry whose revisions are still live fails loudly rather than orphaning them", () => {
    const store = openTempStore();
    const project = insertProject(store.db);
    const entry = insertEntry(store.db, project.id);
    store.db.run(
      "INSERT INTO entry_revisions (id, entry_id, human_text, status, created_at) VALUES (?, ?, ?, ?, ?)",
      [ulid(), entry.id, "prose", "approved", Date.now()],
    );

    expect(() => store.db.run("DELETE FROM entries WHERE id = ?", [entry.id])).toThrow(
      /FOREIGN KEY/i,
    );

    store.close();
  });

  test("the full archive move works: entry and revisions move together, then the live rows delete cleanly", () => {
    const store = openTempStore();
    const project = insertProject(store.db);
    const entry = insertEntry(store.db, project.id, { status: "applied", applied_at: Date.now() });
    const revisionId = ulid();
    store.db.run(
      "INSERT INTO entry_revisions (id, entry_id, human_text, status, created_at) VALUES (?, ?, ?, ?, ?)",
      [revisionId, entry.id, "prose", "approved", Date.now()],
    );

    const archivedAt = Date.now();
    const move = store.db.transaction(() => {
      store.db.run(
        `INSERT INTO entries_archive (
          id, project_id, batch_id, repo, file, anchor_text, anchor_before, anchor_after,
          anchor_hash, file_hash, agent_draft, human_text, status, context, constraints,
          filed_by, stale_note, created_at, updated_at, applied_at, archived_at
        ) SELECT
          id, project_id, batch_id, repo, file, anchor_text, anchor_before, anchor_after,
          anchor_hash, file_hash, agent_draft, human_text, status, context, constraints,
          filed_by, stale_note, created_at, updated_at, applied_at, ?
        FROM entries WHERE id = ?`,
        [archivedAt, entry.id],
      );
      store.db.run(
        `INSERT INTO entry_revisions_archive (id, entry_id, human_text, status, created_at, archived_at)
         SELECT id, entry_id, human_text, status, created_at, ? FROM entry_revisions WHERE entry_id = ?`,
        [archivedAt, entry.id],
      );
      store.db.run("DELETE FROM entry_revisions WHERE entry_id = ?", [entry.id]);
      store.db.run("DELETE FROM entries WHERE id = ?", [entry.id]);
    });
    move();

    expect(
      (store.db.query("SELECT COUNT(*) c FROM entries WHERE id = ?").get(entry.id) as { c: number })
        .c,
    ).toBe(0);
    expect(
      (
        store.db.query("SELECT COUNT(*) c FROM entry_revisions WHERE entry_id = ?").get(entry.id) as {
          c: number;
        }
      ).c,
    ).toBe(0);
    const archivedEntry = store.db
      .query("SELECT archived_at FROM entries_archive WHERE id = ?")
      .get(entry.id) as { archived_at: number };
    expect(archivedEntry.archived_at).toBe(archivedAt);
    const archivedRevision = store.db
      .query("SELECT human_text FROM entry_revisions_archive WHERE id = ?")
      .get(revisionId) as { human_text: string };
    expect(archivedRevision.human_text).toBe("prose");

    store.close();
  });
});

describe("other constraints", () => {
  test("projects.slug is unique", () => {
    const store = openTempStore();
    insertProject(store.db, { slug: "same" });
    expect(() => insertProject(store.db, { slug: "same" })).toThrow(/UNIQUE constraint failed/i);
    store.close();
  });

  test("context and constraints are required columns", () => {
    const store = openTempStore();
    const project = insertProject(store.db);
    expect(() => insertEntry(store.db, project.id, { context: null })).toThrow(
      /NOT NULL constraint failed/i,
    );
    expect(() => insertEntry(store.db, project.id, { constraints: null })).toThrow(
      /NOT NULL constraint failed/i,
    );
    store.close();
  });
});

// Keep the StoreError export honest: it is the type callers catch for an unusable db location.
test("StoreError is exported and names itself", () => {
  expect(new StoreError("x").name).toBe("StoreError");
});

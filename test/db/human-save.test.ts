import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { loadConfig } from "../../src/config.ts";
import { listRevisions, saveHumanText } from "../../src/db/human-save.ts";
import type { HumanSaveOutcome } from "../../src/db/human-save.ts";
import { openStore, STATUS_CHANGE_EVENT } from "../../src/db/store.ts";
import type { Store } from "../../src/db/store.ts";

const tempDirs: string[] = [];

function openTempStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-human-save-"));
  tempDirs.push(dir);
  return openStore(loadConfig({ REVIEWZY_DB: join(dir, "reviewzy.db") }));
}

function insertProject(store: Store, slug: string) {
  const row = { id: ulid(), slug, created_at: Date.now() };
  store.db.run("INSERT INTO projects (id, slug, created_at) VALUES (?, ?, ?)", [
    row.id,
    row.slug,
    row.created_at,
  ]);
  return row;
}

/** A draft entry with the given constraints json; returns the row as stored. */
function insertEntry(
  store: Store,
  projectId: string,
  overrides: { status?: string; human_text?: string | null; constraints?: string; anchor_hash?: string } = {},
) {
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
    project_id: projectId,
    file_hash: "filehash-1",
    agent_draft: "hello world draft",
    human_text: null as string | null,
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
  };
  store.db.run(
    `INSERT INTO entries (
      id, project_id, batch_id, repo, file, anchor_text, anchor_before, anchor_after,
      anchor_hash, file_hash, agent_draft, human_text, status, context, constraints,
      filed_by, stale_note, created_at, updated_at, applied_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.project_id ?? projectId,
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

/** The entry row's save-relevant columns, for asserting what a save did and did not write. */
function entryRow(store: Store, id: string) {
  return store.db.query(
    "SELECT status, human_text, updated_at FROM entries WHERE id = ?",
  ).get(id) as { status: string; human_text: string | null; updated_at: number };
}

// Same-ms insertion order is `rowid`, not `id`: a ulid's random bits don't encode recency.
function revisionRows(store: Store, entryId: string) {
  return store.db
    .query("SELECT id, human_text, status, created_at FROM entry_revisions WHERE entry_id = ? ORDER BY created_at, rowid")
    .all(entryId) as { id: string; human_text: string; status: string; created_at: number }[];
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function savedOutcome(outcome: HumanSaveOutcome): Extract<HumanSaveOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error(`expected a saved outcome, got refusal ${outcome.refusal.kind}`);
  return outcome;
}

describe("saveHumanText refusals", () => {
  test("refuses an unknown id", () => {
    const store = openTempStore();
    const outcome = saveHumanText(store, { id: "does-not-exist", text: "prose" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toEqual({ kind: "unknown" });
    store.close();
  });

  test.each(["applied", "rejected"] as const)(
    "refuses a save on a %s entry, naming the status",
    (status) => {
      const store = openTempStore();
      const project = insertProject(store, "alpha");
      const entry = insertEntry(store, project.id, { status });
      const before = entryRow(store, entry.id);

      const outcome = saveHumanText(store, { id: entry.id, text: "new prose" });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.refusal).toEqual({ kind: "status", status });
      // Nothing was written: status, text, and updated_at are untouched, and no revision appeared.
      expect(entryRow(store, entry.id)).toEqual(before);
      expect(revisionRows(store, entry.id)).toHaveLength(0);
      store.close();
    },
  );

  test("refuses empty and whitespace-only text", () => {
    const store = openTempStore();
    const project = insertProject(store, "alpha");
    const entry = insertEntry(store, project.id);

    for (const text of ["", "   ", "\n\t "]) {
      const outcome = saveHumanText(store, { id: entry.id, text });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.refusal).toEqual({ kind: "empty" });
    }
    expect(revisionRows(store, entry.id)).toHaveLength(0);
    store.close();
  });

  test("refuses text over max_len, carrying the limit and the length seen", () => {
    const store = openTempStore();
    const project = insertProject(store, "alpha");
    const entry = insertEntry(store, project.id, { constraints: JSON.stringify({ max_len: 10 }) });

    const outcome = saveHumanText(store, { id: entry.id, text: "12345678901" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toEqual({ kind: "max_len", maxLen: 10, length: 11 });
    expect(revisionRows(store, entry.id)).toHaveLength(0);
    store.close();
  });

  test("saves text at exactly the max_len boundary", () => {
    const store = openTempStore();
    const project = insertProject(store, "alpha");
    const entry = insertEntry(store, project.id, { constraints: JSON.stringify({ max_len: 10 }) });

    expect(savedOutcome(saveHumanText(store, { id: entry.id, text: "1234567890" })).saved).toBe(true);
    store.close();
  });

  test("refuses a missing placeholder, naming it", () => {
    const store = openTempStore();
    const project = insertProject(store, "alpha");
    const entry = insertEntry(store, project.id, {
      constraints: JSON.stringify({ placeholders: ["command", "path"] }),
    });

    // One of the two declared placeholders is present; the missing one is named.
    const outcome = saveHumanText(store, { id: entry.id, text: "Run the command here." });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal).toEqual({ kind: "placeholder", placeholder: "path" });
    expect(revisionRows(store, entry.id)).toHaveLength(0);
    store.close();
  });
});

describe("saveHumanText writes", () => {
  test("saves a draft: one revision row, entry approved, event dispatched after the write", () => {
    const store = openTempStore();
    const project = insertProject(store, "alpha");
    const entry = insertEntry(store, project.id);
    const seen: { id: string; status: string }[] = [];
    store.events.addEventListener(STATUS_CHANGE_EVENT, (event) => {
      seen.push((event as CustomEvent).detail);
    });

    const before = Date.now();
    const outcome = savedOutcome(saveHumanText(store, { id: entry.id, text: "the final prose" }));

    expect(outcome.saved).toBe(true);
    expect(outcome.status).toBe("approved");
    expect(entryRow(store, entry.id)).toEqual({
      status: "approved",
      human_text: "the final prose",
      updated_at: expect.any(Number),
    });
    expect(entryRow(store, entry.id).updated_at).toBeGreaterThanOrEqual(before);

    // Exactly one revision row, recording the entry's status at the moment of the save: the save
    // that approves a draft records "draft".
    const revisions = revisionRows(store, entry.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ human_text: "the final prose", status: "draft" });
    expect(revisions[0]!.created_at).toBeGreaterThanOrEqual(before);

    expect(seen).toEqual([{ id: entry.id, status: "approved" }]);
    store.close();
  });

  test("re-saves an approved entry: appends a revision and stays approved", () => {
    const store = openTempStore();
    const project = insertProject(store, "alpha");
    const entry = insertEntry(store, project.id);

    saveHumanText(store, { id: entry.id, text: "first prose" });
    const second = savedOutcome(saveHumanText(store, { id: entry.id, text: "second prose" }));

    expect(second.saved).toBe(true);
    expect(entryRow(store, entry.id).status).toBe("approved");
    const revisions = revisionRows(store, entry.id);
    expect(revisions).toHaveLength(2);
    // The re-save recorded the status the entry held at that moment: "approved".
    expect(revisions.map((r) => [r.human_text, r.status])).toEqual([
      ["first prose", "draft"],
      ["second prose", "approved"],
    ]);
    store.close();
  });

  test("saving identical text writes nothing and returns the current state", () => {
    const store = openTempStore();
    const project = insertProject(store, "alpha");
    const entry = insertEntry(store, project.id);
    const seen: { id: string; status: string }[] = [];
    store.events.addEventListener(STATUS_CHANGE_EVENT, (event) => {
      seen.push((event as CustomEvent).detail);
    });

    saveHumanText(store, { id: entry.id, text: "the prose" });
    const updatedAt = entryRow(store, entry.id).updated_at;

    const outcome = savedOutcome(saveHumanText(store, { id: entry.id, text: "the prose" }));
    expect(outcome.saved).toBe(false);
    expect(outcome.status).toBe("approved");
    expect(entryRow(store, entry.id).updated_at).toBe(updatedAt);
    expect(revisionRows(store, entry.id)).toHaveLength(1);
    expect(seen).toHaveLength(1);
    store.close();
  });

  test("restoring an old revision writes a new revision and never mutates the old row", () => {
    const store = openTempStore();
    const project = insertProject(store, "alpha");
    const entry = insertEntry(store, project.id);

    saveHumanText(store, { id: entry.id, text: "first" });
    saveHumanText(store, { id: entry.id, text: "second" });
    const firstId = revisionRows(store, entry.id)[0]!.id;

    const outcome = savedOutcome(saveHumanText(store, { id: entry.id, text: "first" }));
    expect(outcome.saved).toBe(true);
    expect(entryRow(store, entry.id).human_text).toBe("first");

    const revisions = revisionRows(store, entry.id);
    expect(revisions).toHaveLength(3);
    // The old row is byte-identical: same id, same text, same status, same timestamp.
    expect(revisions[0]).toMatchObject({ id: firstId, human_text: "first", status: "draft" });
    expect(revisions.map((r) => r.human_text)).toEqual(["first", "second", "first"]);
    store.close();
  });

  test("unparseable or shape-broken constraints are treated as absent", () => {
    const store = openTempStore();
    const project = insertProject(store, "alpha");

    let n = 0;
    for (const constraints of [
      "not json",
      JSON.stringify({ max_len: "two hundred" }),
      JSON.stringify({ placeholders: "command" }),
      JSON.stringify({ max_len: 0 }),
      "[1, 2, 3]",
    ]) {
      n += 1;
      // Each row needs its own anchor: entries are UNIQUE on (project, repo, file, anchor_hash).
      const entry = insertEntry(store, project.id, { constraints, anchor_hash: `hash-${n}` });
      const outcome = savedOutcome(saveHumanText(store, { id: entry.id, text: "any prose" }));
      expect(outcome.saved, constraints).toBe(true);
    }
    store.close();
  });
});

describe("listRevisions", () => {
  test("returns the revisions newest-first, empty when none exist", () => {
    const store = openTempStore();
    const project = insertProject(store, "alpha");
    const entry = insertEntry(store, project.id);

    expect(listRevisions(store, entry.id)).toEqual([]);

    for (const [human_text, created_at] of [
      ["oldest", 1000],
      ["middle", 2000],
      ["newest", 3000],
    ] as const) {
      store.db.run(
        "INSERT INTO entry_revisions (id, entry_id, human_text, status, created_at) VALUES (?, ?, ?, ?, ?)",
        [ulid(), entry.id, human_text, "approved", created_at],
      );
    }
    expect(listRevisions(store, entry.id).map((r) => [r.human_text, r.created_at])).toEqual([
      ["newest", 3000],
      ["middle", 2000],
      ["oldest", 1000],
    ]);
    store.close();
  });

  test("same-millisecond revisions order by insertion, never by id", () => {
    const store = openTempStore();
    const project = insertProject(store, "alpha");
    const entry = insertEntry(store, project.id);
    const now = Date.now();

    // Three rows whose created_at all tie, as a tight loop of real saves can produce. The ids are
    // deliberately chosen non-monotonic (id-a < id-b < id-c is neither insertion order nor its
    // reverse), so an id tie-break fails in every direction: with the tie-break on rowid the reads
    // return recency, and if either read ever fell back to the id column this fails every time.
    // Real same-ms ulids would only fail that regression by chance — a mint spanning a millisecond
    // boundary orders them by timestamp prefix, masking the bug — so chance is not allowed here.
    const rows = [
      { id: "id-c", text: "first" },
      { id: "id-a", text: "second" },
      { id: "id-b", text: "third" },
    ] as const;
    for (const { id, text } of rows) {
      store.db.run(
        "INSERT INTO entry_revisions (id, entry_id, human_text, status, created_at) VALUES (?, ?, ?, ?, ?)",
        [id, entry.id, text, "approved", now],
      );
    }

    expect(listRevisions(store, entry.id).map((r) => r.human_text)).toEqual(["third", "second", "first"]);
    expect(revisionRows(store, entry.id).map((r) => r.human_text)).toEqual(["first", "second", "third"]);
    store.close();
  });
});

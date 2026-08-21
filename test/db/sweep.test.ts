import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { loadConfig } from "../../src/config.ts";
import { archiveCutoff, selectArchiveCandidates, sweepArchive } from "../../src/db/sweep.ts";
import { openStore } from "../../src/db/store.ts";
import type { Store } from "../../src/db/store.ts";
import { startDaemon } from "../../src/daemon/main.ts";

const DAYS = 90;
/** A fixed clock, so every "expired" decision compares against the injected sweep time, never the wall. */
const NOW = 1_700_000_000_000;

const tempDirs: string[] = [];

function openTempStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-sweep-"));
  tempDirs.push(dir);
  return openStore(loadConfig({ REVIEWZY_DB: join(dir, "reviewzy.db") }));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function insertProject(db: Database, slug: string) {
  const row = { id: ulid(), slug, created_at: 1000 };
  db.run("INSERT INTO projects (id, slug, created_at) VALUES (?, ?, ?)", [row.id, row.slug, row.created_at]);
  return row;
}

/** A full applied entry, expired by default; every column carries a distinctive value so a copy can be proven column-for-column. */
function insertEntry(
  db: Database,
  projectId: string,
  overrides: {
    status?: string;
    anchor_hash?: string;
    applied_at?: number | null;
    archived_at?: number | null;
  } = {},
) {
  const row = {
    id: ulid(),
    batch_id: ulid(),
    repo: "https://example.com/repo.git",
    file: "src/index.ts",
    anchor_text: "hello world",
    anchor_before: "line before",
    anchor_after: "line after",
    anchor_hash: "anchor-hash-1",
    project_id: projectId,
    file_hash: "file-hash-1",
    agent_draft: "agent draft",
    human_text: "human text",
    status: "applied",
    context: '{"where":"hero"}',
    constraints: '{"max_len":24}',
    filed_by: "audit-agent",
    stale_note: null,
    applied_hash: "a".repeat(64),
    images: '["https://example.com/shot.png"]',
    created_at: 1000,
    updated_at: 2000,
    applied_at: 0,
    archived_at: null,
    ...overrides,
  };
  db.run(
    `INSERT INTO entries (
      id, project_id, batch_id, repo, file, anchor_text, anchor_before, anchor_after,
      anchor_hash, file_hash, agent_draft, human_text, status, context, constraints,
      filed_by, stale_note, applied_hash, images, created_at, updated_at, applied_at, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      row.applied_hash,
      row.images,
      row.created_at,
      row.updated_at,
      row.applied_at,
      row.archived_at,
    ],
  );
  return row;
}

function insertRevision(
  db: Database,
  entryId: string,
  overrides: { human_text?: string; status?: string; created_at?: number } = {},
) {
  const row = { id: ulid(), entry_id: entryId, human_text: "first save", status: "draft", created_at: 1000, ...overrides };
  db.run("INSERT INTO entry_revisions (id, entry_id, human_text, status, created_at) VALUES (?, ?, ?, ?, ?)", [
    row.id,
    row.entry_id,
    row.human_text,
    row.status,
    row.created_at,
  ]);
  return row;
}

function count(conn: { db: Database }, sql: string, ...params: SQLQueryBindings[]): number {
  return (conn.db.query(sql).get(...params) as { n: number }).n;
}

/** Every entry column except `archived_at`, which the sweep stamps: the copy must match the live row on all of them. */
const ENTRY_COLUMNS =
  "id, project_id, batch_id, repo, file, anchor_text, anchor_before, anchor_after, anchor_hash, file_hash, agent_draft, human_text, status, context, constraints, filed_by, stale_note, applied_hash, images, created_at, updated_at, applied_at";

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

describe("sweepArchive", () => {
  test("an expired applied entry moves to the archive whole: every column lands intact including applied_hash, archived_at stamps the sweep's now, and the live row is gone", () => {
    const store = openTempStore();
    const project = insertProject(store.db, "alpha");
    const entry = insertEntry(store.db, project.id);
    const before = store.db.query(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE id = ?`).get(entry.id) as Record<string, unknown>;

    const moved = sweepArchive(store, NOW, DAYS);

    expect(moved).toBe(1);
    const archived = store.db
      .query(`SELECT ${ENTRY_COLUMNS}, archived_at FROM entries_archive WHERE id = ?`)
      .get(entry.id) as Record<string, unknown> | null;
    expect(archived).not.toBeNull();
    const { archived_at, ...copied } = archived!;
    expect(copied).toEqual(before);
    expect(archived_at).toBe(NOW);
    expect(store.db.query("SELECT id FROM entries WHERE id = ?").get(entry.id)).toBeNull();
    store.close();
  });

  test("its revisions move with it in the same sweep: the archive revisions carry them stamped with the same now, the live revisions table is empty", () => {
    const store = openTempStore();
    const project = insertProject(store.db, "alpha");
    const entry = insertEntry(store.db, project.id);
    const first = insertRevision(store.db, entry.id, { human_text: "first save", status: "draft", created_at: 1000 });
    const second = insertRevision(store.db, entry.id, { human_text: "second save", status: "approved", created_at: 2000 });

    const moved = sweepArchive(store, NOW, DAYS);

    expect(moved).toBe(1);
    const archived = store.db
      .query(
        "SELECT id, entry_id, human_text, status, created_at, archived_at FROM entry_revisions_archive WHERE entry_id = ? ORDER BY created_at",
      )
      .all(entry.id);
    expect(archived).toEqual([
      { id: first.id, entry_id: entry.id, human_text: "first save", status: "draft", created_at: 1000, archived_at: NOW },
      { id: second.id, entry_id: entry.id, human_text: "second save", status: "approved", created_at: 2000, archived_at: NOW },
    ]);
    expect(count(store, "SELECT COUNT(*) AS n FROM entry_revisions WHERE entry_id = ?", entry.id)).toBe(0);
    store.close();
  });

  test("the cutoff is strict: a row applied exactly at the cutoff stays live, one a millisecond past it moves", () => {
    const store = openTempStore();
    const project = insertProject(store.db, "alpha");
    const cutoff = archiveCutoff(NOW, DAYS);
    const atCutoff = insertEntry(store.db, project.id, { anchor_hash: "hash-at", applied_at: cutoff });
    const pastCutoff = insertEntry(store.db, project.id, { anchor_hash: "hash-past", applied_at: cutoff - 1 });

    const moved = sweepArchive(store, NOW, DAYS);

    expect(moved).toBe(1);
    expect(store.db.query("SELECT id FROM entries WHERE id = ?").get(atCutoff.id)).not.toBeNull();
    expect(store.db.query("SELECT id FROM entries_archive WHERE id = ?").get(atCutoff.id)).toBeNull();
    expect(store.db.query("SELECT id FROM entries WHERE id = ?").get(pastCutoff.id)).toBeNull();
    expect(store.db.query("SELECT id FROM entries_archive WHERE id = ?").get(pastCutoff.id)).not.toBeNull();
    store.close();
  });

  test.each(["draft", "approved", "rejected"] as const)("a %s entry never moves, however old its row is", (status) => {
    const store = openTempStore();
    const project = insertProject(store.db, "alpha");
    const entry = insertEntry(store.db, project.id, { status, applied_at: 0 });

    const moved = sweepArchive(store, NOW, DAYS);

    expect(moved).toBe(0);
    expect(store.db.query("SELECT status FROM entries WHERE id = ?").get(entry.id)).toEqual({ status });
    expect(store.db.query("SELECT id FROM entries_archive WHERE id = ?").get(entry.id)).toBeNull();
    store.close();
  });

  test("an applied row with a NULL applied_at never moves, and an archived_at already stamped keeps a live row out of the selection", () => {
    const store = openTempStore();
    const project = insertProject(store.db, "alpha");
    const noStamp = insertEntry(store.db, project.id, { anchor_hash: "hash-null-stamp", applied_at: null });
    const stamped = insertEntry(store.db, project.id, { anchor_hash: "hash-stamped", applied_at: 0, archived_at: 1000 });

    expect(selectArchiveCandidates(store, NOW, DAYS)).toEqual([]);

    const moved = sweepArchive(store, NOW, DAYS);

    expect(moved).toBe(0);
    expect(store.db.query("SELECT id FROM entries WHERE id = ?").get(noStamp.id)).not.toBeNull();
    expect(store.db.query("SELECT id FROM entries WHERE id = ?").get(stamped.id)).not.toBeNull();
    store.close();
  });

  test("a second run over the same data writes nothing: the returned write count is 0", () => {
    const store = openTempStore();
    const project = insertProject(store.db, "alpha");
    const entry = insertEntry(store.db, project.id);
    insertRevision(store.db, entry.id);

    expect(sweepArchive(store, NOW, DAYS)).toBe(1);
    const archivedEntries = count(store, "SELECT COUNT(*) AS n FROM entries_archive");
    const archivedRevisions = count(store, "SELECT COUNT(*) AS n FROM entry_revisions_archive");

    const second = sweepArchive(store, NOW, DAYS);

    expect(second).toBe(0);
    expect(count(store, "SELECT COUNT(*) AS n FROM entries_archive")).toBe(archivedEntries);
    expect(count(store, "SELECT COUNT(*) AS n FROM entry_revisions_archive")).toBe(archivedRevisions);
    store.close();
  });

  test("a candidate flipped after the selection snapshot is skipped at act time and never moved", () => {
    const store = openTempStore();
    const project = insertProject(store.db, "alpha");
    const entry = insertEntry(store.db, project.id);
    insertRevision(store.db, entry.id);

    const candidates = selectArchiveCandidates(store, NOW, DAYS);
    expect(candidates).toEqual([entry.id]);

    // The snapshot is stale now: a concurrent writer (mark_applied's anchor_stale path) moved the
    // entry back to approved between the selection and the act.
    store.db.run("UPDATE entries SET status = 'approved', updated_at = ? WHERE id = ?", [NOW, entry.id]);

    const moved = sweepArchive(store, NOW, DAYS);

    expect(moved).toBe(0);
    expect(store.db.query("SELECT status FROM entries WHERE id = ?").get(entry.id)).toEqual({ status: "approved" });
    expect(store.db.query("SELECT id FROM entries_archive WHERE id = ?").get(entry.id)).toBeNull();
    expect(count(store, "SELECT COUNT(*) AS n FROM entry_revisions WHERE entry_id = ?", entry.id)).toBe(1);
    expect(count(store, "SELECT COUNT(*) AS n FROM entry_revisions_archive WHERE entry_id = ?", entry.id)).toBe(0);
    store.close();
  });

  test("a failure mid-move rolls the whole sweep back: nothing archived, nothing deleted", () => {
    const store = openTempStore();
    const project = insertProject(store.db, "alpha");
    const entry = insertEntry(store.db, project.id);
    insertRevision(store.db, entry.id);

    // The third statement is the live-revisions delete: the throw lands after both archive inserts
    // already ran, so only a rollback can keep the archive tables empty.
    let calls = 0;
    const db = new Proxy(store.db, {
      get(target, prop) {
        if (prop === "run") {
          return (sql: string, params: SQLQueryBindings[]) => {
            calls += 1;
            if (calls === 3) throw new Error("simulated mid-sweep failure");
            return target.run(sql, params);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Database;
    const proxied: Store = { ...store, db };

    expect(() => sweepArchive(proxied, NOW, DAYS)).toThrow("simulated mid-sweep failure");

    expect(store.db.query("SELECT id FROM entries WHERE id = ?").get(entry.id)).not.toBeNull();
    expect(store.db.query("SELECT id FROM entries_archive WHERE id = ?").get(entry.id)).toBeNull();
    expect(count(store, "SELECT COUNT(*) AS n FROM entry_revisions WHERE entry_id = ?", entry.id)).toBe(1);
    expect(count(store, "SELECT COUNT(*) AS n FROM entry_revisions_archive WHERE entry_id = ?", entry.id)).toBe(0);
    store.close();
  });
});

describe("the daemon wiring", () => {
  test("the daemon sweeps once at boot and again on the interval, and clearing the sweep timer in the stop path stops later sweeps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewzy-sweep-boot-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "reviewzy.db");

    // Seeded before the daemon boots: only the boot run can move either. The ancient row pins
    // that the boot sweep ran at all; the two-days-old row moves only because ARCHIVE_AFTER_DAYS
    // flows from config into the sweep — a hardcoded default would keep it.
    const [bootId, twoDaysId]: [string, string] = (() => {
      const seeder = openStore(loadConfig({ REVIEWZY_DB: dbPath }));
      const project = insertProject(seeder.db, "boot");
      const ancient = insertEntry(seeder.db, project.id);
      const twoDaysOld = insertEntry(seeder.db, project.id, {
        anchor_hash: "hash-two-days-old",
        applied_at: Date.now() - 2 * 86_400_000,
      });
      seeder.close();
      return [ancient.id, twoDaysOld.id];
    })();

    const intervalMs = 30;
    const daemon = startDaemon(
      { ...loadConfig({ ARCHIVE_AFTER_DAYS: "1" }), REVIEWZY_PORT: 0, REVIEWZY_DB: dbPath },
      {},
      intervalMs,
    );
    const probe = new Database(dbPath);
    probe.run("PRAGMA busy_timeout = 5000");

    let serverStopped = false;
    const stopServer = async (force: boolean) => {
      if (serverStopped) return;
      serverStopped = true;
      await daemon.server.stop(force);
    };

    try {
      // The boot run happened before startDaemon returned: both rows are already archived.
      expect(count({ db: probe }, "SELECT COUNT(*) AS n FROM entries WHERE id = ?", bootId)).toBe(0);
      expect(count({ db: probe }, "SELECT COUNT(*) AS n FROM entries_archive WHERE id = ?", bootId)).toBe(1);
      expect(count({ db: probe }, "SELECT COUNT(*) AS n FROM entries WHERE id = ?", twoDaysId)).toBe(0);
      expect(count({ db: probe }, "SELECT COUNT(*) AS n FROM entries_archive WHERE id = ?", twoDaysId)).toBe(1);

      // An entry seeded after boot moves on the interval, within two ticks.
      const project = insertProject(probe, "interval");
      const seeded = insertEntry(probe, project.id);
      const movedWithinTicks = await waitUntil(
        () => (probe.query("SELECT COUNT(*) AS n FROM entries_archive WHERE id = ?").get(seeded.id) as { n: number }).n === 1,
        2 * intervalMs + 100,
      );
      expect(movedWithinTicks).toBe(true);

      // The stop path: server stop, then the sweep-timer clear. The store stays open on purpose —
      // a surviving tick would still sweep, so an unmoved row proves the clear stopped the timer.
      await stopServer(false);
      clearInterval(daemon.sweepTimer);

      const afterStop = insertEntry(probe, project.id);
      await new Promise((resolve) => setTimeout(resolve, 2 * intervalMs + 50));
      expect(probe.query("SELECT COUNT(*) AS n FROM entries WHERE id = ?").get(afterStop.id)).toEqual({ n: 1 });
      expect(probe.query("SELECT COUNT(*) AS n FROM entries_archive WHERE id = ?").get(afterStop.id)).toEqual({ n: 0 });
    } finally {
      clearInterval(daemon.sweepTimer);
      await stopServer(true);
      daemon.store.close();
      probe.close();
    }
  });
});

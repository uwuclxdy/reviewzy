import { ulid } from "ulid";
import type { Store } from "./store.ts";

/** The four states of `docs/mcp-contract.md`'s status machine; the schema's CHECK keeps rows inside this domain. */
export type EntryStatus = "draft" | "approved" | "applied" | "rejected";

/**
 * One entry as it crosses into the store: every field already typed, hashed, and stringified.
 * The json boundary belongs to the tool that reads the wire (`src/mcp/file-entries.ts`); nothing
 * here re-parses what it already accepted. `agentDraft`, `contextJson`, and `constraintsJson` are
 * null when the caller did not send the field: a first filing stores the empty default, and a
 * draft re-file keeps the stored value (the schema refuses explicit null, so no caller can
 * express a wipe).
 */
export type NewEntry = {
  readonly repo: string;
  readonly file: string;
  readonly anchorText: string;
  readonly anchorBefore: string;
  readonly anchorAfter: string;
  readonly anchorHash: string;
  readonly fileHash: string;
  readonly agentDraft: string | null;
  readonly contextJson: string | null;
  readonly constraintsJson: string | null;
};

export type FiledEntry = {
  readonly id: string;
  readonly status: EntryStatus;
  readonly deduped: boolean;
  readonly updated: boolean;
};

export type FiledBatch = {
  readonly batchId: string;
  readonly results: readonly FiledEntry[];
};

type ProjectRow = { id: string };
type IdentityRow = { id: string; status: EntryStatus };

/**
 * `INSERT ... ON CONFLICT DO NOTHING` followed by the read: two calls racing to auto-create the
 * same slug both succeed, and the second takes the first's id rather than dying on `UNIQUE(slug)`.
 * Both statements run inside this connection's transaction, and sqlite serializes writers, so no
 * competing write can land between the insert and its select. Concurrent readers under WAL see
 * pre-commit state and are unaffected either way.
 */
function ensureProject(db: Store["db"], slug: string): string {
  db.run("INSERT INTO projects (id, slug, created_at) VALUES (?, ?, ?) ON CONFLICT (slug) DO NOTHING", [
    ulid(),
    slug,
    Date.now(),
  ]);
  const row = db.query("SELECT id FROM projects WHERE slug = ?").get(slug) as ProjectRow | null;
  if (row === null) throw new Error(`reviewzy: project "${slug}" missing right after its own insert`);
  return row.id;
}

/**
 * One entry against the frozen identity key `(project_id, repo, file, anchor_hash)`, honoring the
 * re-file table exactly: no row inserts a second time; a `draft` row is overwritten in place by
 * the fields the newer call carries (and nothing else — the first filing's provenance stays);
 * anything past `draft` is untouched, which is what silences a re-file against a rejected anchor.
 */
function fileOneEntry(
  db: Store["db"],
  projectId: string,
  batchId: string,
  filedBy: string | null,
  entry: NewEntry,
): FiledEntry {
  const existing = db
    .query("SELECT id, status FROM entries WHERE project_id = ? AND repo = ? AND file = ? AND anchor_hash = ?")
    .get(projectId, entry.repo, entry.file, entry.anchorHash) as IdentityRow | null;

  if (existing === null) {
    const id = ulid();
    const now = Date.now();
    db.run(
      `INSERT INTO entries (
        id, project_id, batch_id, repo, file, anchor_text, anchor_before, anchor_after,
        anchor_hash, file_hash, agent_draft, human_text, status, context, constraints,
        filed_by, stale_note, created_at, updated_at, applied_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'draft', ?, ?, ?, NULL, ?, ?, NULL, NULL)`,
      [
        id,
        projectId,
        batchId,
        entry.repo,
        entry.file,
        entry.anchorText,
        entry.anchorBefore,
        entry.anchorAfter,
        entry.anchorHash,
        entry.fileHash,
        entry.agentDraft,
        entry.contextJson ?? "{}",
        entry.constraintsJson ?? "{}",
        filedBy,
        now,
        now,
      ],
    );
    return { id, status: "draft", deduped: false, updated: false };
  }

  if (existing.status === "draft") {
    // `COALESCE(?, column)`: a field the newer call did not carry (null) keeps the stored value.
    // The schema refuses explicit null, so a re-file can only move the fields it names.
    db.run(
      "UPDATE entries SET agent_draft = COALESCE(?, agent_draft), context = COALESCE(?, context), constraints = COALESCE(?, constraints), updated_at = ? WHERE id = ?",
      [entry.agentDraft, entry.contextJson, entry.constraintsJson, Date.now(), existing.id],
    );
    return { id: existing.id, status: "draft", deduped: true, updated: true };
  }

  // approved, applied, rejected: the existing entry answers, and nothing is written. The cast is
  // paid for by the schema's CHECK constraint: no other value can sit in this column.
  return { id: existing.id, status: existing.status, deduped: true, updated: false };
}

/**
 * Files one `file_entries` call: a single minted batch id shared by every entry, the project
 * auto-created on its first appearance, and every entry resolved against the identity key — all in
 * one transaction, so a caller sees either the whole batch or none of it.
 */
export function fileEntries(
  store: Store,
  projectSlug: string,
  filedBy: string | null,
  entries: readonly NewEntry[],
): FiledBatch {
  const batchId = ulid();
  const write = store.db.transaction(() => {
    const projectId = ensureProject(store.db, projectSlug);
    return entries.map((entry) => fileOneEntry(store.db, projectId, batchId, filedBy, entry));
  });
  return { batchId, results: write() };
}

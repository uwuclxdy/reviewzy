import type { SQLQueryBindings } from "bun:sqlite";
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

/** One entry row as `list_entries` returns it: the columns `docs/mcp-contract.md`'s entry schema lists, `archived_at` included (every v1 row carries null — the archive sweep is not built yet). */
export type EntryRow = {
  readonly id: string;
  readonly project_id: string;
  readonly batch_id: string;
  readonly repo: string;
  readonly file: string;
  readonly anchor_text: string;
  readonly anchor_before: string;
  readonly anchor_after: string;
  readonly anchor_hash: string;
  readonly file_hash: string;
  readonly agent_draft: string | null;
  readonly human_text: string | null;
  readonly status: EntryStatus;
  readonly context: string;
  readonly constraints: string;
  readonly filed_by: string | null;
  readonly stale_note: string | null;
  readonly applied_hash: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly applied_at: number | null;
  readonly archived_at: number | null;
};

/**
 * Every filter is `| undefined`, never optional: the tool always passes all of them, so the query
 * builder can test presence with `!== undefined` and the caller never wonders which keys exist.
 */
export type ListEntriesFilter = {
  readonly projectId: string | undefined;
  readonly status: EntryStatus | undefined;
  readonly ids: readonly string[] | undefined;
  readonly q: string | undefined;
  readonly limit: number;
  readonly cursor: string | undefined;
};

export type ListEntriesResult = {
  readonly rows: readonly EntryRow[];
  /**
   * The next page's cursor, present only when the page is full: `rows.length === limit` means more
   * rows may exist beyond the last id. An absent cursor means the walk is exhausted, and an empty
   * page never carries one.
   */
  readonly nextCursor: string | null;
};

/**
 * One approved row as `fetch_approved` returns it: the applying needs the contract's parenthetical
 * "text + anchor + constraints" and nothing else — no `context`, no `status`, since everything here
 * is approved by construction. `constraints` stays the stored string; the tool owns the parse.
 */
export type ApprovedEntryRow = {
  readonly id: string;
  readonly repo: string;
  readonly file: string;
  readonly anchor_text: string;
  readonly anchor_before: string;
  readonly anchor_after: string;
  readonly anchor_hash: string;
  readonly file_hash: string;
  readonly human_text: string | null;
  readonly constraints: string;
};

export type ApprovedEntriesFilter = {
  readonly ids: readonly string[] | undefined;
  readonly since: string | undefined;
};

export type ApprovedEntriesResult = {
  readonly rows: readonly ApprovedEntryRow[];
  /**
   * The last returned id, present only when the page is full: `rows.length === 50` means more rows
   * may exist beyond it. An absent `nextSince` means the walk is exhausted, and an empty page never
   * carries one.
   */
  readonly nextSince: string | null;
};

/**
 * Resolves a slug to its project id. Read tools call this and refuse on `null`: the contract's
 * error table makes an unknown project a business refusal on reads, and only `ensureProject`
 * (the write path) may mint a project.
 */
export function projectIdBySlug(store: Store, slug: string): string | null {
  const row = store.db.query("SELECT id FROM projects WHERE slug = ?").get(slug) as ProjectRow | null;
  return row?.id ?? null;
}

/**
 * `INSERT ... ON CONFLICT DO NOTHING` followed by the read: two calls racing to auto-create the
 * same slug both succeed, and the second takes the first's id rather than dying on `UNIQUE(slug)`.
 * Both statements run inside this connection's transaction, and sqlite serializes writers, so no
 * competing write can land between the insert and its select. Concurrent readers under WAL see
 * pre-commit state and are unaffected either way.
 */
function ensureProject(store: Store, slug: string): string {
  store.db.run("INSERT INTO projects (id, slug, created_at) VALUES (?, ?, ?) ON CONFLICT (slug) DO NOTHING", [
    ulid(),
    slug,
    Date.now(),
  ]);
  const row = projectIdBySlug(store, slug);
  if (row === null) throw new Error(`reviewzy: project "${slug}" missing right after its own insert`);
  return row;
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
    const projectId = ensureProject(store, projectSlug);
    return entries.map((entry) => fileOneEntry(store.db, projectId, batchId, filedBy, entry));
  });
  return { batchId, results: write() };
}

/** The `fetch_approved` page size `docs/mcp-contract.md` pins: 50, fixed server-side. */
const APPROVED_PAGE_SIZE = 50;

/** The columns `docs/mcp-contract.md`'s entry schema names; the one place the output row's shape is spelled out in SQL. */
const ENTRY_COLUMNS = [
  "id", "project_id", "batch_id", "repo", "file", "anchor_text", "anchor_before",
  "anchor_after", "anchor_hash", "file_hash", "agent_draft", "human_text", "status",
  "context", "constraints", "filed_by", "stale_note", "applied_hash", "created_at", "updated_at", "applied_at", "archived_at",
] as const;

/**
 * The `list_entries` read. Every filter is optional and combines with AND; rows come back in
 * ascending id order (ulids sort chronologically), and `cursor` continues the walk from after that
 * id — keyset pagination, so a page is exactly the rows between the cursor and the limit, with no
 * way to duplicate or skip one.
 */
export function listEntries(store: Store, filter: ListEntriesFilter): ListEntriesResult {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (filter.projectId !== undefined) {
    where.push("project_id = ?");
    params.push(filter.projectId);
  }
  if (filter.status !== undefined) {
    where.push("status = ?");
    params.push(filter.status);
  }
  if (filter.ids !== undefined) {
    // The zod boundary refuses an empty list, so this never emits `IN ()` — which sqlite would
    // accept as a no-match, not an error: a direct call with `ids: []` returns no rows.
    where.push(`id IN (${filter.ids.map(() => "?").join(", ")})`);
    params.push(...filter.ids);
  }
  if (filter.q !== undefined) {
    // `instr(lower(...), lower(?)) > 0` is a literal substring: `%` and `_` in the query match
    // themselves, unlike a LIKE pattern. `lower` folds ASCII case only — the same fold LIKE does.
    where.push(
      `(instr(lower(file), lower(?)) > 0 OR instr(lower(anchor_text), lower(?)) > 0 OR instr(lower(agent_draft), lower(?)) > 0 OR instr(lower(human_text), lower(?)) > 0)`,
    );
    params.push(filter.q, filter.q, filter.q, filter.q);
  }
  if (filter.cursor !== undefined) {
    where.push("id > ?");
    params.push(filter.cursor);
  }

  const sql = `SELECT ${ENTRY_COLUMNS.join(", ")} FROM entries${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id LIMIT ?`;
  params.push(filter.limit);

  const rows = store.db.query(sql).all(...params) as EntryRow[];
  const nextCursor = rows.length === filter.limit ? rows[rows.length - 1]!.id : null;
  return { rows, nextCursor };
}

/**
 * The `fetch_approved` read. The status is not a filter: the tool's invariant is `'approved'`
 * (a draft, applied, or rejected row never leaves this query), and the page size is the contract's
 * fixed 50 — the client has no limit param, so this number is the whole page contract. `ids` and
 * `since` combine with AND, and `since` is the same keyset the list tool uses, so a resumed walk
 * cannot duplicate or skip a row.
 */
export function approvedEntries(
  store: Store,
  projectId: string,
  filter: ApprovedEntriesFilter,
): ApprovedEntriesResult {
  const where = ["project_id = ?", "status = 'approved'"];
  const params: SQLQueryBindings[] = [projectId];

  if (filter.ids !== undefined) {
    // The zod boundary refuses an empty list, so this never emits `IN ()` — which sqlite would
    // accept as a no-match, not an error: a direct call with `ids: []` returns no rows.
    where.push(`id IN (${filter.ids.map(() => "?").join(", ")})`);
    params.push(...filter.ids);
  }
  if (filter.since !== undefined) {
    where.push("id > ?");
    params.push(filter.since);
  }

  const sql = `SELECT id, repo, file, anchor_text, anchor_before, anchor_after, anchor_hash, file_hash, human_text, constraints FROM entries WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`;
  params.push(APPROVED_PAGE_SIZE);

  const rows = store.db.query(sql).all(...params) as ApprovedEntryRow[];
  const nextSince = rows.length === APPROVED_PAGE_SIZE ? rows[rows.length - 1]!.id : null;
  return { rows, nextSince };
}

/** The two outcomes `mark_applied` may report: the text was applied, or the anchor no longer matches. */
export type ApplyResult = "applied" | "anchor_stale";

export type MarkAppliedInput = {
  readonly id: string;
  readonly result: ApplyResult;
  /** The sha256 hex of the text that was applied; null when the call omitted it. */
  readonly appliedHash: string | null;
  /** What the anchor matched instead; null when the call omitted it. */
  readonly foundText: string | null;
};

/** Everything the store refuses, in the contract's terms; the tool formats the message naming the id. */
export type MarkAppliedRefusal =
  | { readonly kind: "unknown" }
  | { readonly kind: "status"; readonly status: EntryStatus };

export type MarkAppliedOutcome =
  | { readonly ok: true; readonly status: "applied" | "approved" }
  | { readonly ok: false; readonly refusal: MarkAppliedRefusal };

/**
 * The `mark_applied` write: the whole agent-side transition surface, owned here so no tool layer
 * ever decides a status change. The contract's matrix is exhaustive — `approved`→`applied`, and
 * `approved`|`applied`→`approved` on a stale anchor — and every other (id, status) pair is a
 * refusal carrying the status the tool names. The dashboard's transitions (`draft`→`approved`,
 * →`rejected`) are not expressible here, which is what keeps an agent from ever reaching either
 * state. A refusal returns before any write, so the row is untouched, `updated_at` included.
 */
export function markApplied(store: Store, input: MarkAppliedInput): MarkAppliedOutcome {
  const row = store.db.query("SELECT status FROM entries WHERE id = ?").get(input.id) as
    | { status: EntryStatus }
    | null;
  if (row === null) return { ok: false, refusal: { kind: "unknown" } };

  const now = Date.now();
  if (input.result === "applied") {
    if (row.status !== "approved") {
      return { ok: false, refusal: { kind: "status", status: row.status } };
    }
    // `COALESCE(?, applied_hash)` is the pinned semantics whole: a call with the hash overwrites
    // any earlier value, a call without one leaves the stored value alone.
    store.db.run(
      "UPDATE entries SET status = 'applied', applied_at = ?, updated_at = ?, applied_hash = COALESCE(?, applied_hash) WHERE id = ?",
      [now, now, input.appliedHash, input.id],
    );
    return { ok: true, status: "applied" };
  }

  // anchor_stale: the entry stays or returns to `approved` with the note. The note is written even
  // when `found_text` is absent — the pinned rule is stale_note = found_text, null included, so a
  // stale report without the found text clears a previous note instead of keeping a stale one.
  // `applied_at` and `applied_hash` are only ever written by an apply; a stale report leaves the
  // last apply's stamp alone.
  if (row.status !== "approved" && row.status !== "applied") {
    return { ok: false, refusal: { kind: "status", status: row.status } };
  }
  store.db.run("UPDATE entries SET status = 'approved', stale_note = ?, updated_at = ? WHERE id = ?", [
    input.foundText,
    now,
    input.id,
  ]);
  return { ok: true, status: "approved" };
}

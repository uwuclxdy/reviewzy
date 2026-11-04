import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { projectIdBySlug } from "./queries.ts";
import type { Store } from "./store.ts";
import { parseBannedWords, parseGlossary, upsertStyleGuide, type StyleGuideInput } from "./style-guide.ts";

/** One `style_guide_drafts` row as stored: the json columns are opaque strings to every reader. */
export type StyleGuideDraftRow = {
  readonly id: string;
  readonly project_id: string;
  readonly markdown: string;
  readonly banned_words: string;
  readonly glossary: string;
};

/** The one refusal approving a draft knows: no proposal is waiting for the project. */
export type ApproveDraftRefusal = { readonly kind: "no_draft" };

/** Approving publishes the proposal into the live guide; a refusal writes nothing. */
export type ApproveDraftOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: ApproveDraftRefusal };

/**
 * Resolves a slug to its project id for every draft write. Same shape as style-guide.ts's
 * private `resolveProjectId`, minus its global-row arm: a draft addresses a project only, and a
 * proposal never mints one — `file_entries` is the store's only project-creating write.
 */
function resolveProjectId(store: Store, slug: string): string {
  const id = projectIdBySlug(store, slug);
  if (id === null) {
    throw new Error(
      `reviewzy: fileStyleGuideDraft: project "${slug}" does not exist; file an entry into it first`,
    );
  }
  return id;
}

/**
 * Upserts the one draft a project can hold: a first proposal inserts, a re-file replaces the
 * standing one in place. The project must already exist — the mcp tool refuses an unknown slug
 * by name before this runs, and the refusal here is the backstop for a direct caller.
 */
export function fileStyleGuideDraft(store: Store, projectSlug: string, input: StyleGuideInput): void {
  const projectId = resolveProjectId(store, projectSlug);
  const now = Date.now();
  const write = store.db.transaction(() => {
    const existing = store.db.query("SELECT id FROM style_guide_drafts WHERE project_id = ?").get(projectId) as
      | { id: string }
      | null;
    if (existing === null) {
      store.db.run(
        `INSERT INTO style_guide_drafts (id, project_id, markdown, banned_words, glossary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [ulid(), projectId, input.markdown, JSON.stringify(input.bannedWords), JSON.stringify(input.glossary), now, now],
      );
    } else {
      store.db.run(
        "UPDATE style_guide_drafts SET markdown = ?, banned_words = ?, glossary = ?, updated_at = ? WHERE id = ?",
        [input.markdown, JSON.stringify(input.bannedWords), JSON.stringify(input.glossary), now, existing.id],
      );
    }
  });
  write();
}

/** The stored draft read back typed, the read side of `fileStyleGuideDraft`: the dashboard renders and edits it, and a row a future or hand-edited store wrote reads as empty values, never throws. Null when the project has no draft. */
export function readStyleGuideDraft(store: Store, projectSlug: string): StyleGuideInput | null {
  const row = store.db
    .query(
      `SELECT d.id, d.project_id, d.markdown, d.banned_words, d.glossary
       FROM style_guide_drafts d JOIN projects p ON p.id = d.project_id WHERE p.slug = ?`,
    )
    .get(projectSlug) as StyleGuideDraftRow | null;
  if (row === null) return null;
  return {
    markdown: row.markdown,
    bannedWords: parseBannedWords(row.banned_words),
    glossary: parseGlossary(row.glossary),
  };
}

/**
 * A hash of the values a draft card renders: the token the card's forms carry so a click binds to
 * the bytes the human saw. A re-file updates the standing row in place and its row id survives, so
 * only this fingerprint tells a decision made on rendered bytes apart from the row standing now.
 */
export function styleGuideDraftFingerprint(draft: StyleGuideInput): string {
  return createHash("sha256")
    .update(JSON.stringify([draft.markdown, [...draft.bannedWords], Object.entries(draft.glossary)]))
    .digest("hex");
}

/**
 * The human's approve: the draft's typed values become the project's live row and the draft row
 * is deleted, in one transaction — a crash between the two must not leave a live guide plus the
 * proposal it already became. `upsertStyleGuide` opens its own transaction, so this one nests
 * through it as a savepoint (measured on bun 1.4.1: a rolled-back outer undoes the inner
 * transaction's writes). Refusing when no draft exists keeps the live guide human-authored even
 * on a double click: nothing is written on a refusal.
 */
export function approveStyleGuideDraft(store: Store, projectSlug: string): ApproveDraftOutcome {
  const draft = readStyleGuideDraft(store, projectSlug);
  if (draft === null) return { ok: false, refusal: { kind: "no_draft" } };

  const write = store.db.transaction(() => {
    upsertStyleGuide(store, projectSlug, draft);
    store.db.run(
      "DELETE FROM style_guide_drafts WHERE project_id = (SELECT id FROM projects WHERE slug = ?)",
      [projectSlug],
    );
  });
  write();
  return { ok: true };
}

/**
 * The human's save-as-approval: the typed form values become the live row and any standing draft is
 * spent, in one transaction — a crash between the two must not leave the human's saved guide beside
 * the proposal it replaced, where a later Approve would overwrite the human's words. The global row
 * (null slug) holds no drafts and clears nothing. `upsertStyleGuide` opens its own transaction, so
 * this one nests through it as a savepoint, as in `approveStyleGuideDraft`.
 */
export function saveStyleGuideSection(store: Store, projectSlug: string | null, input: StyleGuideInput): void {
  if (projectSlug === null) {
    upsertStyleGuide(store, null, input);
    return;
  }
  const write = store.db.transaction(() => {
    upsertStyleGuide(store, projectSlug, input);
    store.db.run(
      "DELETE FROM style_guide_drafts WHERE project_id = (SELECT id FROM projects WHERE slug = ?)",
      [projectSlug],
    );
  });
  write();
}

/**
 * The human's discard: the draft row is deleted, the live guide untouched. Returns whether a row
 * was deleted, so a second discard reports nothing-to-discard instead of a false confirmation.
 */
export function discardStyleGuideDraft(store: Store, projectSlug: string): boolean {
  const result = store.db.run(
    "DELETE FROM style_guide_drafts WHERE project_id = (SELECT id FROM projects WHERE slug = ?)",
    [projectSlug],
  );
  return result.changes > 0;
}

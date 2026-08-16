import { ulid } from "ulid";
import { projectIdBySlug } from "./queries.ts";
import type { Store } from "./store.ts";

/** One `style_guides` row as stored: the json columns are opaque strings to every reader. */
export type StyleGuideRow = {
  readonly id: string;
  readonly project_id: string | null;
  readonly markdown: string;
  readonly banned_words: string;
  readonly glossary: string;
};

/** The typed shape every writer hands the store; the json encoding happens here, never at a call site. */
export type StyleGuideInput = {
  readonly markdown: string;
  readonly bannedWords: readonly string[];
  readonly glossary: Readonly<Record<string, string>>;
};

/**
 * Upserts one guide row: `projectSlug` null addresses the single global row, a slug its project
 * row. The project must already exist — the dashboard editor (queue task 15) only ever edits
 * projects that have entries, and reads never create one, so a slug that resolves to nothing is a
 * caller bug, refused by name rather than minted.
 */
function resolveProjectId(store: Store, slug: string): string {
  const id = projectIdBySlug(store, slug);
  if (id === null) {
    throw new Error(
      `reviewzy: upsertStyleGuide: project "${slug}" does not exist; file an entry into it first, or pass null for the global row`,
    );
  }
  return id;
}

export function upsertStyleGuide(store: Store, projectSlug: string | null, input: StyleGuideInput): void {
  const projectId = projectSlug === null ? null : resolveProjectId(store, projectSlug);
  const now = Date.now();
  const write = store.db.transaction(() => {
    // `IS ?` over `= ?`: a bound NULL must still match the global row, and `= NULL` never matches.
    const existing = store.db.query("SELECT id FROM style_guides WHERE project_id IS ?").get(projectId) as
      | { id: string }
      | null;
    if (existing === null) {
      store.db.run(
        `INSERT INTO style_guides (id, project_id, markdown, banned_words, glossary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [ulid(), projectId, input.markdown, JSON.stringify(input.bannedWords), JSON.stringify(input.glossary), now, now],
      );
    } else {
      store.db.run(
        "UPDATE style_guides SET markdown = ?, banned_words = ?, glossary = ?, updated_at = ? WHERE id = ?",
        [input.markdown, JSON.stringify(input.bannedWords), JSON.stringify(input.glossary), now, existing.id],
      );
    }
  });
  write();
}

/** The stored json array, or the empty list when it is not an array of strings: only the editor (task 15) writes these columns, so a malformed value is a foreign or hand-edited row, not something to crash a read over. */
function parseBannedWords(json: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {
    // fall through to the empty list
  }
  return [];
}

/** The stored json map, or the empty map when it is not an object of strings; same tolerance as `parseBannedWords`. */
function parseGlossary(json: string): Readonly<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.values(parsed).every((value) => typeof value === "string")
    ) {
      return parsed as Record<string, string>;
    }
  } catch {
    // fall through to the empty map
  }
  return {};
}

/** A stored item cannot carry a line break into the merged markdown: the break would render as a new bullet or a broken `key: value` line, saying things no stored item said. Foreign rows are tolerated, never their line breaks. */
function renderItem(item: string): string {
  return item.replace(/[\r\n]+/g, " ");
}

/**
 * The merged style guide `docs/mcp-contract.md`'s resource section pins: the global row's markdown,
 * a blank line, the project row's markdown, then the union of banned words (global items first,
 * each once, at its first occurrence) and the glossary (global entries first, a key both rows
 * define rendering the project value, project-only keys appended). Blocks join with exactly one
 * blank line and the stored markdown is trimmed of trailing whitespace so an editor's trailing
 * newline cannot stack blank lines. Both rows are optional: no rows at all renders the empty
 * string. Deterministic for any fixed store.
 *
 * Queue task 8 (`fetch_approved`) embeds this same text, so this is the one place the merge is
 * spelled out.
 */
export function mergedStyleGuide(store: Store, projectSlug: string): string {
  const globalRow = store.db.query(
    "SELECT id, project_id, markdown, banned_words, glossary FROM style_guides WHERE project_id IS NULL",
  ).get() as StyleGuideRow | null;
  const projectRow = store.db.query(
    `SELECT s.id, s.project_id, s.markdown, s.banned_words, s.glossary
     FROM style_guides s JOIN projects p ON p.id = s.project_id WHERE p.slug = ?`,
  ).get(projectSlug) as StyleGuideRow | null;

  const blocks: string[] = [];
  for (const markdown of [globalRow?.markdown, projectRow?.markdown]) {
    const trimmed = markdown?.trimEnd() ?? "";
    if (trimmed !== "") blocks.push(trimmed);
  }

  const banned: string[] = [];
  const seen = new Set<string>();
  for (const word of [...parseBannedWords(globalRow?.banned_words ?? "[]"), ...parseBannedWords(projectRow?.banned_words ?? "[]")]) {
    if (!seen.has(word)) {
      seen.add(word);
      banned.push(word);
    }
  }
  // An empty word bans nothing and an empty key names no term: each would render a dangling bullet
  // ("- " or "- : value"), so both are no items at all. Empty values are different — the
  // project-wins `??` below makes an intentionally empty project value a deliberate override.
  const bannedLines = banned.filter((word) => word !== "").map((word) => `- ${renderItem(word)}`);
  if (bannedLines.length > 0) blocks.push(`## banned\n${bannedLines.join("\n")}`);

  const glossary: [string, string][] = [];
  const globalGlossary = parseGlossary(globalRow?.glossary ?? "{}");
  const projectGlossary = parseGlossary(projectRow?.glossary ?? "{}");
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(globalGlossary)) {
    // The project wins a key both define; `??` falls through only on null/undefined, so an
    // intentionally empty project value renders as empty.
    glossary.push([key, projectGlossary[key] ?? value]);
    keys.add(key);
  }
  for (const [key, value] of Object.entries(projectGlossary)) {
    if (!keys.has(key)) {
      glossary.push([key, value]);
      keys.add(key);
    }
  }
  const glossaryLines = glossary
    .filter(([key]) => key !== "")
    .map(([key, value]) => `- ${renderItem(key)}: ${renderItem(value)}`);
  if (glossaryLines.length > 0) blocks.push(`## glossary\n${glossaryLines.join("\n")}`);

  return blocks.join("\n\n");
}

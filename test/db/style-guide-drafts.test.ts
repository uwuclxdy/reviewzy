import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { loadConfig } from "../../src/config.ts";
import { mergedStyleGuide, readStyleGuideSection, upsertStyleGuide } from "../../src/db/style-guide.ts";
import {
  approveStyleGuideDraft,
  discardStyleGuideDraft,
  fileStyleGuideDraft,
  readStyleGuideDraft,
} from "../../src/db/style-guide-drafts.ts";
import { openStore } from "../../src/db/store.ts";
import type { Store } from "../../src/db/store.ts";

const tempDirs: string[] = [];

function openTempStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-style-guide-drafts-"));
  tempDirs.push(dir);
  return openStore(loadConfig({ REVIEWZY_DB: join(dir, "reviewzy.db") }));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** A project row for the slug a draft addresses; a proposal never mints one, so the tests plant it the way entries do not. */
function insertProject(store: Store, slug: string): void {
  store.db.run("INSERT INTO projects (id, slug, created_at) VALUES (?, ?, ?)", [ulid(), slug, Date.now()]);
}

/** A raw style_guide_drafts row, bypassing the typed helper: how a row written by a future or hand-edited store can look. */
function insertRawDraft(store: Store, slug: string, row: Record<string, string>): void {
  const projectId = store.db.query("SELECT id FROM projects WHERE slug = ?").get(slug) as { id: string };
  const now = Date.now();
  store.db.run(
    `INSERT INTO style_guide_drafts (id, project_id, markdown, banned_words, glossary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ulid(), projectId.id, row.markdown ?? "", row.banned_words ?? "[]", row.glossary ?? "{}", now, now],
  );
}

describe("fileStyleGuideDraft", () => {
  test("files a draft that reads back typed and stays out of the live guide and the merge", () => {
    const store = openTempStore();
    insertProject(store, "app");
    upsertStyleGuide(store, null, { markdown: "Global rules.", bannedWords: [], glossary: {} });

    fileStyleGuideDraft(store, "app", {
      markdown: "Project rules.",
      bannedWords: ["utilize"],
      glossary: { widget: "the widget slot" },
    });

    expect(readStyleGuideDraft(store, "app")).toEqual({
      markdown: "Project rules.",
      bannedWords: ["utilize"],
      glossary: { widget: "the widget slot" },
    });
    // Inert until approval: the merge reads style_guides only.
    expect(mergedStyleGuide(store, "app")).toBe("Global rules.");
    expect(store.db.query("SELECT COUNT(*) AS n FROM style_guides WHERE project_id IS NOT NULL").get()).toEqual({ n: 0 });
    store.close();
  });

  test("a re-file replaces the standing draft: still one row, carrying the newer values", () => {
    const store = openTempStore();
    insertProject(store, "app");
    fileStyleGuideDraft(store, "app", { markdown: "First.", bannedWords: [], glossary: {} });
    fileStyleGuideDraft(store, "app", {
      markdown: "Second.",
      bannedWords: ["leverage"],
      glossary: { widget: "a screen element" },
    });

    expect(readStyleGuideDraft(store, "app")).toEqual({
      markdown: "Second.",
      bannedWords: ["leverage"],
      glossary: { widget: "a screen element" },
    });
    expect(store.db.query("SELECT COUNT(*) AS n FROM style_guide_drafts").get()).toEqual({ n: 1 });
    store.close();
  });

  test("an unknown project is refused by name and creates nothing", () => {
    const store = openTempStore();
    expect(() => fileStyleGuideDraft(store, "ghost", { markdown: "rules", bannedWords: [], glossary: {} })).toThrow(
      /ghost/,
    );
    expect(store.db.query("SELECT COUNT(*) AS n FROM projects WHERE slug = 'ghost'").get()).toEqual({ n: 0 });
    expect(store.db.query("SELECT COUNT(*) AS n FROM style_guide_drafts").get()).toEqual({ n: 0 });
    store.close();
  });
});

describe("readStyleGuideDraft", () => {
  test("a project with no draft reads null", () => {
    const store = openTempStore();
    insertProject(store, "app");
    expect(readStyleGuideDraft(store, "app")).toBeNull();
    store.close();
  });

  test("malformed json columns read as empty values, never throwing", () => {
    const store = openTempStore();
    insertProject(store, "app");
    insertRawDraft(store, "app", { markdown: "Rules.", banned_words: "not json", glossary: "[1,2]" });

    expect(readStyleGuideDraft(store, "app")).toEqual({ markdown: "Rules.", bannedWords: [], glossary: {} });
    store.close();
  });
});

describe("approveStyleGuideDraft", () => {
  test("publishes the draft into the live guide and clears it", () => {
    const store = openTempStore();
    insertProject(store, "app");
    upsertStyleGuide(store, null, { markdown: "Global rules.", bannedWords: [], glossary: {} });
    fileStyleGuideDraft(store, "app", {
      markdown: "Project rules.",
      bannedWords: ["utilize"],
      glossary: { widget: "the widget slot" },
    });

    expect(approveStyleGuideDraft(store, "app")).toEqual({ ok: true });

    expect(mergedStyleGuide(store, "app")).toBe(
      "Global rules.\n\nProject rules.\n\n## banned\n- utilize\n\n## glossary\n- widget: the widget slot",
    );
    expect(readStyleGuideDraft(store, "app")).toBeNull();
    store.close();
  });

  test("refuses when no draft exists, writing nothing", () => {
    const store = openTempStore();
    insertProject(store, "app");
    upsertStyleGuide(store, "app", { markdown: "Live rules.", bannedWords: [], glossary: {} });

    expect(approveStyleGuideDraft(store, "app")).toEqual({ ok: false, refusal: { kind: "no_draft" } });
    expect(readStyleGuideSection(store, "app")).toEqual({ markdown: "Live rules.", bannedWords: [], glossary: {} });
    store.close();
  });

  test("a second approve after a successful one refuses too", () => {
    const store = openTempStore();
    insertProject(store, "app");
    fileStyleGuideDraft(store, "app", { markdown: "Rules.", bannedWords: [], glossary: {} });
    expect(approveStyleGuideDraft(store, "app")).toEqual({ ok: true });

    expect(approveStyleGuideDraft(store, "app")).toEqual({ ok: false, refusal: { kind: "no_draft" } });
    store.close();
  });
});

describe("discardStyleGuideDraft", () => {
  test("deletes the draft and answers true, leaving the live guide alone; a second discard answers false", () => {
    const store = openTempStore();
    insertProject(store, "app");
    upsertStyleGuide(store, "app", { markdown: "Live rules.", bannedWords: [], glossary: {} });
    fileStyleGuideDraft(store, "app", { markdown: "Proposal.", bannedWords: [], glossary: {} });

    expect(discardStyleGuideDraft(store, "app")).toBe(true);
    expect(readStyleGuideDraft(store, "app")).toBeNull();
    expect(readStyleGuideSection(store, "app")).toEqual({ markdown: "Live rules.", bannedWords: [], glossary: {} });

    expect(discardStyleGuideDraft(store, "app")).toBe(false);
    store.close();
  });
});

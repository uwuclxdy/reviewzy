import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { loadConfig } from "../../src/config.ts";
import { mergedStyleGuide, upsertStyleGuide } from "../../src/db/style-guide.ts";
import { openStore } from "../../src/db/store.ts";
import type { Store } from "../../src/db/store.ts";

const tempDirs: string[] = [];

function openTempStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-style-guide-"));
  tempDirs.push(dir);
  return openStore(loadConfig({ REVIEWZY_DB: join(dir, "reviewzy.db") }));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** A project row for the slug a guide row references; style_guides has no ON CONFLICT path of its own. */
function insertProject(store: Store, slug: string): void {
  store.db.run("INSERT INTO projects (id, slug, created_at) VALUES (?, ?, ?)", [ulid(), slug, Date.now()]);
}

/** A raw style_guides row, bypassing the typed helper: how a row written by a future or hand-edited store can look. */
function insertRawGuide(store: Store, projectId: string | null, row: Record<string, string>): void {
  const now = Date.now();
  store.db.run(
    `INSERT INTO style_guides (id, project_id, markdown, banned_words, glossary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      ulid(),
      projectId,
      row.markdown ?? "",
      row.banned_words ?? "[]",
      row.glossary ?? "{}",
      now,
      now,
    ],
  );
}

describe("mergedStyleGuide", () => {
  test("no rows at all renders the empty string", () => {
    const store = openTempStore();
    expect(mergedStyleGuide(store, "app")).toBe("");
  });

  test("a project without a guide row renders the global guide alone", () => {
    const store = openTempStore();
    upsertStyleGuide(store, null, {
      markdown: "# Voice\n\nBe plain.",
      bannedWords: ["leverage"],
      glossary: { widget: "a screen element" },
    });

    expect(mergedStyleGuide(store, "app")).toBe(
      "# Voice\n\nBe plain.\n\n## banned\n- leverage\n\n## glossary\n- widget: a screen element",
    );
  });

  test("project markdown appends below the global markdown with a blank line", () => {
    const store = openTempStore();
    upsertStyleGuide(store, null, { markdown: "Global rules.", bannedWords: [], glossary: {} });
    insertProject(store, "app");
    upsertStyleGuide(store, "app", { markdown: "Project rules.", bannedWords: [], glossary: {} });

    expect(mergedStyleGuide(store, "app")).toBe("Global rules.\n\nProject rules.");
  });

  test("a project row alone renders its own markdown, with no leading blank line", () => {
    const store = openTempStore();
    insertProject(store, "app");
    upsertStyleGuide(store, "app", { markdown: "Project rules.", bannedWords: [], glossary: {} });

    expect(mergedStyleGuide(store, "app")).toBe("Project rules.");
  });

  test("banned words union renders global items first, then project-only items, each once", () => {
    const store = openTempStore();
    upsertStyleGuide(store, null, { markdown: "", bannedWords: ["leverage", "awesome"], glossary: {} });
    insertProject(store, "app");
    upsertStyleGuide(store, "app", { markdown: "", bannedWords: ["leverage", "leverage", "utilize"], glossary: {} });

    expect(mergedStyleGuide(store, "app")).toBe("## banned\n- leverage\n- awesome\n- utilize");
  });

  test("glossary renders global entries first, and a key defined in both resolves to the project", () => {
    const store = openTempStore();
    upsertStyleGuide(store, null, {
      markdown: "",
      bannedWords: [],
      glossary: { widget: "a screen element", banner: "top strip" },
    });
    insertProject(store, "app");
    upsertStyleGuide(store, "app", {
      markdown: "",
      bannedWords: [],
      glossary: { banner: "hero image", cta: "call to action" },
    });

    expect(mergedStyleGuide(store, "app")).toBe(
      "## glossary\n- widget: a screen element\n- banner: hero image\n- cta: call to action",
    );
  });

  test("a stored markdown ending in a newline joins without a double blank line", () => {
    const store = openTempStore();
    upsertStyleGuide(store, null, { markdown: "Global rules.\n", bannedWords: [], glossary: {} });
    insertProject(store, "app");
    upsertStyleGuide(store, "app", { markdown: "Project rules.", bannedWords: [], glossary: {} });

    expect(mergedStyleGuide(store, "app")).toBe("Global rules.\n\nProject rules.");
  });

  test("malformed stored banned_words and glossary render as empty sections, never crashing the read", () => {
    const store = openTempStore();
    upsertStyleGuide(store, null, {
      markdown: "Global rules.",
      bannedWords: ["leverage"],
      glossary: { widget: "a screen element" },
    });
    // A future or hand-edited store can hold anything in the json columns; the merge must not crash.
    store.db.run("UPDATE style_guides SET banned_words = 'not json', glossary = '[1,2]' WHERE project_id IS NULL");

    expect(mergedStyleGuide(store, "app")).toBe("Global rules.");
  });

  test("a banned or glossary item that is not a string counts as a malformed column", () => {
    const store = openTempStore();
    insertProject(store, "app");
    insertRawGuide(store, null, { markdown: "Global rules.", banned_words: '["ok", 5]', glossary: '{"k": 5}' });

    expect(mergedStyleGuide(store, "app")).toBe("Global rules.");
  });

  test("a stored banned word or glossary entry with a line break renders as one line, never injected markdown", () => {
    const store = openTempStore();
    // A line break inside an item is a valid JSON string, so the parse tolerance accepts it; the
    // render must not let it become a new bullet or a broken `key: value` line.
    insertRawGuide(store, null, {
      markdown: "",
      banned_words: '["a\\n- b"]',
      glossary: '{"k\\nx": "v\\n- injected"}',
    });

    expect(mergedStyleGuide(store, "app")).toBe(
      "## banned\n- a - b\n\n## glossary\n- k x: v - injected",
    );
  });

  test("an empty banned word or glossary key is no item at all and renders nothing", () => {
    const store = openTempStore();
    // "" is a valid JSON string, so the parse tolerance accepts it; the render must not let it
    // become a dangling "- " bullet or a keyless "- : value" line.
    insertRawGuide(store, null, {
      markdown: "",
      banned_words: '["", "x"]',
      glossary: '{"": "v", "k": "w"}',
    });

    expect(mergedStyleGuide(store, "app")).toBe("## banned\n- x\n\n## glossary\n- k: w");
  });

  test("an intentionally empty project glossary value is a real override, rendered as a value of its own", () => {
    const store = openTempStore();
    upsertStyleGuide(store, null, {
      markdown: "",
      bannedWords: [],
      glossary: { k: "global value" },
    });
    insertProject(store, "app");
    upsertStyleGuide(store, "app", { markdown: "", bannedWords: [], glossary: { k: "" } });

    // `projectGlossary[key] ?? value` must win on an empty string too: the editor clearing a term
    // is a deliberate definition, never a reason to fall back to the global one.
    expect(mergedStyleGuide(store, "app")).toBe("## glossary\n- k: ");
  });

  test("re-upserting a row updates it in place: still one row, carrying the newer values", () => {
    const store = openTempStore();
    upsertStyleGuide(store, null, { markdown: "First global.", bannedWords: [], glossary: {} });
    upsertStyleGuide(store, null, {
      markdown: "Revised global.",
      bannedWords: ["leverage"],
      glossary: { widget: "a screen element" },
    });
    insertProject(store, "app");
    upsertStyleGuide(store, "app", { markdown: "First project.", bannedWords: [], glossary: {} });
    upsertStyleGuide(store, "app", {
      markdown: "Revised project.",
      bannedWords: ["utilize"],
      glossary: { widget: "the widget slot" },
    });

    expect(mergedStyleGuide(store, "app")).toBe(
      "Revised global.\n\nRevised project.\n\n## banned\n- leverage\n- utilize\n\n## glossary\n- widget: the widget slot",
    );
    expect(store.db.query("SELECT COUNT(*) AS n FROM style_guides").get()).toEqual({ n: 2 });
  });

  test("the schema pins exactly one global row, and one row per project", () => {
    const store = openTempStore();
    upsertStyleGuide(store, null, { markdown: "Global.", bannedWords: [], glossary: {} });
    // sqlite's UNIQUE(project_id) lets any number of NULLs through, so the partial index carries
    // the global pin; a second global row must be refused by it.
    expect(() => insertRawGuide(store, null, { markdown: "Second global." })).toThrow(/UNIQUE/i);

    insertProject(store, "app");
    upsertStyleGuide(store, "app", { markdown: "Project.", bannedWords: [], glossary: {} });
    // The second row must reuse the first one's project id: UNIQUE(project_id) pins one row per
    // project, and a different id would be a different project.
    const appId = (store.db.query("SELECT id FROM projects WHERE slug = 'app'").get() as { id: string }).id;
    expect(() => insertRawGuide(store, appId, { markdown: "Second project row." })).toThrow(/UNIQUE/i);
  });

  test("the full merge renders global rules, then project rules, then banned, then glossary", () => {
    const store = openTempStore();
    upsertStyleGuide(store, null, {
      markdown: "# Voice\n\nBe plain.",
      bannedWords: ["awesome", "leverage"],
      glossary: { widget: "a screen element", banner: "top strip" },
    });
    insertProject(store, "app");
    upsertStyleGuide(store, "app", {
      markdown: '## App voice\n\nUse "users", not "customers".',
      bannedWords: ["leverage", "utilize"],
      glossary: { banner: "hero image", cta: "call to action" },
    });

    expect(mergedStyleGuide(store, "app")).toBe(
      [
        "# Voice",
        "",
        "Be plain.",
        "",
        "## App voice",
        "",
        'Use "users", not "customers".',
        "",
        "## banned",
        "- awesome",
        "- leverage",
        "- utilize",
        "",
        "## glossary",
        "- widget: a screen element",
        "- banner: hero image",
        "- cta: call to action",
      ].join("\n"),
    );
  });
});

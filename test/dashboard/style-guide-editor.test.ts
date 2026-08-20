import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { createApp } from "../../src/daemon/app.ts";
import { fileEntries, projectIdBySlug } from "../../src/db/queries.ts";
import type { NewEntry } from "../../src/db/queries.ts";
import { upsertStyleGuide } from "../../src/db/style-guide.ts";
import { openStore } from "../../src/db/store.ts";
import type { Store } from "../../src/db/store.ts";

const tempDirs: string[] = [];

const PASSWORD = "correct horse battery staple";

/** One app with its own temp-file store per test; the password defaults to unset (open dashboard). */
function openEnv(setPassword = false) {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-style-guide-"));
  tempDirs.push(dir);
  const env: Record<string, string> = { REVIEWZY_DB: join(dir, "reviewzy.db") };
  if (setPassword) env.DASHBOARD_PASSWORD = PASSWORD;
  const config = loadConfig(env);
  const store = openStore(config);
  const app = createApp(config, store);
  return {
    store,
    get: (path: string, headers: Record<string, string> = {}) => app.request(path, { headers }),
    post: (path: string, body: FormData | null, headers: Record<string, string> = {}) =>
      app.request(path, { method: "POST", ...(body === null ? {} : { body }), headers }),
    close: () => store.close(),
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const FIXTURE: NewEntry = {
  repo: "https://example.com/org/repo.git",
  file: "docs/setup.md",
  title: null,
  anchorText: "Run bun install",
  anchorBefore: "Run this before anything else.",
  anchorAfter: "Then run the tests.",
  anchorHash: "h-style",
  fileHash: "f-style",
  agentDraft: "Fix the wording of the setup section.",
  contextJson: JSON.stringify({}),
  constraintsJson: JSON.stringify({}),
};

/** Creates a project the way entries do: a filing auto-mints it, and the editor never mints one itself. */
function projectWith(env: { store: Store }, slug: string): void {
  fileEntries(env.store, slug, "probe-agent", [FIXTURE]);
}

/** The save form the editor posts: `project` empty means the global section. */
function guideForm(over: { project?: string; markdown?: string; bannedWords?: string; glossary?: string } = {}): FormData {
  const form = new FormData();
  form.set("project", over.project ?? "");
  form.set("markdown", over.markdown ?? "");
  form.set("banned_words", over.bannedWords ?? "");
  form.set("glossary", over.glossary ?? "");
  return form;
}

function guideRows(store: Store) {
  return store.db
    .query("SELECT project_id, markdown, banned_words, glossary FROM style_guides ORDER BY project_id")
    .all() as { project_id: string | null; markdown: string; banned_words: string; glossary: string }[];
}

/** The htmx marker, so a request is distinguishable from a plain navigation. */
const HX = { "HX-Request": "true" };

/** Asserts the needles appear in the haystack in exactly this order. */
function expectOrder(html: string, needles: readonly string[]) {
  let prev = -1;
  for (const needle of needles) {
    const idx = html.indexOf(needle);
    expect(idx, `"${needle}" appears after the previous needle`).toBeGreaterThan(prev);
    prev = idx;
  }
}

describe("style guide page", () => {
  test("renders the global editor: the style guide link active, the three fields, and the empty notice", async () => {
    const env = openEnv();
    const res = await env.get("/style-guide");
    expect(res.status).toBe(200);
    const html = await res.text();
    // The navbar marks the current section: Style guide active, Entries not.
    expectOrder(html, [
      '<a class="navbar-link" href="/">Entries</a>',
      '<a class="navbar-link active" href="/style-guide">Style guide</a>',
    ]);
    expect(html).toContain("Voice");
    expect(html).toContain('name="project" value=""');
    expect(html).toContain('name="markdown"');
    expect(html).toContain('name="banned_words"');
    expect(html).toContain('name="glossary"');
    expect(html).toContain("Save guide");
    // The empty state: no guide row yet, and the save creates one.
    expect(html).toContain("No guide yet");
    expect(html).toContain("Your save creates it.");
    env.close();
  });

  test("the project selector lists global and every known project, marking the current section", async () => {
    const env = openEnv();
    projectWith(env, "alpha");
    projectWith(env, "beta");
    const res = await env.get("/style-guide?project=beta");
    expect(res.status).toBe(200);
    const html = await res.text();
    expectOrder(html, [
      'class="btn btn-sm btn-secondary" href="/style-guide">Global</a>',
      'href="/style-guide?project=alpha">alpha</a>',
      'href="/style-guide?project=beta" aria-current="page">beta</a>',
    ]);
    expect(html).toContain('name="project" value="beta"');
    env.close();
  });

  test("an unknown project slug renders the notice, never a 500 and never a row", async () => {
    const env = openEnv();
    const res = await env.get("/style-guide?project=nope");
    expect(res.status).toBe(200);
    const html = await res.text();
    // JSX escapes the apostrophe; the DOM shows "doesn't".
    expect(html).toContain("Project nope doesn&#39;t exist");
    expect(html).toContain("Edit the global guide");
    expect(html).not.toContain('id="style-guide-form"');
    expect(env.store.db.query("SELECT id FROM projects WHERE slug = 'nope'").all()).toEqual([]);
    env.close();
  });

  test("a project with no guide row renders the empty state with the pinned copy", async () => {
    const env = openEnv();
    projectWith(env, "alpha");
    const res = await env.get("/style-guide?project=alpha");
    const html = await res.text();
    expect(html).toContain("No guide for this project yet");
    expect(html).toContain("Your save creates it.");
    expect(html).toContain('name="banned_words" type="text" value=""');
    env.close();
  });

  test("a row with some fields empty renders the partial state, naming what is missing", async () => {
    const env = openEnv();
    projectWith(env, "alpha");
    upsertStyleGuide(env.store, "alpha", { markdown: "Alpha rules.", bannedWords: [], glossary: {} });
    const res = await env.get("/style-guide?project=alpha");
    const html = await res.text();
    expect(html).toContain("Alpha rules.");
    expect(html).toContain("No banned words yet.");
    expect(html).toContain("No glossary entries yet.");
    expect(html).not.toContain("No markdown yet.");
    expect(html).not.toContain("No guide for this project yet");
    env.close();
  });

  test("a populated row renders its stored values in the three fields", async () => {
    const env = openEnv();
    upsertStyleGuide(env.store, null, {
      markdown: "# Voice\n\nBe plain.",
      bannedWords: ["leverage", "awesome"],
      glossary: { widget: "a screen element", banner: "top strip" },
    });
    const res = await env.get("/style-guide");
    const html = await res.text();
    expect(html).toContain("# Voice\n\nBe plain.");
    expect(html).toContain('name="banned_words" type="text" value="leverage, awesome"');
    expect(html).toContain("widget: a screen element");
    expect(html).toContain("banner: top strip");
    expect(html).not.toContain("No guide yet");
    env.close();
  });
});

describe("saving", () => {
  test("a global save through htmx stores the typed values and swaps in the saved notice", async () => {
    const env = openEnv();
    const res = await env.post(
      "/style-guide/save",
      guideForm({
        markdown: "Be plain.",
        bannedWords: " leverage , awesome, leverage ",
        glossary: " widget: a screen element \nbanner: top strip",
      }),
      HX,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('role="status"');
    expect(html).toContain("Guide saved");
    expect(html).toContain("The global guide now applies to every project.");
    // The swapped region shows the normalized stored values, not the raw submission.
    expect(html).toContain('name="banned_words" type="text" value="leverage, awesome"');
    expect(guideRows(env.store)).toEqual([
      {
        project_id: null,
        markdown: "Be plain.",
        banned_words: '["leverage","awesome"]',
        glossary: '{"widget":"a screen element","banner":"top strip"}',
      },
    ]);
    env.close();
  });

  test("a project save writes that project's row, and never touches the global row", async () => {
    const env = openEnv();
    projectWith(env, "alpha");
    const res = await env.post(
      "/style-guide/save",
      guideForm({ project: "alpha", markdown: "Alpha rules.", bannedWords: "utilize", glossary: "widget: the widget slot" }),
      HX,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("The alpha section now applies below the global guide.");
    const rows = guideRows(env.store);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.project_id).toBe(projectIdBySlug(env.store, "alpha"));
    expect(rows[0]!.markdown).toBe("Alpha rules.");
    const globalCount = env.store.db.query("SELECT COUNT(*) AS n FROM style_guides WHERE project_id IS NULL").get() as {
      n: number;
    };
    expect(globalCount.n).toBe(0);
    env.close();
  });

  test("a malformed glossary line refuses with the line named, and nothing is written", async () => {
    const env = openEnv();
    const res = await env.post(
      "/style-guide/save",
      guideForm({ markdown: "Be plain.", glossary: "widget: a screen element\njust words" }),
      HX,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain("Guide not saved");
    // JSX escapes the quotes; the DOM shows them unescaped.
    expect(html).toContain('Glossary line 2 (&quot;just words&quot;) has no colon. Write it as key: value.');
    // The refusal keeps the submitted form in the swapped region.
    expect(html).toContain("just words");
    expect(env.store.db.query("SELECT COUNT(*) AS n FROM style_guides").get()).toEqual({ n: 0 });
    env.close();
  });

  test("a glossary line with a colon but no key refuses, naming the line", async () => {
    const env = openEnv();
    const res = await env.post(
      "/style-guide/save",
      guideForm({ glossary: "widget: a screen element\n: missing key" }),
      HX,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Glossary line 2 (&quot;: missing key&quot;) has no key. Write it as key: value.');
    expect(env.store.db.query("SELECT COUNT(*) AS n FROM style_guides").get()).toEqual({ n: 0 });
    env.close();
  });

  test("saving to an unknown project refuses, creating no project and no row", async () => {
    const env = openEnv();
    const res = await env.post("/style-guide/save", guideForm({ project: "nope", markdown: "Rules." }), HX);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Project nope doesn&#39;t exist");
    expect(html).toContain("Edit the global guide");
    expect(html).not.toContain('id="style-guide-form"');
    expect(env.store.db.query("SELECT id FROM projects WHERE slug = 'nope'").all()).toEqual([]);
    expect(env.store.db.query("SELECT COUNT(*) AS n FROM style_guides").get()).toEqual({ n: 0 });
    env.close();
  });

  test("a plain save success redirects with Post/Redirect/Get", async () => {
    const env = openEnv();
    projectWith(env, "alpha");
    const global = await env.post("/style-guide/save", guideForm({ markdown: "Be plain." }));
    expect(global.status).toBe(303);
    expect(global.headers.get("location")).toBe("/style-guide");
    const project = await env.post("/style-guide/save", guideForm({ project: "alpha", markdown: "Alpha rules." }));
    expect(project.status).toBe(303);
    expect(project.headers.get("location")).toBe("/style-guide?project=alpha");
    env.close();
  });

  test("a plain save refusal renders the full page with the callout", async () => {
    const env = openEnv();
    const res = await env.post("/style-guide/save", guideForm({ glossary: "no colon here" }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Guide not saved");
    env.close();
  });
});

describe("session guard", () => {
  test("the editor inherits the guard: unsigned pages and saves are refused", async () => {
    const env = openEnv(true);
    const page = await env.get("/style-guide");
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/login?next=%2Fstyle-guide");
    const save = await env.post("/style-guide/save", guideForm({ markdown: "x" }), HX);
    expect(save.status).toBe(401);
    expect(save.headers.get("HX-Redirect")).toBe("/login");
    env.close();
  });
});

describe("navbar", () => {
  test("the entries page links to the style guide, keeping Entries active", async () => {
    const env = openEnv();
    const res = await env.get("/");
    const html = await res.text();
    expectOrder(html, [
      '<a class="navbar-link active" href="/">Entries</a>',
      '<a class="navbar-link" href="/style-guide">Style guide</a>',
    ]);
    env.close();
  });
});

describe("save error wiring", () => {
  test("the page carries the error template and dashboard.js wires it to the save form", async () => {
    const env = openEnv();
    const html = await (await env.get("/style-guide")).text();
    expect(html).toContain('id="style-guide-error-box"');
    const js = await Bun.file(new URL("../../src/dashboard/static/dashboard.js", import.meta.url)).text();
    expect(js).toContain("style-guide-error-box");
    expect(js).toContain("style-guide-region");
    expect(js).toContain("style-guide-form");
    expect(js).toContain("htmx:responseError");
    expect(js).toContain("htmx:sendError");
    // The error box prepends above the form (a revert to replaceChildren would destroy the form
    // the retry must re-submit) and a repeated error drops the previous box first.
    expect(js).toContain("region.prepend(box)");
    expect(js).toContain("data-style-guide-error");
    env.close();
  });
});

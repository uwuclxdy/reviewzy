import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { createApp } from "../../src/daemon/app.ts";
import { fileEntries } from "../../src/db/queries.ts";
import type { NewEntry } from "../../src/db/queries.ts";
import { openStore } from "../../src/db/store.ts";
import type { Store } from "../../src/db/store.ts";

const tempDirs: string[] = [];

/** One app with its own temp-file store per test, since saves mutate state; the list test's shared env is for read-only walks. */
function openEnv() {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-editor-"));
  tempDirs.push(dir);
  const config = loadConfig({ REVIEWZY_DB: join(dir, "reviewzy.db") });
  const store = openStore(config);
  const app = createApp(config, store);
  return {
    store,
    get: (path: string) => app.request(path),
    post: (path: string, body: FormData, headers: Record<string, string> = {}) =>
      app.request(path, { method: "POST", body, headers }),
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
  anchorHash: "h-editor",
  fileHash: "f-editor",
  agentDraft: "Fix the wording of the setup section.",
  contextJson: JSON.stringify({ where: "setup docs", code: "bun install" }),
  constraintsJson: JSON.stringify({
    max_len: 200,
    placeholders: ["command"],
    tone: "neutral",
    notes: "Keep it short.",
  }),
};

function draftEntry(over: Partial<NewEntry> = {}): NewEntry {
  return { ...FIXTURE, ...over };
}

/** Files one draft in project "alpha" and returns the env plus the entry id. */
function envWithDraft(over: Partial<NewEntry> = {}) {
  const env = openEnv();
  const batch = fileEntries(env.store, "alpha", "probe-agent", [draftEntry(over)]);
  return { env, id: batch.results[0]!.id };
}

function saveForm(text: string): FormData {
  const form = new FormData();
  form.set("text", text);
  return form;
}

/** The editor test's own htmx header, so a POST is distinguishable from a plain navigation. */
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

function revisionCount(store: Store, entryId: string): number {
  return (store.db.query("SELECT COUNT(*) AS n FROM entry_revisions WHERE entry_id = ?").get(entryId) as {
    n: number;
  }).n;
}

describe("editor page", () => {
  test("serves the editor shell: navbar, header, context, prefill, constraints, and empty history", async () => {
    const { env, id } = envWithDraft();
    const res = await env.get(`/entries/${id}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("navbar-brand");
    expect(html).toContain("Entry review");
    expect(html).toContain("<h1 class=\"page-title\">Edit entry</h1>");
    expect(html).toContain("Saving the text approves the entry and releases it to agents.");

    // The form wires both the native POST and the htmx swap of the whole editor view, so the
    // diff's after-side re-renders with the authored text on a save (the transitions below keep
    // targeting the region only, since they never change what the diff shows).
    expect(html).toContain(`hx-post="/entries/${id}/save"`);
    expect(html).toContain('hx-target="#editor-view"');
    expect(html).toContain('hx-swap="outerHTML"');
    expect(html).toContain(`action="/entries/${id}/save"`);
    expect(html).toContain('method="post"');

    // The textarea is prefilled with the agent draft and survives swaps.
    expect(html).toContain('id="editor-text"');
    expect(html).toContain('aria-label="Entry text"');
    expect(html).toContain('hx-preserve="true"');
    expect(html).toContain("Fix the wording of the setup section.");

    // Status tag: the draft is still a draft.
    expect(html).toContain("Draft");

    // Context pane renders the parsed context as key-value rows, then the anchor metadata. The
    // diff view above the editor also carries the anchor text, so the order check is scoped to the
    // pane itself.
    const contextPane = html.slice(html.indexOf('<table class="info-table">'));
    expectOrder(contextPane, ["where", "setup docs", "code", "bun install"]);
    expect(html).toContain("https://example.com/org/repo.git");
    expect(html).toContain("docs/setup.md");
    expect(html).toContain("Run bun install");
    expect(html).toContain("f-editor");
    expect(html).toContain("probe-agent");

    // Constraint panel: live count computed from the prefill, checklist, and display-only fields.
    const prefillLength = String("Fix the wording of the setup section.".length);
    // The exact opening tag, so the per-keystroke count carries no aria-live of its own.
    expect(html).toContain(`<span id="char-count" class="num char-count" data-max-len="200">`);
    expect(html).toContain(`${prefillLength} / 200`);
    // The one live region is the hidden span; it announces flips only, not each keystroke.
    expect(html).toContain('<span id="editor-live" class="visually-hidden" aria-live="polite"></span>');
    expect(html).toContain('data-placeholder="command"');
    // The exact opening tag, so the placeholder state carries no aria-live of its own either: the
    // prefill lacks "command", so the rendered span is the no-class form.
    expect(html).toContain('<span class="placeholder-state">');
    expect(html).toContain("{command}");
    expect(html).toContain("Missing");
    expect(html).toContain("neutral");
    expect(html).toContain("Keep it short.");

    // Revision history: settled empty state, not a loading state.
    expect(html).toContain("Revision history");
    expect(html).toContain("No saved revisions yet");
    env.close();
  });

  test("shows the entry title in place of the bare 'Text' label and renders inert rails for a lone entry", async () => {
    const { env, id } = envWithDraft({ title: "Setup wording" });
    const html = await (await env.get(`/entries/${id}`)).text();

    expect(html).toContain('<div class="card-title editor-title">Setup wording</div>');
    expect(html).not.toContain('<div class="card-title">Text</div>');
    // A lone entry has no neighbour in the list walk, so both rails render inert.
    expect(html).toContain('class="editor-nav-btn editor-nav-prev is-disabled"');
    expect(html).toContain('class="editor-nav-btn editor-nav-next is-disabled"');
    expect(html).not.toContain('aria-label="Previous entry"');
    expect(html).not.toContain('aria-label="Next entry"');
    env.close();
  });

  test("links prev/next to the adjacent entries in id order, inert at the boundaries", async () => {
    const env = openEnv();
    const batch = fileEntries(env.store, "alpha", "probe-agent", [
      draftEntry({ file: "a.md", anchorText: "a", anchorHash: "ha", fileHash: "fa", agentDraft: "A" }),
      draftEntry({ file: "b.md", anchorText: "b", anchorHash: "hb", fileHash: "fb", agentDraft: "B" }),
      draftEntry({ file: "c.md", anchorText: "c", anchorHash: "hc", fileHash: "fc", agentDraft: "C" }),
    ]);
    // The walk is by ascending id, so sort the ids to know which is first, middle, last.
    const [first, middle, last] = batch.results.map((r) => r.id).sort();

    const html = await (await env.get(`/entries/${middle}`)).text();
    expect(html).toContain(`href="/entries/${first}"`);
    expect(html).toContain('aria-label="Previous entry"');
    expect(html).toContain(`href="/entries/${last}"`);
    expect(html).toContain('aria-label="Next entry"');

    const firstHtml = await (await env.get(`/entries/${first}`)).text();
    expect(firstHtml).toContain('class="editor-nav-btn editor-nav-prev is-disabled"');
    expect(firstHtml).toContain(`href="/entries/${middle}"`);

    const lastHtml = await (await env.get(`/entries/${last}`)).text();
    expect(lastHtml).toContain('class="editor-nav-btn editor-nav-next is-disabled"');
    expect(lastHtml).toContain(`href="/entries/${middle}"`);
    env.close();
  });

  test("gives a 404 page with a way onward for an unknown id", async () => {
    const env = openEnv();
    const res = await env.get("/entries/does-not-exist");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("Entry not found");
    // hono JSX escapes the apostrophe; the copy itself carries it.
    expect(html).toContain("doesn&#39;t exist");
    expect(html).toContain('href="/"');
    expect(html).toContain("Back to entries");
    env.close();
  });

  test("renders context, file, repo, anchors, and text escaped", async () => {
    const { env, id } = envWithDraft({
      repo: "https://example.com/a&b.git",
      file: "<script>file</script>",
      anchorText: "<script>anchor</script>",
      contextJson: JSON.stringify({ where: "<img src=x onerror=alert(1)>", code: "alert(\"xss-ctx\")" }),
    });
    // A second draft covers agent_draft-as-prefill: human_text null keeps the draft in the textarea.
    const draft = envWithDraft({ agentDraft: "<b>draft</b> & prefill" });
    env.store.db.run(
      "UPDATE entries SET status = 'approved', human_text = '<b>human</b> & friends', filed_by = '<i>filed</i> & by', stale_note = 'stale <script>note</script>' WHERE id = ?",
      [id],
    );

    const html = await (await env.get(`/entries/${id}`)).text();
    const draftHtml = await (await draft.env.get(`/entries/${draft.id}`)).text();

    expect(html).toContain("&lt;script&gt;file&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;b&gt;human&lt;/b&gt; &amp; friends");
    expect(html).toContain("https://example.com/a&amp;b.git");
    expect(html).toContain("&lt;script&gt;anchor&lt;/script&gt;");
    expect(html).toContain("&lt;i&gt;filed&lt;/i&gt; &amp; by");
    expect(html).toContain("stale &lt;script&gt;note&lt;/script&gt;");
    expect(draftHtml).toContain("&lt;b&gt;draft&lt;/b&gt; &amp; prefill");
    expect(html).not.toContain("<script>file</script>");
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain("<b>human</b>");
    expect(html).not.toContain("<script>anchor</script>");
    expect(html).not.toContain("<i>filed</i>");
    expect(html).not.toContain("stale <script>note</script>");
    expect(draftHtml).not.toContain("<b>draft</b>");
    draft.env.close();
    env.close();
  });

  test("omits the constraint panel when the stored constraints are unparseable", async () => {
    const { env, id } = envWithDraft({ constraintsJson: "not json" });
    const html = await (await env.get(`/entries/${id}`)).text();
    expect(html).not.toContain("char-count");
    expect(html).not.toContain("Constraints");
    expect(html).toContain("No saved revisions yet");
    env.close();
  });

  test("wires the live editor hooks in dashboard.js", async () => {
    const js = await Bun.file(
      new URL("../../src/dashboard/static/dashboard.js", import.meta.url),
    ).text();
    expect(js).toContain("char-count");
    expect(js).toContain("editor-live");
    expect(js).toContain("data-use-revision");
  });
});

describe("list rows", () => {
  test("each entry row links to its editor", async () => {
    const { env, id } = envWithDraft();
    const html = await (await env.get("/")).text();
    expect(html).toContain(`<a class="btn btn-icon" href="/entries/${id}" aria-label="Edit docs/setup.md" title="Edit">`);
    // Task 13 widened the column to the row's transitions, so the header names the whole cell.
    expect(html).toContain("<th>Actions</th>");
    env.close();
  });
});

describe("saving from the editor", () => {
  test("a save swaps in the diff after-side with the authored text, not the stale agent draft", async () => {
    const { env, id } = envWithDraft();
    const text = "Run the command to set up the project.";
    const res = await env.post(`/entries/${id}/save`, saveForm(text), HX);
    const html = await res.text();

    // The save fragment re-renders the diff region, so the authored text reaches the after-side in
    // the live DOM; without it the swap leaves the stale agent draft showing until a reload.
    expect(html).toContain('<div class="card-title">After</div>');
    expect(html).toContain("diff-anchor");
    expect(html).toContain(text);
    expect(html).not.toContain("Fix the wording of the setup section.");
    env.close();
  });

  test("a draft save swaps in an approved editor region with a history row", async () => {
    const { env, id } = envWithDraft();
    const text = "Run the command to set up the project.";
    const res = await env.post(`/entries/${id}/save`, saveForm(text), HX);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain("Approved");
    expect(html).not.toContain('role="alert"');
    expect(html).toContain("Revision history");
    expect(html).toContain(text);
    // The history row records the status the entry held at the save: a draft that approves records "Draft".
    expectOrder(html, ["revision-head", "Draft", "revision-time", "Use"]);
    expect(html).toContain('data-use-revision');

    const row = env.store.db.query("SELECT status, human_text FROM entries WHERE id = ?").get(id) as {
      status: string;
      human_text: string | null;
    };
    expect(row).toEqual({ status: "approved", human_text: text });
    expect(revisionCount(env.store, id)).toBe(1);
    env.close();
  });

  test("a re-save appends a history row and stays approved", async () => {
    const { env, id } = envWithDraft();
    await env.post(`/entries/${id}/save`, saveForm("Run the command to install."), HX);
    const res = await env.post(`/entries/${id}/save`, saveForm("Run the command to build."), HX);
    const html = await res.text();

    expect(html).toContain("Approved");
    expect(revisionCount(env.store, id)).toBe(2);
    // Newest first, judged inside the history list only (the form's own tag also reads Approved).
    const history = html.slice(html.indexOf("revision-list"));
    expectOrder(history, ["Approved", "Run the command to build.", "Draft", "Run the command to install."]);
    env.close();
  });

  test("an over-limit save refuses inline, names the value and the fix, and keeps the submitted text", async () => {
    const { env, id } = envWithDraft();
    const long = "x".repeat(201);
    const res = await env.post(`/entries/${id}/save`, saveForm(long), HX);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('role="alert"');
    expect(html).toContain("Text not saved");
    expect(html).toContain("201 characters");
    expect(html).toContain("limit is 200");
    expect(html).toContain("Shorten it");
    expect(html).toContain(long); // the textarea keeps the user's submission

    const row = env.store.db.query("SELECT status, human_text FROM entries WHERE id = ?").get(id) as {
      status: string;
      human_text: string | null;
    };
    expect(row).toEqual({ status: "draft", human_text: null });
    expect(revisionCount(env.store, id)).toBe(0);
    env.close();
  });

  test("a save missing a placeholder refuses inline, naming the placeholder", async () => {
    const { env, id } = envWithDraft();
    const res = await env.post(`/entries/${id}/save`, saveForm("This text never mentions the required token."), HX);
    const html = await res.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain("missing the placeholder {command}");
    expect(html).toContain("Add {command} to the text");
    expect(revisionCount(env.store, id)).toBe(0);
    env.close();
  });

  test("an empty save refuses inline, naming the fix", async () => {
    const { env, id } = envWithDraft();
    const res = await env.post(`/entries/${id}/save`, saveForm("   "), HX);
    const html = await res.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain("Enter text, or reject the entry.");
    expect(revisionCount(env.store, id)).toBe(0);
    env.close();
  });

  test("saving an applied entry refuses, naming the status and the way back", async () => {
    const { env, id } = envWithDraft();
    env.store.db.run("UPDATE entries SET status = 'applied' WHERE id = ?", [id]);
    const res = await env.post(`/entries/${id}/save`, saveForm("new prose"), HX);
    const html = await res.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain("already applied");
    expect(html).toContain("returns to approved");
    expect(revisionCount(env.store, id)).toBe(0);
    env.close();
  });

  test("saving a rejected entry refuses, naming the status and the way forward", async () => {
    const { env, id } = envWithDraft();
    env.store.db.run("UPDATE entries SET status = 'rejected' WHERE id = ?", [id]);
    const res = await env.post(`/entries/${id}/save`, saveForm("new prose"), HX);
    const html = await res.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain("was rejected");
    expect(html).toContain("stays rejected");
    expect(revisionCount(env.store, id)).toBe(0);
    env.close();
  });

  test("saving identical text is a no-op: no callout, no new revision", async () => {
    const { env, id } = envWithDraft();
    const text = "Run the command twice.";
    await env.post(`/entries/${id}/save`, saveForm(text), HX);
    const res = await env.post(`/entries/${id}/save`, saveForm(text), HX);
    const html = await res.text();
    expect(html).not.toContain('role="alert"');
    expect(html).toContain("Approved");
    expect(revisionCount(env.store, id)).toBe(1);
    env.close();
  });

  test("keeps the authored bytes: surrounding whitespace survives the save", async () => {
    const { env, id } = envWithDraft();
    const text = "  Run the command to set up the project.  ";
    await env.post(`/entries/${id}/save`, saveForm(text), HX);
    const row = env.store.db.query("SELECT human_text FROM entries WHERE id = ?").get(id) as {
      human_text: string;
    };
    expect(row.human_text).toBe(text);
    env.close();
  });

  test("an unknown id on save responds with a fragment saying the entry is gone", async () => {
    const env = openEnv();
    const res = await env.post("/entries/does-not-exist/save", saveForm("prose"), HX);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("no longer exists");
    expect(html).toContain('href="/"');
    // The save swap targets the whole editor view, so the gone fragment answers in that same shape.
    expect(html).toContain('<div id="editor-view">');
    expect(html).toContain('<div id="editor-region">');
    env.close();
  });
});

describe("no-JavaScript fallback", () => {
  test("a successful save redirects to the editor page", async () => {
    const { env, id } = envWithDraft();
    const res = await env.post(`/entries/${id}/save`, saveForm("Run the command to save."));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/entries/${id}`);
    const row = env.store.db.query("SELECT status FROM entries WHERE id = ?").get(id) as { status: string };
    expect(row.status).toBe("approved");
    env.close();
  });

  test("a refused save renders the full page with the callout", async () => {
    const { env, id } = envWithDraft();
    const res = await env.post(`/entries/${id}/save`, saveForm("x".repeat(201)));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Text not saved");
    expect(html).toContain("limit is 200");
    env.close();
  });
});

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
  imagesJson: null,
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

    // Context pane: the anchor leads, then the parsed context as key-value rows, then the anchor
    // metadata. The diff view above the editor also carries the anchor text, so the order check is
    // scoped to the pane itself, and the context value is matched with its cell markup since the
    // anchor row contains the same words.
    const contextPane = html.slice(html.indexOf('<table class="info-table">'));
    expectOrder(contextPane, ["<td>Anchor</td>", "<td>where</td>", "setup docs", "<td>code</td>", "<td>bun install</td>"]);
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

  test("links a recognized repo to its host with a brand icon and a shortened path", async () => {
    const { env, id } = envWithDraft({ repo: "https://github.com/uwuclxdy/clauth.git" });
    const html = await (await env.get(`/entries/${id}`)).text();

    expect(html).toContain('class="repo-link" href="https://github.com/uwuclxdy/clauth"');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('title="https://github.com/uwuclxdy/clauth.git"');
    expect(html).toContain('class="repo-icon"');
    // The github octocat glyph leads the icon's path data.
    expect(html).toContain("M12 .297");
    expect(html).toContain(">uwuclxdy/clauth</span>");
    // The raw remote no longer sits in the value cell; only the shortened path does.
    expect(html).not.toContain("https://github.com/uwuclxdy/clauth.git</td>");
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

describe("entry images", () => {
  /** One small png as the browser would upload it. */
  function imageFile(name = "shot.png"): File {
    return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
  }

  test("renders valid items as images with real alts, and a not-shown note for foreign items, never raw", async () => {
    const { env, id } = envWithDraft({
      imagesJson: JSON.stringify(["data:image/png;base64,AAAA", "https://example.com/shot.png"]),
    });
    // A foreign row can hold anything; a stored item outside the validated prefixes renders as a
    // note naming its position, and the raw value never reaches the page.
    env.store.db.run("UPDATE entries SET images = ? WHERE id = ?", [
      JSON.stringify(["data:image/png;base64,AAAA", "javascript:alert(1)", "https://example.com/shot.png"]),
      id,
    ]);
    const html = await (await env.get(`/entries/${id}`)).text();

    expect(html).toContain('<img class="entry-image" src="data:image/png;base64,AAAA" alt="Image 1"');
    expect(html).toContain('src="https://example.com/shot.png" alt="Image 3"');
    expect(html).toContain("Image 2 not shown: unsupported source.");
    expect(html).not.toContain("javascript:alert(1)");
    // The upload form rides below the list, wired for both htmx and a plain navigation.
    expect(html).toContain(`hx-post="/entries/${id}/images"`);
    expect(html).toContain('enctype="multipart/form-data"');
    env.close();
  });

  test("shows the empty state and the upload form when the entry has no images", async () => {
    const { env, id } = envWithDraft();
    const html = await (await env.get(`/entries/${id}`)).text();
    expect(html).toContain("No images yet.");
    expect(html).toContain(`action="/entries/${id}/images"`);
    env.close();
  });

  test("upload appends one multipart file as a data url and swaps the editor view", async () => {
    const { env, id } = envWithDraft();
    const form = new FormData();
    form.set("file", imageFile());

    const res = await env.post(`/entries/${id}/images`, form, HX);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div id="editor-view">');
    expect(html).toContain('src="data:image/png;base64,AQID"');
    expect(html).toContain('alt="Image 1"');

    const row = env.store.db.query("SELECT images FROM entries WHERE id = ?").get(id) as { images: string };
    expect(JSON.parse(row.images)).toEqual(["data:image/png;base64,AQID"]);
    env.close();
  });

  test("refuses a non-image mime, naming the type and the size cap, and writes nothing", async () => {
    const { env, id } = envWithDraft();
    const form = new FormData();
    form.set("file", new File(["x"], "doc.pdf", { type: "application/pdf" }));

    const res = await env.post(`/entries/${id}/images`, form, HX);
    const html = await res.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain("Image not added");
    expect(html).toContain("application/pdf");
    expect(html).toContain("5 MiB");

    const row = env.store.db.query("SELECT images FROM entries WHERE id = ?").get(id) as { images: string };
    expect(JSON.parse(row.images)).toEqual([]);
    env.close();
  });

  test("refuses a file over 5 MiB, naming the size and the cap", async () => {
    const { env, id } = envWithDraft();
    const form = new FormData();
    form.set("file", new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.png", { type: "image/png" }));

    const res = await env.post(`/entries/${id}/images`, form, HX);
    const html = await res.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain("Image not added");
    expect(html).toContain("5 MiB");
    expect(html).toContain("data url");

    const row = env.store.db.query("SELECT images FROM entries WHERE id = ?").get(id) as { images: string };
    expect(JSON.parse(row.images)).toEqual([]);
    env.close();
  });

  test("caps the stored data url, not the file: a file under 5 MiB whose base64 crosses the cap is refused, one byte inside is accepted", async () => {
    const { env, id } = envWithDraft();
    // data:image/png;base64, is 22 bytes; the largest accepted file makes the url exactly
    // 4*ceil(size/3) + 22 = 5,242,878 <= 5 MiB, and one byte more crosses it.
    const accepted = await env.post(
      `/entries/${id}/images`,
      (() => {
        const form = new FormData();
        form.set("file", new File([new Uint8Array(3_932_142)], "edge.png", { type: "image/png" }));
        return form;
      })(),
      HX,
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).not.toContain("Image not added");

    const refused = await env.post(
      `/entries/${id}/images`,
      (() => {
        const form = new FormData();
        form.set("file", new File([new Uint8Array(3_932_143)], "over.png", { type: "image/png" }));
        return form;
      })(),
      HX,
    );
    const html = await refused.text();
    expect(html).toContain("Image not added");
    expect(html).toContain("5 MiB");

    const row = env.store.db.query("SELECT images FROM entries WHERE id = ?").get(id) as { images: string };
    expect(JSON.parse(row.images)).toHaveLength(1);
    env.close();
  });

  test("refuses an upload past the 8-image cap, naming the limit", async () => {
    const { env, id } = envWithDraft({
      imagesJson: JSON.stringify(Array.from({ length: 8 }, (_, i) => `https://example.com/${i}.png`)),
    });
    const form = new FormData();
    form.set("file", imageFile());

    const res = await env.post(`/entries/${id}/images`, form, HX);
    const html = await res.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain("Image not added");
    expect(html).toContain("already has 8 images");

    const row = env.store.db.query("SELECT images FROM entries WHERE id = ?").get(id) as { images: string };
    expect(JSON.parse(row.images)).toHaveLength(8);
    env.close();
  });

  test("removes one image by its index", async () => {
    const { env, id } = envWithDraft({
      imagesJson: JSON.stringify(["data:image/png;base64,AAAA", "https://example.com/shot.png"]),
    });

    const res = await env.post(`/entries/${id}/images/1/remove`, new FormData(), HX);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div id="editor-view">');
    expect(html).toContain('alt="Image 1"');
    expect(html).not.toContain("https://example.com/shot.png");

    const row = env.store.db.query("SELECT images FROM entries WHERE id = ?").get(id) as { images: string };
    expect(JSON.parse(row.images)).toEqual(["data:image/png;base64,AAAA"]);
    env.close();
  });

  test("removing an index past the list refuses, naming the position", async () => {
    const { env, id } = envWithDraft();
    const res = await env.post(`/entries/${id}/images/2/remove`, new FormData(), HX);
    const html = await res.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain("Image not removed");
    expect(html).toContain("image 3");
    env.close();
  });

  test("an unknown id on upload answers the gone fragment in the editor view shape", async () => {
    const env = openEnv();
    const form = new FormData();
    form.set("file", imageFile());
    const res = await env.post("/entries/does-not-exist/images", form, HX);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("no longer exists");
    expect(html).toContain('<div id="editor-view">');
    env.close();
  });

  test("no-JS upload redirects back to the editor on success", async () => {
    const { env, id } = envWithDraft();
    const form = new FormData();
    form.set("file", imageFile());
    const res = await env.post(`/entries/${id}/images`, form);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/entries/${id}`);
    env.close();
  });
});

describe("human notes", () => {
  function notesForm(notes: string): FormData {
    const form = new FormData();
    form.set("notes", notes);
    return form;
  }

  test("renders the agent's notes read-only and the human's notes in its own card with its own save", async () => {
    const { env, id } = envWithDraft();
    env.store.db.run("UPDATE entries SET human_notes = ? WHERE id = ?", ["check the tone", id]);
    const html = await (await env.get(`/entries/${id}`)).text();

    // Both rows live in the notes card; the agent's carries the constraint note, the human's the
    // stored scratchpad, editable and surviving swaps.
    expect(html).toContain("Agent&#39;s notes");
    expect(html).toContain("Keep it short.");
    expect(html).toContain("Your notes");
    expect(html).toContain('id="editor-notes"');
    expect(html).toContain('hx-preserve="true"');
    expect(html).toContain("check the tone");
    expect(html).toContain(`hx-post="/entries/${id}/notes"`);
    expect(html).toContain('hx-target="#editor-view"');
    expect(html).toContain("Save notes");
    // The notes row left the constraints card: the label no longer renders there.
    expect(html).not.toContain('<div class="constraint-label">Notes</div>');
    env.close();
  });

  test("shows a placeholder when the agent sent no notes", async () => {
    const { env, id } = envWithDraft({ constraintsJson: "{}" });
    const html = await (await env.get(`/entries/${id}`)).text();
    expect(html).toContain("Agent&#39;s notes");
    expect(html).toContain("None.");
    env.close();
  });

  test("a notes save stores the note, moves updated_at, and changes nothing else", async () => {
    const { env, id } = envWithDraft();
    env.store.db.run("UPDATE entries SET updated_at = 1000 WHERE id = ?", [id]);

    const res = await env.post(`/entries/${id}/notes`, notesForm("watch the em dash"), HX);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div id="editor-view">');
    expect(html).toContain("watch the em dash");

    const row = env.store.db.query("SELECT status, human_notes, updated_at FROM entries WHERE id = ?").get(id) as {
      status: string;
      human_notes: string | null;
      updated_at: number;
    };
    expect(row.status).toBe("draft");
    expect(row.human_notes).toBe("watch the em dash");
    expect(row.updated_at).toBeGreaterThan(1_000_000);
    expect(revisionCount(env.store, id)).toBe(0);
    env.close();
  });

  test("notes save on an applied entry: the scratchpad outlives the status machine", async () => {
    const { env, id } = envWithDraft();
    env.store.db.run("UPDATE entries SET status = 'applied' WHERE id = ?", [id]);

    const res = await env.post(`/entries/${id}/notes`, notesForm("still fine to note this"), HX);
    expect(res.status).toBe(200);

    const row = env.store.db.query("SELECT status, human_notes FROM entries WHERE id = ?").get(id) as {
      status: string;
      human_notes: string | null;
    };
    expect(row).toEqual({ status: "applied", human_notes: "still fine to note this" });
    env.close();
  });

  test("an unknown id on notes save responds with the gone fragment in the editor view shape", async () => {
    const env = openEnv();
    const res = await env.post("/entries/does-not-exist/notes", notesForm("x"), HX);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("no longer exists");
    expect(html).toContain('<div id="editor-view">');
    env.close();
  });

  test("no-JS notes save redirects back to the editor", async () => {
    const { env, id } = envWithDraft();
    const res = await env.post(`/entries/${id}/notes`, notesForm("scratch"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/entries/${id}`);
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

describe("the word diff", () => {
  test("marks removed words red in the before card and added words green in the after card, leaving the shared words plain", async () => {
    // No constraints, so the save needs neither max_len room nor a placeholder.
    const { env, id } = envWithDraft({ constraintsJson: "{}" });
    const res = await env.post(`/entries/${id}/save`, saveForm("Run npm install"), HX);
    const html = await res.text();

    // "bun" exists only in the anchor, "npm" only in the proposal; the shared words render as
    // plain text between the marks.
    expect(html).toContain('Run <span class="diff-removed">bun</span> install');
    expect(html).toContain('Run <span class="diff-added">npm</span> install');
    env.close();
  });

  test("renders no marks for identical text", async () => {
    const { env, id } = envWithDraft({ constraintsJson: "{}" });
    const res = await env.post(`/entries/${id}/save`, saveForm("Run bun install"), HX);
    const html = await res.text();

    expect(html).not.toContain("diff-removed");
    expect(html).not.toContain("diff-added");
    env.close();
  });

  test("a pair too large for the LCS walk renders fully changed instead of hanging", async () => {
    // 1100 words per side crosses the LCS cell ceiling, so the walk is skipped and each side reads
    // fully changed: both mark classes render, and the page answers in linear time.
    const word = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    const { env, id } = envWithDraft({
      constraintsJson: "{}",
      anchorText: word(1100),
      agentDraft: `${word(1100)} tail`,
    });
    const html = await (await env.get(`/entries/${id}`)).text();
    expect(html).toContain("diff-removed");
    expect(html).toContain("diff-added");
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

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { createApp } from "../../src/daemon/app.ts";
import { fileEntries } from "../../src/db/queries.ts";
import type { NewEntry } from "../../src/db/queries.ts";
import { openStore } from "../../src/db/store.ts";
import { formatSaveRefusal } from "../../src/dashboard/views.tsx";

// The review screen's information architecture: status tabs carry the counts, the list states its
// visible total, the editor pairs the current text with the proposal, and a terminal entry renders
// read-only. These are the contracts CSS cannot hold; spacing and colour are judged by eye.

const tempDirs: string[] = [];

function openEnv() {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-layout-"));
  tempDirs.push(dir);
  const config = loadConfig({ REVIEWZY_DB: join(dir, "reviewzy.db") });
  const store = openStore(config);
  const app = createApp(config, store);
  return {
    store,
    get: (path: string, headers: Record<string, string> = {}) => app.request(path, { headers }),
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

const HX = { "HX-Request": "true" };

function draft(over: Partial<NewEntry>): NewEntry {
  return {
    repo: "https://example.com/org/repo.git",
    file: "docs/setup.md",
    title: "Setup wording",
    anchorText: "Run bun install",
    anchorBefore: "Run this before anything else.",
    anchorAfter: "Then run the tests.",
    anchorHash: "h-layout",
    fileHash: "f-layout",
    agentDraft: "Fix the wording of the setup section.",
    contextJson: JSON.stringify({ where: "setup docs", code: "bun install" }),
    constraintsJson: JSON.stringify({ max_len: 200, placeholders: ["command"], tone: "neutral", notes: "Keep it short." }),
    imagesJson: null,
    ...over,
  };
}

/**
 * One store with one entry per status across two projects: alpha holds the draft and the approved
 * entry, zeta the applied and the rejected one. Open (draft + approved) is 2 of 4.
 */
function seededEnv() {
  const env = openEnv();
  const alpha = fileEntries(env.store, "alpha", "probe-agent", [
    draft({ file: "docs/setup.md", title: "Setup wording" }),
    draft({ file: "docs/cache.md", title: null, anchorText: "The cache lives at", agentDraft: "Explain the cache directory." }),
  ]);
  const zeta = fileEntries(env.store, "zeta", "probe-agent", [
    draft({ file: "LICENSE.md", title: "License note", anchorText: "AGPL-3.0" }),
    draft({ file: "docs/faq.md", title: "FAQ entry", anchorText: "Frequently asked" }),
  ]);
  const approvedId = alpha.results[1]!.id;
  const appliedId = zeta.results[0]!.id;
  const rejectedId = zeta.results[1]!.id;
  env.store.db.run("UPDATE entries SET status = 'approved', human_text = 'Explain where the cache lives.' WHERE id = ?", [approvedId]);
  env.store.db.run("UPDATE entries SET status = 'applied', human_text = 'License note text.' WHERE id = ?", [appliedId]);
  env.store.db.run("UPDATE entries SET status = 'rejected' WHERE id = ?", [rejectedId]);
  return {
    env,
    draftId: alpha.results[0]!.id,
    approvedId,
    appliedId,
    rejectedId,
  };
}

describe("list information architecture", () => {
  test("the queue's status is one tab strip carrying the counts, not a stat grid and a dropdown", async () => {
    const { env } = seededEnv();
    const html = await (await env.get("/")).text();

    expect(html).not.toContain('class="stat-grid"');
    expect(html).not.toContain('class="stat-card"');
    expect(html).not.toContain('data-filter="status"');

    expect(html).toContain('<div class="tabs-wrap status-tabs" id="status-tabs">');
    expect(html).toContain('<div class="tabs" role="group" aria-label="Status">');
    expect(html).toContain(
      '<button class="tab active" type="submit" name="status" value="" aria-current="true"><span>Open</span><span class="tab-badge num">2</span></button>',
    );
    expect(html).toContain(
      '<button class="tab" type="submit" name="status" value="draft"><span>Draft</span><span class="tab-badge num">1</span></button>',
    );
    expect(html).toContain(
      '<button class="tab" type="submit" name="status" value="approved"><span>Approved</span><span class="tab-badge num">1</span></button>',
    );
    expect(html).toContain(
      '<button class="tab" type="submit" name="status" value="applied"><span>Applied</span><span class="tab-badge num">1</span></button>',
    );
    expect(html).toContain(
      '<button class="tab" type="submit" name="status" value="rejected"><span>Rejected</span><span class="tab-badge num">1</span></button>',
    );
    // The status the search and project fields submit under: the tab button names it on a click,
    // this field carries it for every other submit path; the hidden default button keeps an
    // implicit no-JS submit (Enter in the search field) on the current status.
    expect(html).toContain('<input type="hidden" name="status" value="" data-filter-field="status" disabled=""');
    expect(html).toContain('<button class="sr-only" type="submit" name="status" value="" tabindex="-1" aria-hidden="true">');
  });

  test("the page states the actionable count, the visible total, and the store total", async () => {
    const { env } = seededEnv();
    const html = await (await env.get("/")).text();

    expect(html).toContain('<div class="page-meta" id="page-meta">');
    expect(html).toContain('<span class="page-meta-item"><span class="num">1</span> draft waiting</span>');
    expect(html).toContain('<span class="page-meta-item"><span class="num">4</span> entries</span>');
    expect(html).toContain('<span class="page-meta-item"><span class="num">2</span> projects</span>');
    expect(html).toContain('<div id="list-meta" class="list-meta"><span class="pagination-count num">2 of 4 entries</span>');
  });

  test("a status tab marks itself current and narrows the list", async () => {
    const { env } = seededEnv();
    const html = await (await env.get("/?status=draft")).text();

    expect(html).toContain('<button class="tab active" type="submit" name="status" value="draft" aria-current="true">');
    expect(html).not.toContain('<button class="tab active" type="submit" name="status" value=""');
    expect(html).toContain('<span class="pagination-count num">1 of 4 entries</span>');
    expect(html).toContain('<a class="btn btn-secondary btn-sm" href="/">Clear filters</a>');
    expect(html).toContain('<input type="hidden" name="status" value="draft" data-filter-field="status" disabled=""');
    expect(html).toContain('<button class="sr-only" type="submit" name="status" value="draft" tabindex="-1" aria-hidden="true">');
    // The default Open view hides zeta's applied and rejected rows.
    expect(html).not.toContain('<h2 class="section-title project-name">zeta</h2>');
  });

  test("the htmx fragment re-renders the tabs, the header meta and the count out of band", async () => {
    const { env } = seededEnv();
    const res = await env.get("/?status=draft", HX);
    const html = await res.text();

    expect(html).not.toContain("<html");
    expect(html).toContain('<div class="tabs-wrap status-tabs" id="status-tabs" hx-swap-oob="true">');
    expect(html).toContain('<div class="page-meta" id="page-meta" hx-swap-oob="true">');
    expect(html).toContain('<div id="list-meta" class="list-meta" hx-swap-oob="true">');
  });

  test("an action round moves every count it touched", async () => {
    const { env, draftId } = seededEnv();
    const form = new FormData();
    const res = await env.post(`/entries/${draftId}/approve`, form, HX);
    const html = await res.text();

    expect(html).toContain('<div class="tabs-wrap status-tabs" id="status-tabs" hx-swap-oob="true">');
    expect(html).toContain(
      '<button class="tab" type="submit" name="status" value="draft"><span>Draft</span><span class="tab-badge num">0</span></button>',
    );
    expect(html).toContain(
      '<button class="tab" type="submit" name="status" value="approved"><span>Approved</span><span class="tab-badge num">2</span></button>',
    );
    expect(html).toContain('<span class="page-meta-item"><span class="num">0</span> drafts waiting</span>');
  });

  test("a row leads with the entry title and its file, and the file column is gone", async () => {
    const { env, draftId } = seededEnv();
    const html = await (await env.get("/?status=all")).text();

    expect(html).toContain('<th scope="col">Entry</th>');
    expect(html).not.toContain(">File</th>");
    expect(html).toContain(`<a class="entry-link truncate" href="/entries/${draftId}">Setup wording</a>`);
    expect(html).toContain('<span class="entry-file truncate">docs/setup.md</span>');
    expect(html).not.toContain('class="cell-file truncate"');
  });

  test("a project heading states its drafts and its entries, without mono", async () => {
    const { env } = seededEnv();
    const html = await (await env.get("/?status=all")).text();

    expect(html).toContain('<h2 class="section-title project-name">alpha</h2>');
    expect(html).toContain('<p class="section-lede project-meta">1 draft · 2 entries</p>');
    expect(html).toContain('<p class="section-lede project-meta">2 entries</p>');
  });

  test("every shell page carries a skip link to the page column", async () => {
    const { env, draftId } = seededEnv();
    for (const path of ["/", `/entries/${draftId}`, "/style-guide"]) {
      const html = await (await env.get(path)).text();
      expect(html).toContain('<a class="skip-link" href="#main">Skip to content</a>');
      expect(html).toContain('<main class="page" id="main">');
    }
  });
});

describe("editor information architecture", () => {
  test("the page title names the entry, and the header carries its status, project and file", async () => {
    const { env, draftId } = seededEnv();
    const html = await (await env.get(`/entries/${draftId}`)).text();

    expect(html).toContain('<h1 class="page-title editor-title">Setup wording</h1>');
    expect(html).toContain('<a class="breadcrumb-item" href="/">Entries</a>');
    expect(html).toContain('<span class="breadcrumb-item current">alpha</span>');
    expect(html).toContain('<span id="entry-status"><span class="tag tag-warning"><span class="tag-dot"></span>Draft</span></span>');
    expect(html).toContain('<span class="page-file truncate">docs/setup.md</span>');
    expect(html).toContain('aria-label="Previous entry"');
    expect(html).toContain('aria-label="Next entry"');
    expect(html).not.toContain('class="editor-nav-btn');
  });

  test("the editor is a comparison workspace: one change card, one proposal card, one sectioned support card", async () => {
    const { env, draftId } = seededEnv();
    const html = await (await env.get(`/entries/${draftId}`)).text();

    expect(html).toContain('<div class="editor-page">');
    expect(html).toContain('<div class="editor-grid">');
    expect(html).toContain('<div class="card-title">The change</div>');
    expect(html).toContain('<div class="card current-text-card" id="current-text">');
    expect(html).toContain('<div class="card-subtitle">Removed words tint red; added words tint green.</div>');
    expect(html).toContain('<pre class="diff-code editor-pane">');
    expect(html).toContain('<div class="card-title">Proposed text</div>');
    expect(html).toContain('<textarea id="editor-text" class="input editor-pane"');
    expect(html).toContain('<form id="editor-form" class="card"');
    expect(html).toContain('<div class="editor-actions">');
    expect(html).not.toContain('class="editor-col');
    expect(html).not.toContain(">After</div>");
    expect(html).not.toContain(">Before</div>");
    expect(html).not.toContain('<div class="diff-grid">');
  });

  test("the support cards are one card of four disclosure sections, revision history last", async () => {
    const { env, draftId } = seededEnv();
    const html = await (await env.get(`/entries/${draftId}`)).text();

    expect(html).toContain('<div class="editor-support">');
    expect(html).toContain('<div class="card editor-support-card">');
    expect(html.match(/<details class="disclosure support-section" open(?:="")?>/g)?.length).toBe(4);
    const sections = ["<span>Details</span>", "<span>Notes</span>", "<span>Images</span>", "<span>Revision history</span>"];
    for (let i = 1; i < sections.length; i++) {
      const previous = html.indexOf(sections[i - 1]!);
      const current = html.indexOf(sections[i]!);
      expect(previous).toBeGreaterThanOrEqual(0);
      expect(previous).toBeLessThan(current);
    }
    // The four standalone cards are gone; each body's own form and readout survive inside its section.
    expect(html).not.toContain('class="card details-card"');
    expect(html).not.toContain('class="card notes-card"');
    expect(html).not.toContain('class="card history-card"');
    expect(html).not.toContain('class="card images-card"');
    expect(html).toContain('id="editor-notes"');
    expect(html).toContain("No saved revisions yet");
  });

  test("a terminal entry renders one settled card instead of the same text twice", async () => {
    const { env, appliedId, rejectedId } = seededEnv();
    for (const id of [appliedId, rejectedId]) {
      const html = await (await env.get(`/entries/${id}`)).text();
      expect(html).toContain('<div class="card-title">Settled text</div>');
      expect(html).not.toContain('<div class="card-title">The change</div>');
      expect(html).not.toContain('id="current-text"');
      expect(html.match(/editor-pane/g)?.length).toBe(1);
    }
  });

  test("the textarea drives a live diff through the diff route", async () => {
    const { env, draftId } = seededEnv();
    const html = await (await env.get(`/entries/${draftId}`)).text();

    expect(html).toContain(
      `hx-post="/entries/${draftId}/diff" hx-trigger="input changed delay:250ms" hx-target="#current-text" hx-swap="outerHTML" hx-sync="this:replace"`,
    );
    expect(html).not.toContain('id="editor-text" class="input editor-pane" data-autosize');
    expect(html).not.toContain('id="editor-notes" class="input" name="notes" rows="4" aria-label="Your notes" hx-preserve="true" data-autosize');
  });

  test("the diff route answers the marked current-text card against the submitted text, without writing", async () => {
    const { env, draftId } = seededEnv();
    const form = new FormData();
    form.set("text", "Run bun");
    const res = await env.post(`/entries/${draftId}/diff`, form, HX);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('<div class="card-title">The change</div>');
    expect(html).toContain('<div class="card current-text-card" id="current-text">');
    expect(html).toContain('<span class="diff-remove">install</span>');
    expect(html).not.toContain("<html");
    // A preview never writes: the entry is still a draft with no human text.
    const after = await (await env.get(`/entries/${draftId}`)).text();
    expect(after).toContain('<span class="tag tag-warning"><span class="tag-dot"></span>Draft</span>');
  });

  test("the diff route marks added words beside the kept ones", async () => {
    const { env, draftId } = seededEnv();
    const form = new FormData();
    form.set("text", "Run bun install now");
    const html = await (await env.post(`/entries/${draftId}/diff`, form, HX)).text();

    expect(html).toContain('<span class="diff-add">now</span>');
    // The kept words render once, unmarked: the passage stays a sentence, not two copies.
    expect(html).not.toContain("diff-remove");
    expect(html.match(/Run bun install/g)?.length).toBe(1);
  });

  test("the diff route leaves an empty proposal unmarked", async () => {
    const { env, draftId } = seededEnv();
    const form = new FormData();
    form.set("text", "");
    const html = await (await env.post(`/entries/${draftId}/diff`, form, HX)).text();

    expect(html).not.toContain("diff-remove");
    expect(html).not.toContain("diff-add");
  });

  test("a refused save marks the refused text's additions too", async () => {
    const { env, draftId } = seededEnv();
    // The seeded constraints require the "command" placeholder, so this save refuses and the
    // whole editor view re-renders with the typed text as the proposal.
    const form = new FormData();
    form.set("text", "Run bun install now");
    const html = await (await env.post(`/entries/${draftId}/save`, form, HX)).text();

    expect(html).toContain("Text not saved");
    expect(html).toContain('<span class="diff-add">now</span>');
  });

  test("a rewrite with four changed blocks renders two rows, a small edit stays on one", async () => {
    const env = openEnv();
    const filed = fileEntries(env.store, "alpha", "probe-agent", [
      draft({
        file: "docs/heavy.md",
        anchorHash: "h-heavy",
        fileHash: "f-heavy",
        anchorText: "alpha of beta of gamma of delta",
        agentDraft: "one of two of three of four",
      }),
      draft({
        file: "docs/small.md",
        anchorHash: "h-small",
        fileHash: "f-small",
        anchorText: "Run bun install",
        agentDraft: "Run npm install",
      }),
    ]);
    const heavy = await (await env.get(`/entries/${filed.results[0]!.id}`)).text();

    expect(heavy).toContain('class="diff-code editor-pane diff-rows"');
    expect(heavy).toContain('<span class="diff-line diff-proposed">');

    const small = await (await env.get(`/entries/${filed.results[1]!.id}`)).text();
    expect(small).toContain('<pre class="diff-code editor-pane">');
    expect(small).not.toContain("diff-proposed");
    env.close();
  });

  test("a plain POST to the diff route goes back to the editor", async () => {
    const { env, draftId } = seededEnv();
    const form = new FormData();
    form.set("text", "Run bun");
    const res = await env.post(`/entries/${draftId}/diff`, form);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/entries/${draftId}`);
  });

  test("a save refusal marks the current text against the refused text", async () => {
    const { env, draftId } = seededEnv();
    const form = new FormData();
    form.set("text", "Run bun");
    const res = await env.post(`/entries/${draftId}/save`, form, HX);
    const html = await res.text();

    expect(html).toContain("Text not saved");
    expect(html).toContain('<div class="card-title">The change</div>');
    expect(html).toContain('<div class="card current-text-card" id="current-text">');
    expect(html).toContain('<span class="diff-remove">install</span>');
  });

  test("the draft's one primary action is Save and approve; the agent-draft button is gone", async () => {
    const { env, draftId } = seededEnv();
    const html = await (await env.get(`/entries/${draftId}`)).text();

    expect(html).toContain('<button class="btn btn-fill" type="submit" hx-disabled-elt="this">Save and approve</button>');
    expect(html).not.toContain("Approve draft");
    expect(html).toContain("Saving the text approves the entry and releases it to agents.");
  });

  test("constraints sit with the text they constrain, not in a rail card", async () => {
    const { env, draftId } = seededEnv();
    const html = await (await env.get(`/entries/${draftId}`)).text();

    expect(html).toContain('<div class="constraint-row">');
    // The live counts follow the textarea they measure, wherever the columns place it.
    expect(html.indexOf('id="editor-text"')).toBeLessThan(html.indexOf('class="constraint-row"'));
    expect(html).toContain('data-max-len="200"');
    expect(html).toContain('data-placeholder="command"');
    expect(html).not.toContain('<div class="card-title">Constraints</div>');
  });

  test("a filed placeholder that already carries braces renders with one pair", async () => {
    const env = openEnv();
    const filed = fileEntries(env.store, "alpha", "probe-agent", [
      draft({ constraintsJson: JSON.stringify({ placeholders: ["{canonical}"] }) }),
    ]);
    const html = await (await env.get(`/entries/${filed.results[0]!.id}`)).text();

    expect(html).toContain('<span class="tag tag-data">{canonical}</span>');
    expect(html).not.toContain("{{canonical}}");
    expect(formatSaveRefusal({ kind: "placeholder", placeholder: "{canonical}" })).toBe(
      "The text is missing the placeholder {canonical}. Add {canonical} to the text and save again.",
    );
    env.close();
  });

  test("an applied entry renders its text read-only, with the reason and no failing controls", async () => {
    const { env, appliedId } = seededEnv();
    const html = await (await env.get(`/entries/${appliedId}`)).text();

    expect(html).not.toContain('id="editor-text"');
    expect(html).not.toContain('id="editor-form"');
    expect(html).toContain("Applied");
    expect(html).toContain("returns to approved and can be edited");
    expect(html).toContain('id="notes-form"');
  });

  test("a transition answers with the region and the header status out of band", async () => {
    const { env, approvedId } = seededEnv();
    const form = new FormData();
    form.set("view", "editor");
    const res = await env.post(`/entries/${approvedId}/reject`, form, HX);
    const html = await res.text();

    expect(html).toContain('<div id="editor-region" tabindex="-1" class="editor-region-wide">');
    expect(html).toContain('<span id="entry-status" hx-swap-oob="true">');
    expect(html).toContain('<span class="tag tag-danger"><span class="tag-dot"></span>Rejected</span>');
    expect(html).not.toContain('id="editor-form"');
    expect(html).toContain("A rejected entry stays rejected");
  });
});

describe("style guide form", () => {
  test("fields stack in one column and every textarea asks to be autosized", async () => {
    const { env } = seededEnv();
    const html = await (await env.get("/style-guide")).text();

    expect(html).not.toContain("form-grid");
    expect(html).toContain('<div class="card style-guide-card">');
    expect(html).toContain('<div class="card-content style-guide-fields">');
    expect(html.match(/data-autosize/g) ?? []).toHaveLength(2);
    expect(html).toContain('<button class="btn btn-fill" type="submit" hx-disabled-elt="this">Save guide</button>');
  });

  test("the textarea autosizer owns every data-autosize field", async () => {
    const js = await Bun.file(new URL("../../src/dashboard/static/dashboard.js", import.meta.url)).text();
    expect(js).toContain('querySelectorAll("textarea[data-autosize]")');
  });
});

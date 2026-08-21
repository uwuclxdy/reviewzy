import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { createApp } from "../../src/daemon/app.ts";
import { fileEntries, listEntries } from "../../src/db/queries.ts";
import type { NewEntry } from "../../src/db/queries.ts";
import { openStore } from "../../src/db/store.ts";
import type { Store } from "../../src/db/store.ts";

// Read independently of `src/version.ts`, so the assertion cannot pass by importing its own answer.
const manifest = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as {
  version: string;
};

const tempDirs: string[] = [];

/** One app per suite-leg with its own temp-file store, the pattern test/mcp/* uses (a `:memory:` db cannot enable WAL). */
function serveApp() {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-dashboard-"));
  tempDirs.push(dir);
  const config = loadConfig({ REVIEWZY_DB: join(dir, "reviewzy.db") });
  const store = openStore(config);
  const app = createApp(config, store);
  return {
    store,
    get: (path: string, headers: Record<string, string> = {}) => app.request(path, { headers }),
    close: () => store.close(),
  };
}

function draft(over: Partial<NewEntry>): NewEntry {
  return {
    repo: "https://example.com/org/repo.git",
    file: "docs/readme.md",
    title: null,
    anchorText: "anchor",
    anchorBefore: "",
    anchorAfter: "",
    anchorHash: "h-anchor",
    fileHash: "f-file",
    agentDraft: "a draft",
    contextJson: "{}",
    constraintsJson: "{}",
    imagesJson: null,
    ...over,
  };
}

// ---- The shared fixture: 6 entries across 4 batches and 2 projects, every status represented.
// One fileEntries call per batch, so the batch ids are the store's own ulids.
const env = serveApp();
const batchA = fileEntries(env.store, "alpha", "probe-agent", [
  draft({
    file: "docs/setup.md",
    anchorText: "Run bun install",
    anchorHash: "h1",
    fileHash: "f1",
    agentDraft: "Fix the wording of the setup section.",
    constraintsJson: JSON.stringify({ max_len: 200, placeholders: ["command"] }),
  }),
  draft({
    file: "docs/cache.md",
    anchorText: "The cache lives at",
    anchorHash: "h2",
    fileHash: "f2",
    agentDraft: "Explain the cache directory.",
  }),
]);
const batchB = fileEntries(env.store, "alpha", "probe-agent", [
  draft({
    file: "LICENSE.md",
    anchorText: "AGPL-3.0",
    anchorHash: "h3",
    fileHash: "f3",
    agentDraft: "Note the license.",
    constraintsJson: JSON.stringify({ placeholders: ["year"] }),
  }),
  draft({
    file: "README.md",
    anchorText: "shields badge",
    anchorHash: "h4",
    fileHash: "f4",
    agentDraft: "Add a status badge to the README.",
    constraintsJson: JSON.stringify({ max_len: 40 }),
  }),
]);
const batchC = fileEntries(env.store, "alpha", null, [
  draft({
    file: "docs/migrate.md",
    anchorText: "Run the migration",
    anchorHash: "h5",
    fileHash: "f5",
    agentDraft: "Describe the migration.",
  }),
]);
const batchD = fileEntries(env.store, "zeta", "probe-agent", [
  draft({
    file: "docs/faq.md",
    anchorText: "Frequently asked",
    anchorHash: "h6",
    fileHash: "f6",
    agentDraft: "Update the FAQ.",
  }),
]);

// The approve flow is a later task, so statuses move here through the store directly; the
// human_text replacement is what a sign-off will write.
env.store.db.run("UPDATE entries SET status = 'approved', human_text = 'Explain where the cache lives.' WHERE id = ?", [
  batchA.results[1]!.id,
]);
env.store.db.run("UPDATE entries SET status = 'applied' WHERE id = ?", [batchB.results[0]!.id]);
env.store.db.run("UPDATE entries SET status = 'rejected' WHERE id = ?", [batchB.results[1]!.id]);
// A second filer in batchB makes it a mixed-filer batch: the header names no filer, each row names its own.
env.store.db.run("UPDATE entries SET filed_by = 'other-agent' WHERE id = ?", [batchB.results[0]!.id]);

/** The rendered title of each fixture entry (the anchor text here, since none of these filed a title), keyed by entry id. */
const RENDERED: { batchId: string; id: string; text: string }[] = [
  { batchId: batchA.batchId, id: batchA.results[0]!.id, text: "Run bun install" },
  { batchId: batchA.batchId, id: batchA.results[1]!.id, text: "The cache lives at" },
  { batchId: batchB.batchId, id: batchB.results[0]!.id, text: "AGPL-3.0" },
  { batchId: batchB.batchId, id: batchB.results[1]!.id, text: "shields badge" },
  { batchId: batchC.batchId, id: batchC.results[0]!.id, text: "Run the migration" },
  { batchId: batchD.batchId, id: batchD.results[0]!.id, text: "Frequently asked" },
];

afterAll(() => {
  env.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Asserts the needles appear in the haystack in exactly this order. */
function expectOrder(html: string, needles: readonly string[]) {
  let prev = -1;
  for (const needle of needles) {
    const idx = html.indexOf(needle);
    expect(idx, `"${needle}" appears after the previous needle`).toBeGreaterThan(prev);
    prev = idx;
  }
}

/** The head+tail short form of a ulid, mirroring the view's `shortUlid`. */
function shortUlid(id: string): string {
  return `${id.slice(0, 6)}…${id.slice(-6)}`;
}

/** The `.batch-header` region for a batch, from its header div to the table that follows. */
function batchHeader(html: string, batchId: string): string {
  const idMark = html.indexOf(`aria-label="Select all drafts in batch ${shortUlid(batchId)}"`);
  expect(idMark, `batch ${batchId} header rendered`).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<div class="batch-header">', idMark);
  const end = html.indexOf('<div class="table-wrap">', idMark);
  return html.slice(start, end);
}

/** The `.cell-actions` region for an entry, from its `<td>` to the row's close. */
function entryActions(html: string, id: string): string {
  const mark = html.indexOf(`href="/entries/${id}"`);
  expect(mark, `entry ${id} action cell rendered`).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<td class="cell-actions">', mark);
  const end = html.indexOf("</td>", mark);
  return html.slice(start, end);
}

describe("dashboard entry list", () => {
  test("serves the page shell: navbar, filter form, list region, and error box template", async () => {
    const res = await env.get("/");
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>Entries · reviewzy</title>");
    expect(html).toContain('lang="en"');
    expect(html).toContain('data-theme="dark"');

    // Navbar shell with brand, one nav link, and the sliding ink host.
    expect(html).toContain('<nav class="navbar">');
    expect(html).toContain('<div class="logo-name">reviewzy</div>');
    expect(html).toContain(`<div class="logo-version">v${manifest.version}</div>`);
    expect(html).toContain('<a class="navbar-link active" href="/">Entries</a>');
    expect(html).toContain('id="navbar-ink"');

    // Page header: the title plus the total count, no eyebrow or lede.
    expect(html).toContain("<h1 class=\"page-title\">Entries</h1>");
    expect(html).toContain('<span class="page-count">6 entries</span>');
    expect(html).not.toContain("Review queue");
    expect(html).not.toContain("Agent drafts waiting for your approval.");

    // The filter form: native GET for no-JS, htmx for the fragment swap.
    expect(html).toContain('<form id="filters" method="get" action="/"');
    expect(html).toContain('hx-get="/"');
    expect(html).toContain('hx-target="#entries-list"');
    expect(html).toContain('hx-swap="innerHTML"');
    expect(html).toContain('hx-indicator="#entries-loading"');
    expect(html).toContain('name="q"');
    expect(html).toContain('name="status"');
    expect(html).toContain('name="project"');
    // The Apply button survives only inside <noscript> as the no-JS submit path: the selects and
    // search auto-submit on change/input via dashboard.js, and without JS the button submits natively.
    expect(html).toContain("<noscript>");
    expect(html).toContain('class="btn btn-primary" type="submit">Apply filters</button>');

    // The loading indicator, scoped to the list region.
    expect(html).toContain('<div id="entries-loading" class="htmx-indicator" role="status">');
    expect(html).toContain("Loading entries");

    // The error box template the page ships for htmx:responseError, with a retry control.
    expect(html).toContain('<template id="error-box">');
    expect(html).toContain("The list could not be loaded");
    expect(html).toContain("The filter request failed. Try it again.");
    expect(html).toContain("data-retry");
    expect(html).toContain('role="alert"');

    // Vendored htmx loads before first-party JS.
    const htmxIdx = html.indexOf("/static/htmx.min.js");
    const appIdx = html.indexOf("/static/dashboard.js");
    expect(htmxIdx).toBeGreaterThan(0);
    expect(appIdx).toBeGreaterThan(htmxIdx);
  });

  test("lists entries grouped by project then batch, actionable first and newest batch first", async () => {
    const html = await (await env.get("/")).text();

    // Projects in slug order; each project header carries its entry count.
    expect(html.indexOf('<h2 class="project-name">alpha</h2>')).toBeLessThan(
      html.indexOf('<h2 class="project-name">zeta</h2>'),
    );
    expect(html).toContain(">5 entries</span>");
    expect(html).toContain(">1 entry</span>");

    // The batch order derives from the store, mirroring the view's own rule: a batch with any
    // draft or approved entry is actionable and leads; both partitions sort newest first (ulid
    // millisecond prefix descending, the batch's newest created_at breaking a same-ms tie, then
    // the id), and projects stay in slug order.
    const walked = listEntries(env.store, {
      projectId: undefined,
      status: undefined,
      ids: undefined,
      q: undefined,
      cursor: undefined,
      limit: 1000,
    }).rows;
    const batchOf = new Map<string, { statuses: string[]; createdAt: number }>();
    for (const row of walked) {
      const prev = batchOf.get(row.batch_id);
      batchOf.set(row.batch_id, {
        statuses: [...(prev?.statuses ?? []), row.status],
        createdAt: Math.max(prev?.createdAt ?? 0, row.created_at),
      });
    }
    const actionable = (id: string) =>
      (batchOf.get(id)?.statuses ?? []).some((status) => status === "draft" || status === "approved");
    const desc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);
    const newestFirst = (ids: readonly string[]) =>
      [...ids].sort((a, b) => {
        const timeCmp = desc(a.slice(0, 10), b.slice(0, 10));
        if (timeCmp !== 0) return timeCmp;
        const aCreated = batchOf.get(a)!.createdAt;
        const bCreated = batchOf.get(b)!.createdAt;
        if (aCreated !== bCreated) return bCreated - aCreated;
        return desc(a, b);
      });
    const alphaBatches = [batchA.batchId, batchB.batchId, batchC.batchId];
    const expectedOrder = [
      ...newestFirst(alphaBatches.filter(actionable)),
      ...newestFirst(alphaBatches.filter((id) => !actionable(id))),
      ...newestFirst([batchD.batchId]),
    ];
    const textsByBatch = new Map<string, { id: string; text: string }[]>();
    for (const item of RENDERED) {
      textsByBatch.set(item.batchId, [...(textsByBatch.get(item.batchId) ?? []), { id: item.id, text: item.text }]);
    }
    expectedOrder.forEach((batchId, i) => {
      const start = html.indexOf(`aria-label="Select all drafts in batch ${shortUlid(batchId)}"`);
      expect(start, `batch ${batchId} rendered in batch order`).toBeGreaterThan(-1);
      const end = i + 1 < expectedOrder.length ? html.indexOf(`aria-label="Select all drafts in batch ${shortUlid(expectedOrder[i + 1]!)}"`) : html.length;
      const texts = textsByBatch
        .get(batchId)!
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((t) => t.text);
      expectOrder(html.slice(start, end), texts);
    });

    // A row carries the select checkbox, the title, the file path, and the action slots.
    expect(html).toContain(">Select</th>");
    expect(html).toContain(">Title</th>");
    expect(html).toContain(">Status</th>");
    expect(html).toContain(">File</th>");
    expect(html).toContain(">Actions</th>");
    expect(html).toContain('class="tag tag-warning">Draft</span>');
    expect(html).toContain('class="tag tag-success">Approved</span>');
    expect(html).toContain('class="tag tag-info">Applied</span>');
    expect(html).toContain('class="tag tag-danger">Rejected</span>');
    // The title leads (the anchor text when no title was filed); the file path is a separate column,
    // and the cell title carries the full path and anchor.
    expect(html).toContain('<span class="entry-title">Run bun install</span>');
    expect(html).toContain('title="docs/setup.md — Run bun install"');
    expect(html).toContain('<td class="cell-file" title="docs/setup.md">docs/setup.md</td>');
  });

  test("batch header shows the filer only when every entry agrees on one", async () => {
    const html = await (await env.get("/")).text();

    // A single-filer batch names that filer once in its header; batchA and batchD are both
    // probe-agent alone, so each of their headers carries the name exactly once.
    expect(batchHeader(html, batchA.batchId).match(/probe-agent/g) ?? []).toHaveLength(1);
    expect(batchHeader(html, batchD.batchId).match(/probe-agent/g) ?? []).toHaveLength(1);
    // An all-null batch shows no filer slot at all.
    const cHeader = batchHeader(html, batchC.batchId);
    expect(cHeader).not.toContain("filer");
    expect(cHeader).not.toContain("probe-agent");
  });

  test("a mixed-filer batch names no filer in the header and labels each row inline", async () => {
    const html = await (await env.get("/")).text();

    // batchB holds two filers (probe-agent and other-agent): the header names neither.
    const bHeader = batchHeader(html, batchB.batchId);
    expect(bHeader).not.toContain("probe-agent");
    expect(bHeader).not.toContain("other-agent");

    // Each row names its own filer inline beside the file basename.
    expect(html).toContain('<span class="entry-filer"> · other-agent</span>');
    expect(html).toContain('<span class="entry-filer"> · probe-agent</span>');
  });

  test("a batch mixing a filer with an unfiled entry labels only the filed row", async () => {
    const mixed = serveApp();
    try {
      const filed = fileEntries(mixed.store, "alpha", "solo-agent", [
        draft({ file: "docs/a.md", anchorText: "a", anchorHash: "ha", fileHash: "fa", agentDraft: "A note." }),
        draft({ file: "docs/b.md", anchorText: "b", anchorHash: "hb", fileHash: "fb", agentDraft: "B note." }),
      ]);
      // Null one entry's filer so the batch holds a filer and an unfiled entry: not every entry agrees.
      mixed.store.db.run("UPDATE entries SET filed_by = NULL WHERE id = ?", [filed.results[1]!.id]);
      const html = await (await mixed.get("/")).text();
      const header = batchHeader(html, filed.batchId);
      expect(header).not.toContain("solo-agent");
      expect(html).toContain('<span class="entry-filer"> · solo-agent</span>');
    } finally {
      mixed.close();
    }
  });

  test("adds a per-batch select-all and keeps the approve button static and enabled without JS", async () => {
    const html = await (await env.get("/")).text();

    // One select-all per batch (4), and it never carries `name`, so it is not submitted as an
    // entry id — the draft checkboxes alone post as `id`.
    expect(html.match(/type="checkbox" class="select-all"/g) ?? []).toHaveLength(4);
    expect(html).not.toContain('name="id" class="select-all"');

    // Only draft rows carry a selectable checkbox: batchA has one draft, batchB none (applied +
    // rejected), and batchC and batchD one each.
    expect(html.match(/type="checkbox" name="id"/g) ?? []).toHaveLength(3);

    // The no-JS approve button keeps its static label and no `disabled` attribute; the live count
    // and the disabled state are applied by dashboard.js.
    expect(html).toContain(
      'class="btn btn-primary btn-sm" type="submit" hx-disabled-elt="this">Approve selected</button>',
    );
  });

  test("renders three icon action slots per status", async () => {
    const html = await (await env.get("/")).text();

    // Draft: approve and reject are enabled, edit is always a live link.
    const draftId = batchA.results[0]!.id;
    const draftActions = entryActions(html, draftId);
    expect(draftActions).toContain('aria-label="Approve docs/setup.md"');
    expect(draftActions).toContain(`title="Approve" hx-post="/entries/${draftId}/approve"`);
    expect(draftActions).toContain('aria-label="Reject docs/setup.md"');
    expect(draftActions).toContain(`title="Reject" hx-post="/entries/${draftId}/reject"`);
    expect(draftActions).toContain('aria-label="Edit docs/setup.md"');
    expect(draftActions).toContain(`href="/entries/${draftId}"`);

    // Approved: approve is disabled, reject enabled, edit present.
    const approvedId = batchA.results[1]!.id;
    const approvedActions = entryActions(html, approvedId);
    expect(approvedActions).toContain('aria-label="Approve docs/cache.md"');
    expect(approvedActions).toContain('title="Approve" disabled');
    expect(approvedActions).not.toContain(`hx-post="/entries/${approvedId}/approve"`);
    expect(approvedActions).toContain(`title="Reject" hx-post="/entries/${approvedId}/reject"`);
    expect(approvedActions).toContain(`href="/entries/${approvedId}"`);

    // Applied and rejected: approve and reject are both disabled; edit stays.
    for (const [id, file] of [
      [batchB.results[0]!.id, "LICENSE.md"],
      [batchB.results[1]!.id, "README.md"],
    ] as const) {
      const actions = entryActions(html, id);
      expect(actions).toContain(`aria-label="Approve ${file}"`);
      expect(actions).toContain('title="Approve" disabled');
      expect(actions).toContain(`aria-label="Reject ${file}"`);
      expect(actions).toContain('title="Reject" disabled');
      expect(actions).not.toContain(`hx-post="/entries/${id}/approve"`);
      expect(actions).not.toContain(`hx-post="/entries/${id}/reject"`);
      expect(actions).toContain(`href="/entries/${id}"`);
    }
  });

  test("filters by search text over the same columns as the mcp tool", async () => {
    // agent_draft
    const byDraft = await (await env.get("/?q=wording")).text();
    expect(byDraft).toContain("Run bun install");
    expect(byDraft).not.toContain("The cache lives at");
    // file, case-insensitive
    const byFile = await (await env.get("/?q=CACHE")).text();
    expect(byFile).toContain("The cache lives at");
    expect(byFile).not.toContain("Run bun install");
    // anchor_text
    const byAnchor = await (await env.get("/?q=bun+install")).text();
    expect(byAnchor).toContain("Run bun install");
    expect(byAnchor).not.toContain("AGPL-3.0");
    // human_text
    const byHuman = await (await env.get("/?q=where+the+cache")).text();
    expect(byHuman).toContain("The cache lives at");
    expect(byHuman).not.toContain("Run bun install");
  });

  test("filters by status", async () => {
    const html = await (await env.get("/?status=rejected")).text();
    expect(html).toContain("shields badge");
    expect(html).not.toContain("Run bun install");
    expect(html).toContain("Showing 1 of 6 entries");
    // The select reflects the active filter.
    expect(html).toContain('<option value="rejected" selected="">Rejected</option>');
  });

  test("filters by project", async () => {
    const html = await (await env.get("/?project=zeta")).text();
    expect(html).toContain("Frequently asked");
    expect(html).not.toContain("Run bun install");
    expect(html).not.toContain('<h2 class="project-name">alpha</h2>');
    expect(html).toContain('<option value="zeta" selected="">zeta</option>');
  });

  test("combines filters", async () => {
    const html = await (await env.get("/?q=setup&status=draft&project=alpha")).text();
    expect(html).toContain("Run bun install");
    expect(html).not.toContain("The cache lives at");
    expect(html).toContain("Showing 1 of 6 entries");
  });

  test("shows the partial header only for a strict subset", async () => {
    // q=docs matches 4 of the 6 entries.
    const partial = await (await env.get("/?q=docs")).text();
    expect(partial).toContain("Showing 4 of 6 entries");
    expect(partial).toContain("Clear filters");
    expect(partial).toContain("Run bun install");
    expect(partial).not.toContain("AGPL-3.0");
    expect(partial).toContain('value="docs"');

    // A filter matching everything is the success state, not partial.
    const full = await (await env.get("/?q=the")).text();
    expect(full).not.toContain("Showing ");
    expect(full).toContain("AGPL-3.0");
    expect(full).toContain("Frequently asked");

    // No filters is the success state too.
    const plain = await (await env.get("/")).text();
    expect(plain).not.toContain("Showing ");
  });

  test("a filter that cannot match shows the no-match state with a way back", async () => {
    for (const query of ["?q=zzz", "?status=bogus", "?project=nope"]) {
      const html = await (await env.get(query)).text();
      expect(html).toContain("No entries match");
      expect(html).toContain('<a href="/" class="btn btn-secondary btn-sm">Clear filters</a>');
      expect(html).not.toContain("entry-title");
    }
    // The search box keeps what was typed.
    expect(await (await env.get("/?q=zzz")).text()).toContain('value="zzz"');
  });

  test("a store with no entries shows the empty state, filters included", async () => {
    const fresh = serveApp();
    try {
      const html = await (await fresh.get("/")).text();
      expect(html).toContain("No entries yet");
      expect(html).toContain("mcp endpoint");
      expect(html).not.toContain("entry-title");
      // Zero entries at all reads as "no entries yet" even under a filter: nothing exists to filter.
      const filtered = await (await fresh.get("/?q=zzz&status=draft")).text();
      expect(filtered).toContain("No entries yet");
    } finally {
      fresh.close();
    }
  });

  test("answers a list fragment to htmx requests", async () => {
    const res = await env.get("/?q=wording", { "HX-Request": "true" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Run bun install");
    expect(html).toContain("Showing 1 of 6 entries");
    // A fragment is the list region only, not the page shell.
    expect(html).not.toContain("<!doctype html>");
    expect(html).not.toContain('id="filters"');
    expect(html).not.toContain('class="navbar"');
  });

  test("serves static assets with the pinned vendor versions", async () => {
    const tokens = await env.get("/static/tokens.css");
    expect(tokens.status).toBe(200);
    expect(tokens.headers.get("content-type")).toContain("text/css");
    expect(await tokens.text()).toContain("reviewzy — design tokens");

    const components = await env.get("/static/components.css");
    expect(components.status).toBe(200);
    expect(await components.text()).toContain("reviewzy — component styles");

    const htmx = await env.get("/static/htmx.min.js");
    expect(htmx.status).toBe(200);
    expect(htmx.headers.get("content-type")).toContain("text/javascript");
    expect(await htmx.text()).toContain("htmx.org 2.0.10");

    const appJs = await env.get("/static/dashboard.js");
    expect(appJs.status).toBe(200);
    const appJsText = await appJs.text();
    expect(appJsText).toContain("htmx:responseError");
    expect(appJsText).toContain("htmx:sendError");

    const font = await env.get("/static/fonts/onest-latin.woff2");
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toContain("font/woff2");
    expect((await env.get("/static/fonts/OFL-Onest.txt")).status).toBe(200);
    expect(await (await env.get("/static/fonts/OFL-Onest.txt")).text()).toContain("Onest Project Authors");

    // Missing files and traversal attempts are refused.
    expect((await env.get("/static/nope.css")).status).toBe(404);
    expect((await env.get("/static/%2e%2e/daemon/app.ts")).status).toBe(404);
    expect((await env.get("/static/..%2fdaemon/app.ts")).status).toBe(404);
  });

  test("applies the app-wide origin gate to the dashboard", async () => {
    const res = await env.get("/", { origin: "https://attacker.example" });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Invalid Origin");
    // Static assets sit behind the same gate.
    expect((await env.get("/static/tokens.css", { origin: "https://attacker.example" })).status).toBe(403);
    // An absent Origin passes, as the shim and curl send none.
    expect((await env.get("/")).status).toBe(200);
  });

  test("escapes entry text", async () => {
    const xs = serveApp();
    try {
      fileEntries(xs.store, "alpha", "probe-agent", [
        draft({
          file: 'weird"file.md',
          anchorText: '<img src=x onerror=alert(1)>',
          anchorHash: "h-xss",
          fileHash: "f-xss",
          agentDraft: 'He said "hi" <script>alert("xss")</script>',
          title: 'He said "hi" <script>alert("title")</script>',
        }),
      ]);
      const html = await (await xs.get("/")).text();
      // The full-text preview is gone, so the title and the file path are the user-reachable
      // strings left in the list; both escape.
      expect(html).not.toContain('<script>alert("title")</script>');
      expect(html).not.toContain('<img src=x');
      expect(html).toContain("&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;");
      expect(html).toContain('weird&quot;file.md');
    } finally {
      xs.close();
    }
  });

  test("walks past one page of the list query", async () => {
    const big = serveApp();
    try {
      const drafts: NewEntry[] = [];
      for (let i = 1; i <= 200; i++) {
        drafts.push(
          draft({
            file: "docs/common.md",
            anchorText: `common anchor ${i}`,
            anchorHash: `h-common-${i}`,
            fileHash: `f-common-${i}`,
            agentDraft: `Entry ${i} of the walk fixture.`,
          }),
        );
      }
      // The 201st entry can only render if the dashboard continues past the first page of 200.
      drafts.push(
        draft({
          file: "docs/other.md",
          anchorText: "the odd one out",
          anchorHash: "h-odd",
          fileHash: "f-odd",
          agentDraft: "The 201st entry, on page two of the walk.",
        }),
      );
      fileEntries(big.store, "alpha", "probe-agent", drafts);

      // Page 1 is the first 200 rows by id — which rows those are depends on the batch's ulid
      // order, not on filing order — so the walk's second page is found by the same keyset walk.
      const page1 = listEntries(big.store, {
        projectId: undefined,
        status: undefined,
        ids: undefined,
        q: undefined,
        cursor: undefined,
        limit: 200,
      });
      const page2 = listEntries(big.store, {
        projectId: undefined,
        status: undefined,
        ids: undefined,
        q: undefined,
        cursor: page1.nextCursor ?? undefined,
        limit: 200,
      });
      expect(page2.rows).toHaveLength(1);

      const html = await (await big.get("/")).text();
      // The whole walk renders: all 201 rows (one entry row each), page 2's row included. A walk
      // that stops after the first page renders exactly one row short, whatever the id order.
      expect(html.match(/class="cell-title"/g) ?? []).toHaveLength(201);
      const page2Text = page2.rows[0]!.anchor_text;
      expect(page2Text).not.toBeNull();
      expect(html).toContain(page2Text!);

      // A filter matching exactly one page reports the walk's full count, not the page's.
      const filtered = await (await big.get("/?q=common")).text();
      expect(filtered).toContain("Showing 200 of 201 entries");
      expect(filtered).not.toContain("The 201st entry");
    } finally {
      big.close();
    }
  });

  test("a whitespace-only search is no filter at all", async () => {
    const html = await (await env.get("/?q=%20%20")).text();
    expect(html).toContain("Run bun install");
    expect(html).toContain("Frequently asked");
    expect(html).not.toContain("Showing ");
  });
});

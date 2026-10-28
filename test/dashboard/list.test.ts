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

/** The rendered title of each fixture entry (the anchor text here, since none of these filed a title), keyed by project. */
const RENDERED: { project: "alpha" | "zeta"; id: string; text: string }[] = [
  { project: "alpha", id: batchA.results[0]!.id, text: "Run bun install" },
  { project: "alpha", id: batchA.results[1]!.id, text: "The cache lives at" },
  { project: "alpha", id: batchB.results[0]!.id, text: "AGPL-3.0" },
  { project: "alpha", id: batchB.results[1]!.id, text: "shields badge" },
  { project: "alpha", id: batchC.results[0]!.id, text: "Run the migration" },
  { project: "zeta", id: batchD.results[0]!.id, text: "Frequently asked" },
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

/** The head+tail chip the list used to render, kept so the flattened chrome is asserted absent. */
function shortUlid(id: string): string {
  return `${id.slice(0, 6)}…${id.slice(-6)}`;
}

/** The `.cell-actions` region for an entry, from its `<td>` to the row's close. The row carries
    two links to the editor (the title and the edit icon), so the edit link's own position anchors
    the region. */
function entryActions(html: string, id: string): string {
  const href = `href="/entries/${id}"`;
  const titleMark = html.indexOf(href);
  expect(titleMark, `entry ${id} title link rendered`).toBeGreaterThan(-1);
  const mark = html.indexOf(href, titleMark + 1);
  expect(mark, `entry ${id} edit link rendered`).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<td class="cell-actions">', mark);
  const end = html.indexOf("</td>", mark);
  return html.slice(start, end);
}

describe("dashboard entry list", () => {
  test("serves the page shell: sidebar, filter form, list region, and error box template", async () => {
    const res = await env.get("/");
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>Entries · reviewzy</title>");
    expect(html).toContain('lang="en"');
    expect(html).toContain('data-theme="dark"');

    // One shell: the mobile topbar and overlay outside the grid, the sidebar and page column
    // inside it. The drawer is the same sidebar element, so there is no second nav tree.
    expect(html).toContain('<div class="mobile-topbar">');
    expect(html).toContain('id="hamburger-btn"');
    expect(html).toContain('id="sidebar-overlay"');
    expect(html).toContain('<div class="layout">');
    expect(html).toContain('<nav class="sidebar" id="sidebar" aria-label="Dashboard">');
    expect(html).toContain('<div class="logo-name">reviewzy</div>');
    expect(html).toContain('class="sidebar-collapse"');
    expect(html).toContain('<div class="nav-group-label">Queue</div>');
    expect(html).toContain('<div class="nav-group-label">Content</div>');
    expect(html).toContain('<a class="nav-item active" href="/" aria-current="true"><span>Entries</span><span class="nav-badge" id="entries-badge">3</span></a>');
    expect(html).toContain('<a class="nav-item" href="/style-guide"><span>Style guide</span></a>');
    // The desktop navbar is gone; no page carries a second navigation pattern.
    expect(html).not.toContain('class="navbar"');
    expect(html).not.toContain('class="navbar-link');
    expect(html).not.toContain("navbar-ink");

    // Page header: title, then the store's entry and project counts, with no eyebrow or lede.
    expect(html).toContain("<h1 class=\"page-title\">Entries</h1>");
    expect(html).toContain('<span class="page-meta-item"><span class="num">6</span> entries</span>');
    expect(html).toContain('<span class="page-meta-item"><span class="num">2</span> projects</span>');

    // The reference rhythm: the banner slot, the status tab strip, then the queue section.
    expect(html).toContain('<div id="page-banner">');
    expect(html).toContain('<div class="tabs-wrap status-tabs" id="status-tabs">');
    expect(html).toContain('<div class="section-head"><div class="label">Queue</div></div>');
    // One display title on the page: the section names itself with its eyebrow alone.
    expect(html).not.toContain('<h2 class="section-title">Entries</h2>');
    expect(html.match(/<h1 class="page-title">Entries<\/h1>/g)?.length).toBe(1);
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
    // The two dropdowns are the system .select (a native select never renders with JS on): the
    // trigger plus listbox, and a disabled hidden input carrying the name — dashboard.js enables
    // it, and a no-JS submit reads the noscript native selects instead of a stale hidden value.
    expect(html).toContain('class="filter-bar"');
    expect(html).toContain('class="input select-trigger"');
    expect(html).toContain('class="select-menu"');
    // The status control is the tab strip of submit buttons inside this form, never a second
    // dropdown beside it; the project filter keeps its hidden input.
    expect(html).toContain('<button class="tab active" type="submit" name="status" value="" aria-current="true">');
    expect(html).toContain('name="project" value="" data-filter-field="project" disabled=""');
    expect(html).toContain('name="q"');
    // The no-JS submit path keeps a native select carrying the project filter's name; the status
    // tabs submit natively, so no redundant native select ships for them.
    expect(html).toContain('<noscript>');
    expect(html).not.toContain('id="status-native"');
    // The form's default submit button carries the current status for an implicit no-JS submit,
    // and dashboard.js drops every submit button's name once the hidden field owns the status.
    expect(html).toContain('<button class="sr-only" type="submit" name="status" value="" tabindex="-1" aria-hidden="true">');
    expect(html).toContain('<select class="input" id="project-native" name="project">');
    expect(html).toContain('class="btn btn-primary" type="submit" name="status" value="">Apply filters</button>');
    // The filter form carries no visible field labels; the bar's own affordances name it.
    expect(html).toContain('<label class="sr-only" for="q">Search</label>');

    // The loading indicator, scoped to the list region.
    expect(html).toContain('<div id="entries-loading" class="htmx-indicator" role="status">');
    expect(html).toContain("Loading entries");

    // An htmx failure surfaces as a transient toast; the stack it lands in ships on the page and
    // the cloned error box is gone.
    expect(html).toContain('<div class="toast-stack" id="toast-stack"></div>');
    expect(html).not.toContain("error-box");

    // Vendored htmx loads before first-party JS.
    const htmxIdx = html.indexOf("/static/htmx.min.js");
    const appIdx = html.indexOf("/static/dashboard.js");
    expect(htmxIdx).toBeGreaterThan(0);
    expect(appIdx).toBeGreaterThan(htmxIdx);

    // The saved theme is restored inline before the first stylesheet, or a light-theme visitor
    // sees a dark flash; the modules below cannot run early enough to own this step.
    expect(html).toContain('const saved = localStorage.getItem("cloudy-theme"); if (saved) document.documentElement.dataset.theme = saved;');
    expect(html.indexOf('localStorage.getItem("cloudy-theme")')).toBeLessThan(html.indexOf('href="/static/tokens.css"'));
  });

  test("lists one dense table per project, projects in slug order", async () => {
    // `status=all` so the full fixture renders: the default Active view hides the terminal rows.
    const html = await (await env.get("/?status=all")).text();

    // Projects in slug order; each project header carries the drafts and entries of its shown rows.
    expect(html.indexOf('<h2 class="section-title project-name">alpha</h2>')).toBeLessThan(
      html.indexOf('<h2 class="section-title project-name">zeta</h2>'),
    );
    expect(html).toContain("2 drafts · 5 entries");
    expect(html).toContain("1 draft · 1 entry");

    // One table per project, both dense: two tables, never one per batch.
    expect(html.match(/<div class="table-wrap table-dense">/g) ?? []).toHaveLength(2);
    expect(html.match(/<table>/g) ?? []).toHaveLength(2);

    // Each project's table holds exactly its own rows, in the list query's ascending id order.
    const zetaStart = html.indexOf('<h2 class="section-title project-name">zeta</h2>');
    const alphaSlice = html.slice(html.indexOf('<h2 class="section-title project-name">alpha</h2>'), zetaStart);
    const zetaSlice = html.slice(zetaStart);
    const alphaOrder = RENDERED.filter((item) => item.project === "alpha")
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((item) => item.text);
    expectOrder(alphaSlice, alphaOrder);
    expect(zetaSlice).toContain("Frequently asked");
    expect(zetaSlice).not.toContain("Run bun install");

    // The rows carry the four statuses and the entry cell leads with the title link over its file.
    expect(html).toContain('<span class="tag tag-warning"><span class="tag-dot"></span>Draft</span>');
    expect(html).toContain('<span class="tag tag-success"><span class="tag-dot"></span>Approved</span>');
    expect(html).toContain('<span class="tag tag-info"><span class="tag-dot"></span>Applied</span>');
    expect(html).toContain('<span class="tag tag-danger"><span class="tag-dot"></span>Rejected</span>');
    expect(html).toContain(`<a class="entry-link truncate" href="/entries/${batchA.results[0]!.id}">Run bun install</a>`);
    expect(html).toContain('<span class="entry-file truncate">docs/setup.md</span>');

    // The flattened chrome stays gone: no disclosures, no batch ulids, no filers in the list.
    expect(html.match(/data-collapse-key/g) ?? []).toHaveLength(0);
    expect(html).not.toContain('<details class="disclosure');
    expect(html).not.toContain(`>${shortUlid(batchA.batchId)}<`);
    expect(html).not.toContain(`>${shortUlid(batchB.batchId)}<`);
    expect(html).not.toContain('<span class="entry-filer">');
    expect(html).not.toContain("probe-agent");
  });

  test("the status tabs read the whole store, not the filtered rows", async () => {
    // The fixture ends at 3 drafts, 1 approved, 1 applied, 1 rejected: the statuses were moved
    // through the store above, so these are hand-counted literals, not a re-derivation.
    const html = await (await env.get("/?status=all")).text();
    for (const [value, label, count] of [
      ["draft", "Draft", 3],
      ["approved", "Approved", 1],
      ["applied", "Applied", 1],
      ["rejected", "Rejected", 1],
    ] as const) {
      expect(html).toContain(
        `<button class="tab" type="submit" name="status" value="${value}"><span>${label}</span><span class="tab-badge num">${count}</span></button>`,
      );
    }

    // A filter matching one row leaves the tabs on the store's totals.
    const filtered = await (await env.get("/?q=wording")).text();
    expect(filtered).toContain("Run bun install");
    expect(filtered).toContain('<button class="tab" type="submit" name="status" value="draft"><span>Draft</span><span class="tab-badge num">3</span></button>');
    expect(filtered).not.toContain("The cache lives at");
  });

  test("the sidebar badge counts the store's drafts", async () => {
    // The badge rides the shell, so it is store-wide whatever the URL filters.
    const all = await (await env.get("/?status=all")).text();
    expect(all).toContain('<span class="nav-badge" id="entries-badge">3</span>');
    const approved = await (await env.get("/?status=approved")).text();
    expect(approved).toContain('<span class="nav-badge" id="entries-badge">3</span>');
  });

  test("renders each entry's filed time as an absolute short stamp", async () => {
    const stamped = serveApp();
    try {
      const filed = fileEntries(stamped.store, "alpha", "probe-agent", [
        draft({ file: "docs/time.md", anchorText: "time", anchorHash: "h-time", fileHash: "f-time", agentDraft: "A note." }),
      ]);
      // A hand-set epoch makes the expected text a literal, not the format's own recomputation.
      stamped.store.db.run("UPDATE entries SET created_at = 0 WHERE id = ?", [filed.results[0]!.id]);
      const html = await (await stamped.get("/")).text();
      expect(html).toContain(">Filed</th>");
      expect(html).toContain(
        '<td class="cell-filed"><time class="num" datetime="1970-01-01T00:00:00.000Z">1970-01-01 00:00</time></td>',
      );
    } finally {
      stamped.close();
    }
  });

  test("adds a per-project select-all and ships the approve button disabled until a box is checked", async () => {
    // `status=all` so both projects render; the default Open view hides the terminal rows.
    const html = await (await env.get("/?status=all")).text();

    // One select-all per project table (2), labelled by the project, and it never carries `name`,
    // so it is not submitted as an entry id — the draft checkboxes alone post as `id`.
    expect(html.match(/data-select-all/g) ?? []).toHaveLength(2);
    expect(html).toContain('data-select-all="true" aria-label="Select all drafts in alpha"');
    expect(html).toContain('data-select-all="true" aria-label="Select all drafts in zeta"');
    expect(html).not.toContain('name="id" data-select-all');

    // Only draft rows carry a selectable checkbox: alpha holds two drafts and zeta one; the
    // applied and rejected rows in alpha carry none.
    expect(html.match(/type="checkbox" name="id"/g) ?? []).toHaveLength(3);

    // The approve button ships ENABLED so the no-JS form can fire it (an empty selection answers
    // the route's refusal); dashboard.js disables it at first paint and re-syncs it on selection.
    expect(html).toContain(
      'class="btn btn-fill btn-sm" type="submit" hx-disabled-elt="this">Approve selected</button>',
    );
    expect(html).not.toContain('hx-disabled-elt="this" disabled="">Approve selected</button>');
  });

  test("renders three icon action slots per status", async () => {
    // `status=all`: the applied and rejected fixture rows live in the hidden-by-default batch.
    const html = await (await env.get("/?status=all")).text();

    // Draft: approve and reject are enabled, edit is always a live link.
    const draftId = batchA.results[0]!.id;
    const draftActions = entryActions(html, draftId);
    expect(draftActions).toContain('aria-label="Approve docs/setup.md"');
    expect(draftActions).toContain(`aria-label="Approve docs/setup.md" hx-post="/entries/${draftId}/approve"`);
    expect(draftActions).toContain('aria-label="Reject docs/setup.md"');
    expect(draftActions).toContain(`aria-label="Reject docs/setup.md" hx-post="/entries/${draftId}/reject"`);
    expect(draftActions).toContain('aria-label="Edit docs/setup.md"');
    expect(draftActions).toContain(`href="/entries/${draftId}"`);

    // Approved: approve is disabled, reject enabled, edit present.
    const approvedId = batchA.results[1]!.id;
    const approvedActions = entryActions(html, approvedId);
    expect(approvedActions).toContain('aria-label="Approve docs/cache.md"');
    expect(approvedActions).toContain('aria-label="Approve docs/cache.md" disabled');
    expect(approvedActions).not.toContain(`hx-post="/entries/${approvedId}/approve"`);
    expect(approvedActions).toContain(`aria-label="Reject docs/cache.md" hx-post="/entries/${approvedId}/reject"`);
    expect(approvedActions).toContain(`href="/entries/${approvedId}"`);

    // Applied and rejected: approve and reject are both disabled; edit stays.
    for (const [id, file] of [
      [batchB.results[0]!.id, "LICENSE.md"],
      [batchB.results[1]!.id, "README.md"],
    ] as const) {
      const actions = entryActions(html, id);
      expect(actions).toContain(`aria-label="Approve ${file}"`);
      expect(actions).toContain(`aria-label="Approve ${file}" disabled`);
      expect(actions).toContain(`aria-label="Reject ${file}"`);
      expect(actions).toContain(`aria-label="Reject ${file}" disabled`);
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
    expect(html).toContain('<span class="pagination-count num">1 of 6 entries</span>');
    // The tab strip marks the active filter.
    expect(html).toContain('<button class="tab active" type="submit" name="status" value="rejected" aria-current="true">');
  });

  test("the default view shows only active entries and reads as the success state", async () => {
    const html = await (await env.get("/")).text();

    // Draft and approved rows show; the applied and rejected batch is hidden.
    expect(html).toContain("Run bun install");
    expect(html).toContain("The cache lives at");
    expect(html).toContain("Run the migration");
    expect(html).toContain("Frequently asked");
    expect(html).not.toContain("AGPL-3.0");
    expect(html).not.toContain("shields badge");
    // The default is not a filter: no partial header, and the Open tab leads.
    expect(html).not.toContain("Showing ");
    expect(html).toContain('<button class="tab active" type="submit" name="status" value="" aria-current="true">');
    // The all-statuses view stays reachable through its URL value, showing the terminal rows the
    // Open view hides.
    const all = await (await env.get("/?status=all")).text();
    expect(all).toContain("AGPL-3.0");

    // An explicit empty status param is the default too. The positive leg pins that it is the
    // default, not an unknown-status no-match: the draft row still renders.
    const empty = await (await env.get("/?status=")).text();
    expect(empty).toContain("Run bun install");
    expect(empty).not.toContain("AGPL-3.0");
    expect(empty).not.toContain("Showing ");
  });

  test("status=all shows every status and leaves no tab current", async () => {
    const html = await (await env.get("/?status=all")).text();

    expect(html).toContain("AGPL-3.0");
    expect(html).toContain("shields badge");
    // `all` is a URL value the tabs never offer, so no tab marks itself current under it.
    expect(html).not.toContain('class="tab active"');
    // An explicit all-statuses filter matches the whole store, so no partial header either.
    expect(html).not.toContain("Showing ");
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
    expect(html).toContain('<span class="pagination-count num">1 of 6 entries</span>');
  });

  test("the count line reads the strict subset, and the full set under a filter that matches everything", async () => {
    // q=docs matches 4 of the 6 entries.
    const partial = await (await env.get("/?q=docs")).text();
    expect(partial).toContain('<span class="pagination-count num">4 of 6 entries</span>');
    expect(partial).toContain("Clear filters");
    expect(partial).toContain("Run bun install");
    expect(partial).not.toContain("AGPL-3.0");
    expect(partial).toContain('value="docs"');

    // A filter matching everything is the full count, not a subset. `status=all` makes the
    // comparison explicit: the default Open view would legitimately hide the terminal rows.
    const full = await (await env.get("/?q=the&status=all")).text();
    expect(full).toContain('<span class="pagination-count num">6 of 6 entries</span>');
    expect(full).toContain("AGPL-3.0");
    expect(full).toContain("Frequently asked");

    // No filters is the full count of the Open view too.
    const plain = await (await env.get("/")).text();
    expect(plain).toContain('<span class="pagination-count num">4 of 6 entries</span>');
  });

  test("a filter that cannot match shows the no-match state with a way back", async () => {
    for (const query of ["?q=zzz", "?status=bogus", "?project=nope"]) {
      const html = await (await env.get(query)).text();
      expect(html).toContain("No entries match");
      expect(html).toContain('<a href="/" class="btn btn-secondary btn-sm">Clear filters</a>');
      expect(html).not.toContain("entry-head");
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
      expect(html).not.toContain("entry-head");
      // Zero entries at all reads as "no entries yet" even under a filter: nothing exists to filter.
      const filtered = await (await fresh.get("/?q=zzz&status=draft")).text();
      expect(filtered).toContain("No entries yet");
    } finally {
      fresh.close();
    }
  });

  test("a store with only applied and rejected entries reads as nothing to review", async () => {
    const done = serveApp();
    try {
      const batch = fileEntries(done.store, "alpha", "probe-agent", [
        draft({ file: "docs/a.md", anchorText: "a", anchorHash: "hd", fileHash: "fd", agentDraft: "A note." }),
      ]);
      done.store.db.run("UPDATE entries SET status = 'applied' WHERE id = ?", [batch.results[0]!.id]);
      const html = await (await done.get("/")).text();
      expect(html).toContain("Nothing to review");
      expect(html).not.toContain("entry-head");
      // No filters are active, so the filter-miss escape hatch does not show either.
      expect(html).not.toContain("Clear filters");
      // The explicit all-statuses view still shows the row.
      const all = await (await done.get("/?status=all")).text();
      expect(all).toContain(`class="entry-link truncate" href="/entries/${batch.results[0]!.id}">a</a>`);
      // A search matching only terminal rows names the hiding view and offers the way onward
      // (hono JSX escapes the href's ampersands).
      const searched = await (await done.get("/?q=a")).text();
      expect(searched).toContain("No entries match");
      expect(searched).toContain("Applied and rejected entries are hidden from this view.");
      expect(searched).toContain('href="/?q=a&amp;project=&amp;status=all"');
      // A search that matches nothing keeps the plain filter-miss state.
      const missed = await (await done.get("/?q=zzz")).text();
      expect(missed).toContain("No entries match");
      expect(missed).not.toContain("hidden from this view");
    } finally {
      done.close();
    }
  });

  test("answers a list fragment to htmx requests", async () => {
    const res = await env.get("/?q=wording", { "HX-Request": "true" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Run bun install");
    expect(html).toContain('<span class="pagination-count num">1 of 6 entries</span>');
    // A fragment is the list region plus the out-of-band shell pieces, never the page shell.
    expect(html).not.toContain("<!doctype html>");
    expect(html).not.toContain('id="filters"');
    expect(html).not.toContain('class="sidebar"');
    expect(html).not.toContain("<main");
    // The tabs, the header meta, the badge, and the banner sit outside the main swap target, so
    // the fragment replaces them out of band rather than leaving them stale.
    expect(html).toContain('<span class="nav-badge" id="entries-badge" hx-swap-oob="true">3</span>');
    expect(html).toContain('<div id="page-banner" hx-swap-oob="true"></div>');
    expect(html).toContain('<div class="tabs-wrap status-tabs" id="status-tabs" hx-swap-oob="true">');
    expect(html).toContain('<button class="tab" type="submit" name="status" value="draft"><span>Draft</span><span class="tab-badge num">3</span></button>');
  });

  test("a titled row keeps its anchor text reachable, and never as a title attribute", async () => {
    const titled = serveApp();
    try {
      const batch = fileEntries(titled.store, "alpha", "probe-agent", [
        draft({ file: "docs/a.md", title: "Setup wording", anchorText: "Run bun install", anchorHash: "ht", fileHash: "ft" }),
        draft({ file: "docs/b.md", anchorText: "Plain anchor", anchorHash: "hu", fileHash: "fu" }),
      ]);
      const html = await (await titled.get("/?status=draft")).text();

      // The titled row displays the title alone as its link, so its anchor rides an sr-only span
      // in the cell.
      expect(html).toContain(`<a class="entry-link truncate" href="/entries/${batch.results[0]!.id}">Setup wording</a>`);
      expect(html).toContain('<span class="sr-only">Run bun install</span>');
      // A row whose title IS the anchor does not repeat it.
      expect(html).not.toContain('<span class="sr-only">Plain anchor</span>');
      // The removed tooltip stays removed.
      expect(html).not.toContain('title="docs/a.md — Run bun install"');
    } finally {
      titled.close();
    }
  });

  test("keeps the failed-filter copy and the retry wiring in the client module", async () => {
    // The error box is client-side copy now, and the module ships as a static file with no DOM
    // harness, so its shipped bytes are the honest seam for the copy and the retry wiring.
    const js = await Bun.file(
      new URL("../../src/dashboard/static/dashboard.js", import.meta.url),
    ).text();
    expect(js).toContain("The list could not be loaded");
    expect(js).toContain("The filter request failed. Try it again.");
    expect(js).toContain("wireRetry");
    expect(js).toContain('button.textContent = "Retry"');
    // The failure announces through the shipped toast, the system's own transient surface.
    expect(js).toContain('import { initDismiss, initScrollFade, initTables, initTabs, initViewportWidth, showToast } from "./ui.js";');
    // The enhanced filter path owns the status through the hidden field alone.
    expect(js).toContain('removeAttribute("name")');
    expect(js).toContain('showToast("danger"');
    expect(js).toContain("htmx:responseError");
    expect(js).toContain("htmx:sendError");
  });

  test("re-wires a banner's dismiss after every htmx swap", async () => {
    // String-level pin only: the suite has no DOM harness, so the wiring is covered by its hooks.
    // ui.js's one dismiss sweep runs at boot; a banner the fragment replaces out of band arrives
    // unwired without this listener.
    const js = await Bun.file(
      new URL("../../src/dashboard/static/dashboard.js", import.meta.url),
    ).text();
    expect(js).toContain('document.addEventListener("htmx:afterSwap", initDismiss)');
    expect(js).toContain('document.addEventListener("htmx:afterSwap", initTables)');
    // The disclosure state machine left with the disclosures.
    expect(js).not.toContain("data-collapse-key");
    expect(js).not.toContain("reviewzy.list-collapsed");
  });

  test("serves static assets with the pinned vendor versions", async () => {
    const tokens = await env.get("/static/tokens.css");
    expect(tokens.status).toBe(200);
    expect(tokens.headers.get("content-type")).toContain("text/css");
    expect(await tokens.text()).toContain("design tokens");

    const components = await env.get("/static/components.css");
    expect(components.status).toBe(200);
    expect(await components.text()).toContain("component styles");

    const cursorCss = await env.get("/static/cursor.css");
    expect(cursorCss.status).toBe(200);
    expect(await cursorCss.text()).toContain("the ambient layer");

    const htmx = await env.get("/static/htmx.min.js");
    expect(htmx.status).toBe(200);
    expect(htmx.headers.get("content-type")).toContain("text/javascript");
    expect(await htmx.text()).toContain("htmx.org 2.0.10");

    const appJs = await env.get("/static/dashboard.js");
    expect(appJs.status).toBe(200);
    const appJsText = await appJs.text();
    expect(appJsText).toContain("htmx:responseError");
    expect(appJsText).toContain("htmx:sendError");

    // The controller modules and the icon sprite are vendored beside the stylesheets.
    for (const file of ["cursor.js", "cursor-rules.js", "ui.js", "icons.svg"]) {
      expect((await env.get(`/static/${file}`)).status, file).toBe(200);
    }

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
      expect(html.match(/class="entry-head"/g) ?? []).toHaveLength(201);
      const page2Text = page2.rows[0]!.anchor_text;
      expect(page2Text).not.toBeNull();
      expect(html).toContain(page2Text!);

      // A filter matching exactly one page reports the walk's full count, not the page's.
      const filtered = await (await big.get("/?q=common")).text();
      expect(filtered).toContain('<span class="pagination-count num">200 of 201 entries</span>');
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

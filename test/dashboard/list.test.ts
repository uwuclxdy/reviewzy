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
    anchorText: "anchor",
    anchorBefore: "",
    anchorAfter: "",
    anchorHash: "h-anchor",
    fileHash: "f-file",
    agentDraft: "a draft",
    contextJson: "{}",
    constraintsJson: "{}",
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
// A second filer in batchB makes it a mixed-filer batch: the header counts filers, each row names its own.
env.store.db.run("UPDATE entries SET filed_by = 'other-agent' WHERE id = ?", [batchB.results[0]!.id]);

/** The rendered text of each fixture entry (human_text wins over agent_draft), keyed by entry id. */
const RENDERED: { batchId: string; id: string; text: string }[] = [
  { batchId: batchA.batchId, id: batchA.results[0]!.id, text: "Fix the wording of the setup section." },
  { batchId: batchA.batchId, id: batchA.results[1]!.id, text: "Explain where the cache lives." },
  { batchId: batchB.batchId, id: batchB.results[0]!.id, text: "Note the license." },
  { batchId: batchB.batchId, id: batchB.results[1]!.id, text: "Add a status badge to the README." },
  { batchId: batchC.batchId, id: batchC.results[0]!.id, text: "Describe the migration." },
  { batchId: batchD.batchId, id: batchD.results[0]!.id, text: "Update the FAQ." },
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

/** The `.batch-header` region for a batch, from its header div to the table that follows. */
function batchHeader(html: string, batchId: string): string {
  const idMark = html.indexOf(`class="batch-id" title="${batchId}"`);
  expect(idMark, `batch ${batchId} header rendered`).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<div class="batch-header">', idMark);
  const end = html.indexOf('<div class="table-wrap">', idMark);
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

    // Page header triplet.
    expect(html).toContain("Review queue");
    expect(html).toContain("<h1 class=\"page-title\">Entries</h1>");

    // The filter form: native GET for no-JS, htmx for the fragment swap.
    expect(html).toContain('<form id="filters" method="get" action="/"');
    expect(html).toContain('hx-get="/"');
    expect(html).toContain('hx-target="#entries-list"');
    expect(html).toContain('hx-swap="innerHTML"');
    expect(html).toContain('hx-indicator="#entries-loading"');
    expect(html).toContain('name="q"');
    expect(html).toContain('name="status"');
    expect(html).toContain('name="project"');
    expect(html).toContain(">Apply filters</button>");

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

  test("lists entries grouped by project then batch, ordered by id", async () => {
    const html = await (await env.get("/")).text();

    // Projects in slug order; each project header carries its entry count.
    expect(html.indexOf('<h2 class="project-name">alpha</h2>')).toBeLessThan(
      html.indexOf('<h2 class="project-name">zeta</h2>'),
    );
    expect(html).toContain(">5 entries</span>");
    expect(html).toContain(">1 entry</span>");

    // Batches in ascending batch_id order: alpha's three batches first, then zeta's.
    const pageBatchOrder = [...[batchA.batchId, batchB.batchId, batchC.batchId].sort(), batchD.batchId];
    const textsByBatch = new Map<string, { id: string; text: string }[]>();
    for (const item of RENDERED) {
      textsByBatch.set(item.batchId, [...(textsByBatch.get(item.batchId) ?? []), { id: item.id, text: item.text }]);
    }
    pageBatchOrder.forEach((batchId, i) => {
      const start = html.indexOf(`class="batch-id" title="${batchId}"`);
      expect(start, `batch ${batchId} rendered in batch order`).toBeGreaterThan(-1);
      const end = i + 1 < pageBatchOrder.length ? html.indexOf(`class="batch-id" title="${pageBatchOrder[i + 1]!}"`) : html.length;
      const texts = textsByBatch
        .get(batchId)!
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((t) => t.text);
      expectOrder(html.slice(start, end), texts);
    });

    // A row carries the select checkbox, the basename-prefixed proposed text, the status tag, and actions.
    expect(html).toContain(">Select</th>");
    expect(html).toContain(">Text</th>");
    expect(html).toContain(">Status</th>");
    expect(html).toContain(">Actions</th>");
    expect(html).toContain('class="tag tag-warning"><span class="tag-dot"></span>Draft</span>');
    expect(html).toContain('class="tag tag-success"><span class="tag-dot"></span>Approved</span>');
    expect(html).toContain('class="tag tag-info"><span class="tag-dot"></span>Applied</span>');
    expect(html).toContain('class="tag tag-danger"><span class="tag-dot"></span>Rejected</span>');
    // The prose is prefixed with the file basename, and the cell title carries the full path and anchor.
    expect(html).toContain('<span class="entry-file">setup.md</span>');
    expect(html).toContain('title="docs/setup.md — Run bun install"');
  });

  test("batch header shows the filer, shortened id, and constraint count", async () => {
    const html = await (await env.get("/")).text();

    // A single-filer batch names that filer once in its header; batchA and batchD are both
    // probe-agent alone, so each of their headers carries the name exactly once.
    expect(batchHeader(html, batchA.batchId).match(/probe-agent/g) ?? []).toHaveLength(1);
    expect(batchHeader(html, batchD.batchId).match(/probe-agent/g) ?? []).toHaveLength(1);
    // An all-null batch shows no filer slot at all.
    const cHeader = batchHeader(html, batchC.batchId);
    expect(cHeader).not.toContain("filer");
    expect(cHeader).not.toContain("probe-agent");

    // The full ulid stays in the title; the visible text is head+tail joined by an ellipsis.
    const shortA = `${batchA.batchId.slice(0, 6)}…${batchA.batchId.slice(-6)}`;
    expect(html).toContain(`class="batch-id" title="${batchA.batchId}">${shortA}</span>`);

    // Constraint count appears only when non-zero: batchA has one constrained entry, batchB two.
    expect(html).toContain('<span class="batch-meta">1 with constraints</span>');
    expect(html).toContain('<span class="batch-meta">2 with constraints</span>');
    expect(cHeader).not.toContain("constraint");
  });

  test("a mixed-filer batch names neither in the header and labels each row inline", async () => {
    const html = await (await env.get("/")).text();

    // batchB holds two filers (probe-agent and other-agent): the header names neither, only the count.
    const bHeader = batchHeader(html, batchB.batchId);
    expect(bHeader).toContain('<span class="batch-meta">2 filers</span>');
    expect(bHeader).not.toContain("probe-agent");
    expect(bHeader).not.toContain("other-agent");

    // Each row names its own filer inline beside the file basename.
    expect(html).toContain('<span class="entry-filer"> · other-agent</span>');
    expect(html).toContain('<span class="entry-filer"> · probe-agent</span>');
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

  test("filters by search text over the same columns as the mcp tool", async () => {
    // agent_draft
    const byDraft = await (await env.get("/?q=wording")).text();
    expect(byDraft).toContain("Fix the wording of the setup section.");
    expect(byDraft).not.toContain("Explain where the cache lives.");
    // file, case-insensitive
    const byFile = await (await env.get("/?q=CACHE")).text();
    expect(byFile).toContain("Explain where the cache lives.");
    expect(byFile).not.toContain("Fix the wording");
    // anchor_text
    const byAnchor = await (await env.get("/?q=bun+install")).text();
    expect(byAnchor).toContain("Fix the wording of the setup section.");
    expect(byAnchor).not.toContain("Note the license.");
    // human_text
    const byHuman = await (await env.get("/?q=where+the+cache")).text();
    expect(byHuman).toContain("Explain where the cache lives.");
    expect(byHuman).not.toContain("Fix the wording");
  });

  test("filters by status", async () => {
    const html = await (await env.get("/?status=rejected")).text();
    expect(html).toContain("Add a status badge to the README.");
    expect(html).not.toContain("Fix the wording");
    expect(html).toContain("Showing 1 of 6 entries");
    // The select reflects the active filter.
    expect(html).toContain('<option value="rejected" selected="">Rejected</option>');
  });

  test("filters by project", async () => {
    const html = await (await env.get("/?project=zeta")).text();
    expect(html).toContain("Update the FAQ.");
    expect(html).not.toContain("Fix the wording");
    expect(html).not.toContain('<h2 class="project-name">alpha</h2>');
    expect(html).toContain('<option value="zeta" selected="">zeta</option>');
  });

  test("combines filters", async () => {
    const html = await (await env.get("/?q=setup&status=draft&project=alpha")).text();
    expect(html).toContain("Fix the wording of the setup section.");
    expect(html).not.toContain("Explain where the cache lives.");
    expect(html).toContain("Showing 1 of 6 entries");
  });

  test("shows the partial header only for a strict subset", async () => {
    // q=docs matches 4 of the 6 entries.
    const partial = await (await env.get("/?q=docs")).text();
    expect(partial).toContain("Showing 4 of 6 entries");
    expect(partial).toContain("Clear filters");
    expect(partial).toContain("Fix the wording of the setup section.");
    expect(partial).not.toContain("Note the license.");
    expect(partial).toContain('value="docs"');

    // A filter matching everything is the success state, not partial.
    const full = await (await env.get("/?q=the")).text();
    expect(full).not.toContain("Showing ");
    expect(full).toContain("Note the license.");
    expect(full).toContain("Update the FAQ.");

    // No filters is the success state too.
    const plain = await (await env.get("/")).text();
    expect(plain).not.toContain("Showing ");
  });

  test("a filter that cannot match shows the no-match state with a way back", async () => {
    for (const query of ["?q=zzz", "?status=bogus", "?project=nope"]) {
      const html = await (await env.get(query)).text();
      expect(html).toContain("No entries match");
      expect(html).toContain('<a href="/" class="btn btn-secondary btn-sm">Clear filters</a>');
      expect(html).not.toContain("entry-text");
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
      expect(html).not.toContain("entry-text");
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
    expect(html).toContain("Fix the wording of the setup section.");
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
        }),
      ]);
      const html = await (await xs.get("/")).text();
      expect(html).not.toContain('<script>alert("xss")</script>');
      expect(html).not.toContain('<img src=x');
      expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
      expect(html).toContain("&lt;img src=x");
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
      expect(html.match(/class="cell-text"/g) ?? []).toHaveLength(201);
      const page2Text = page2.rows[0]!.agent_draft;
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
    expect(html).toContain("Fix the wording of the setup section.");
    expect(html).toContain("Update the FAQ.");
    expect(html).not.toContain("Showing ");
  });
});

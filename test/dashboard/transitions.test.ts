import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { loadConfig } from "../../src/config.ts";
import { createApp } from "../../src/daemon/app.ts";
import { originGate } from "../../src/daemon/origin.ts";
import { fileEntries } from "../../src/db/queries.ts";
import type { NewEntry } from "../../src/db/queries.ts";
import { openStore } from "../../src/db/store.ts";
import type { Store } from "../../src/db/store.ts";
import { mountMcp } from "../../src/mcp/route.ts";

const tempDirs: string[] = [];

/** One app with its own temp-file store per test, since transitions mutate state. */
function openEnv() {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-transitions-"));
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
  anchorText: "Run bun install",
  anchorBefore: "Run this before anything else.",
  anchorAfter: "Then run the tests.",
  anchorHash: "h-transitions",
  fileHash: "f-transitions",
  agentDraft: "Fix the wording of the setup section.",
  contextJson: JSON.stringify({ where: "setup docs" }),
  constraintsJson: "{}",
};

function draftEntry(over: Partial<NewEntry> = {}): NewEntry {
  return { ...FIXTURE, ...over };
}

function envWithDraft(over: Partial<NewEntry> = {}) {
  const env = openEnv();
  const batch = fileEntries(env.store, "alpha", "probe-agent", [draftEntry(over)]);
  return { env, id: batch.results[0]!.id };
}

/** `n` drafts, each with its own file and anchor so a filtered fragment is distinguishable. */
function envWithDrafts(n: number) {
  const env = openEnv();
  const entries = Array.from({ length: n }, (_, i) =>
    draftEntry({ anchorHash: `h-${i}`, anchorText: `anchor ${i}`, file: `file-${i}.md` }),
  );
  const batch = fileEntries(env.store, "alpha", "probe-agent", entries);
  return { env, ids: batch.results.map((r) => r.id) };
}

/** The editor test's own htmx header, so a POST is distinguishable from a plain navigation. */
const HX = { "HX-Request": "true" };

/** A form carrying the editor marker, the way the editor's own buttons submit. */
function editorForm(): FormData {
  const form = new FormData();
  form.set("view", "editor");
  return form;
}

function statusOf(store: Store, id: string): string {
  return (store.db.query("SELECT status FROM entries WHERE id = ?").get(id) as { status: string }).status;
}

function humanTextOf(store: Store, id: string): string | null {
  return (store.db.query("SELECT human_text FROM entries WHERE id = ?").get(id) as { human_text: string | null })
    .human_text;
}

describe("list transitions", () => {
  test("approving a draft swaps in the list fragment with the row approved", async () => {
    const { env, id } = envWithDraft();
    const res = await env.post(`/entries/${id}/approve`, new FormData(), HX);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).not.toContain("<!doctype html>");
    expect(html).toContain("Approved");
    expect(html).not.toContain('role="alert"');
    expect(statusOf(env.store, id)).toBe("approved");
    expect(humanTextOf(env.store, id)).toBe("Fix the wording of the setup section.");
    // The approve slot stays occupied by a disabled button, so a double-click's second click
    // cannot land on the Reject button that would otherwise shift into the slot; the row keeps
    // its reject action and loses the checkbox.
    expect(html).toContain('<button type="button" class="btn btn-icon" style="color: var(--success)" aria-label="Approve docs/setup.md" title="Approve" disabled="">');
    expect(html).toContain(`hx-post="/entries/${id}/reject"`);
    expect(html).not.toContain(`hx-post="/entries/${id}/approve"`);
    expect(html).not.toContain(`value="${id}"`);
    env.close();
  });

  test("rejecting a draft swaps in the list fragment with the row rejected", async () => {
    const { env, id } = envWithDraft();
    const res = await env.post(`/entries/${id}/reject`, new FormData(), HX);
    const html = await res.text();

    expect(html).toContain("Rejected");
    expect(html).not.toContain('role="alert"');
    expect(statusOf(env.store, id)).toBe("rejected");
    env.close();
  });

  test("approving an already approved entry refuses inline, naming the status and the fix", async () => {
    const { env, id } = envWithDraft();
    env.store.db.run("UPDATE entries SET status = 'approved', human_text = 'the prose' WHERE id = ?", [id]);
    const res = await env.post(`/entries/${id}/approve`, new FormData(), HX);
    const html = await res.text();

    expect(html).toContain('role="alert"');
    expect(html).toContain("Entry not approved");
    expect(html).toContain("already approved");
    expect(html).toContain("Open the editor to revise its text.");
    env.close();
  });

  test("rejecting an applied entry refuses, naming the status and the way back", async () => {
    const { env, id } = envWithDraft();
    env.store.db.run("UPDATE entries SET status = 'applied' WHERE id = ?", [id]);
    const res = await env.post(`/entries/${id}/reject`, new FormData(), HX);
    const html = await res.text();

    expect(html).toContain('role="alert"');
    expect(html).toContain("Entry not rejected");
    expect(html).toContain("already applied");
    // hono JSX escapes the apostrophe; the copy itself carries it.
    expect(html).toContain("can&#39;t be rejected");
    env.close();
  });

  test("the row actions carry the active filters into the re-render", async () => {
    const { env, ids } = envWithDrafts(2);
    const form = new FormData();
    form.set("status", "draft");
    const res = await env.post(`/entries/${ids[0]!}/approve`, form, HX);
    const html = await res.text();

    // The approved row leaves the draft filter; the fragment re-renders the region under it,
    // keeps the filter alive for the next action, and shows the partial count.
    expect(html).toContain("Showing 1 of 2 entries");
    // hono self-closes the void input; the attribute pair is the load-bearing part.
    expect(html).toContain('name="status" value="draft"');
    expect(html).not.toContain("file-0.md");
    expect(html).toContain("file-1.md");
    // The remaining draft's row still offers its approve action; the approved row's does not.
    expect(html).toContain(`hx-post="/entries/${ids[1]!}/approve"`);
    expect(html).not.toContain(`hx-post="/entries/${ids[0]!}/approve"`);
    env.close();
  });

  test("the list region wraps rows in one batch form with hidden filters", async () => {
    const { env, ids } = envWithDrafts(2);
    const html = await (await env.get("/")).text();

    expect(html).toContain('<form id="batch-form"');
    expect(html).toContain('hx-post="/batch-approve"');
    expect(html).toContain('hx-target="#entries-list"');
    expect(html).toContain('>Approve selected</button>');
    // Every repeat-activation guard rides the exact button it disables: the batch submit and both
    // row actions (a page-level presence check would let one button lose its guard silently).
    expect(html).toContain('<button class="btn btn-primary btn-sm" type="submit" hx-disabled-elt="this">');
    expect(html).toContain(
      `<button type="button" class="btn btn-icon" style="color: var(--success)" aria-label="Approve file-0.md" title="Approve" hx-post="/entries/${ids[0]!}/approve" hx-target="#entries-list" hx-swap="innerHTML" hx-indicator="#entries-loading" hx-disabled-elt="this">`,
    );
    expect(html).toContain(
      `<button type="button" class="btn btn-icon" style="color: var(--danger)" aria-label="Reject file-0.md" title="Reject" hx-post="/entries/${ids[0]!}/reject" hx-target="#entries-list" hx-swap="innerHTML" hx-indicator="#entries-loading" hx-disabled-elt="this">`,
    );
    expect(html).toContain('name="q" value=""');
    expect(html).toContain('name="status" value=""');
    expect(html).toContain('name="project" value=""');
    // Draft rows carry a checkbox and both transitions; the Edit link rides along in the actions cell.
    expect(html).toContain(`<input type="checkbox" name="id" value="${ids[0]!}"`);
    expect(html).toContain(`hx-post="/entries/${ids[0]!}/approve"`);
    expect(html).toContain(`hx-post="/entries/${ids[0]!}/reject"`);
    expect(html).toContain(`href="/entries/${ids[0]!}"`);
    expect(html).toContain("<th>Actions</th>");
    env.close();
  });

  test("applied and rejected rows offer no transitions and no checkbox", async () => {
    const { env, id } = envWithDraft();
    env.store.db.run("UPDATE entries SET status = 'applied' WHERE id = ?", [id]);
    const html = await (await env.get("/")).text();

    expect(html).toContain(`href="/entries/${id}"`);
    expect(html).not.toContain(`hx-post="/entries/${id}/approve"`);
    expect(html).not.toContain(`hx-post="/entries/${id}/reject"`);
    expect(html).not.toContain(`value="${id}"`);
    env.close();
  });
});

describe("batch approve", () => {
  test("approves every selected draft and reports the count", async () => {
    const { env, ids } = envWithDrafts(2);
    const form = new FormData();
    // append, not set: a checkbox list posts one id per checkbox, and set would replace the first.
    form.append("id", ids[0]!);
    form.append("id", ids[1]!);
    const res = await env.post("/batch-approve", form, HX);
    const html = await res.text();

    expect(html).toContain('role="status"');
    expect(html).toContain("Approved 2 entries");
    expect(html).not.toContain('role="alert"');
    expect(statusOf(env.store, ids[0]!)).toBe("approved");
    expect(statusOf(env.store, ids[1]!)).toBe("approved");
    env.close();
  });

  test("reports refusals per entry, naming each status", async () => {
    const { env, ids } = envWithDrafts(3);
    env.store.db.run("UPDATE entries SET status = 'approved', human_text = 'x' WHERE id = ?", [ids[1]!]);
    env.store.db.run("UPDATE entries SET status = 'applied' WHERE id = ?", [ids[2]!]);
    const form = new FormData();
    for (const id of ids) form.append("id", id);
    const res = await env.post("/batch-approve", form, HX);
    const html = await res.text();

    expect(html).toContain('role="alert"');
    expect(html).toContain("Approved 1 of 3 entries");
    expect(html).toContain("file-1.md is already approved");
    expect(html).toContain("file-2.md is already applied");
    expect(statusOf(env.store, ids[0]!)).toBe("approved");
    expect(statusOf(env.store, ids[1]!)).toBe("approved");
    expect(statusOf(env.store, ids[2]!)).toBe("applied");
    env.close();
  });

  test("zero selection is refused with a message, never a silent no-op", async () => {
    const { env } = envWithDraft();
    const res = await env.post("/batch-approve", new FormData(), HX);
    const html = await res.text();

    expect(html).toContain('role="alert"');
    expect(html).toContain("Nothing to approve");
    expect(html).toContain("Select at least one entry, then approve again.");
    env.close();
  });
});

describe("the diff view", () => {
  test("renders the anchored snippet and the proposed text, both escaped", async () => {
    const { env, id } = envWithDraft({
      anchorBefore: "<script>before</script>",
      anchorText: "<script>anchor</script>",
      anchorAfter: "<script>after</script>",
      agentDraft: "<script>draft</script>",
    });
    const html = await (await env.get(`/entries/${id}`)).text();

    expect(html).toContain('<div class="card-title">Before</div>');
    expect(html).toContain('<div class="card-title">After</div>');
    expect(html).toContain("&lt;script&gt;before&lt;/script&gt;");
    expect(html).toContain("&lt;script&gt;anchor&lt;/script&gt;");
    expect(html).toContain("&lt;script&gt;after&lt;/script&gt;");
    expect(html).toContain("&lt;script&gt;draft&lt;/script&gt;");
    expect(html).not.toContain("<script>before</script>");
    expect(html).not.toContain("<script>anchor</script>");
    expect(html).not.toContain("<script>draft</script>");
    // The anchor line is the visually distinct one.
    expect(html).toContain("diff-anchor");
    env.close();
  });

  test("shows the human text as the after side once approved", async () => {
    const { env, id } = envWithDraft();
    env.store.db.run("UPDATE entries SET status = 'approved', human_text = 'the human text', agent_draft = NULL WHERE id = ?", [id]);
    const html = await (await env.get(`/entries/${id}`)).text();

    expect(html).toContain('<div class="card-title">After</div>');
    expect(html).toContain("the human text");
    expect(html).toContain("diff-anchor");
    env.close();
  });

  test("omits the diff when there is no text to show", async () => {
    const { env, id } = envWithDraft();
    env.store.db.run("UPDATE entries SET agent_draft = NULL, human_text = NULL WHERE id = ?", [id]);
    const html = await (await env.get(`/entries/${id}`)).text();

    expect(html).not.toContain('<div class="card-title">Before</div>');
    expect(html).not.toContain("diff-anchor");
    env.close();
  });
});

describe("editor transitions", () => {
  test("the editor page wires approve, reject, and the loading indicator", async () => {
    const { env, id } = envWithDraft();
    const html = await (await env.get(`/entries/${id}`)).text();

    expect(html).toContain(`hx-post="/entries/${id}/approve"`);
    expect(html).toContain(`hx-post="/entries/${id}/reject"`);
    expect(html).toContain('hx-target="#editor-region"');
    expect(html).toContain(">Approve draft</button>");
    expect(html).toContain(">Reject</button>");
    expect(html).toContain('id="editor-action-loading"');
    expect(html).toContain("Updating entry");
    // In-flight double-clicks and keyboard repeats are dropped by the disabled attribute on the
    // exact button that fires, not just somewhere on the page.
    expect(html).toContain(
      `<button type="button" class="btn btn-secondary" hx-post="/entries/${id}/approve" hx-target="#editor-region" hx-swap="outerHTML" hx-indicator="#editor-action-loading" hx-disabled-elt="this">`,
    );
    expect(html).toContain(
      `<button type="button" class="btn btn-danger" hx-post="/entries/${id}/reject" hx-target="#editor-region" hx-swap="outerHTML" hx-indicator="#editor-action-loading" hx-disabled-elt="this">`,
    );
    env.close();
  });

  test("approving a draft from the editor swaps in the approved region", async () => {
    const { env, id } = envWithDraft();
    const res = await env.post(`/entries/${id}/approve`, editorForm(), HX);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).not.toContain("<!doctype html>");
    expect(html).toContain("Approved");
    expect(html).not.toContain('role="alert"');
    expect(statusOf(env.store, id)).toBe("approved");
    expect(humanTextOf(env.store, id)).toBe("Fix the wording of the setup section.");
    // Same slot-occupancy guard as the list row: the disabled placeholder blocks a stray
    // double-click from reaching the Reject button in the swapped region.
    expect(html).toContain("<button type=\"button\" class=\"btn btn-secondary\" disabled=\"\">");
    expect(html).toContain(`hx-post="/entries/${id}/reject"`);
    expect(html).not.toContain(`hx-post="/entries/${id}/approve"`);
    env.close();
  });

  test("rejecting a draft or an approved entry from the editor swaps in the rejected region", async () => {
    for (const status of ["draft", "approved"]) {
      const { env, id } = envWithDraft();
      if (status === "approved") {
        env.store.db.run("UPDATE entries SET status = 'approved', human_text = 'x' WHERE id = ?", [id]);
      }
      const res = await env.post(`/entries/${id}/reject`, editorForm(), HX);
      const html = await res.text();

      expect(html).toContain("Rejected");
      expect(html).not.toContain('role="alert"');
      expect(statusOf(env.store, id)).toBe("rejected");
      env.close();
    }
  });

  test("approving an already approved entry from the editor refuses in the region", async () => {
    const { env, id } = envWithDraft();
    env.store.db.run("UPDATE entries SET status = 'approved', human_text = 'x' WHERE id = ?", [id]);
    const res = await env.post(`/entries/${id}/approve`, editorForm(), HX);
    const html = await res.text();

    expect(html).toContain('role="alert"');
    expect(html).toContain("Entry not approved");
    expect(html).toContain("already approved");
    env.close();
  });

  test("an applied entry's editor page offers no transitions", async () => {
    const { env, id } = envWithDraft();
    env.store.db.run("UPDATE entries SET status = 'applied' WHERE id = ?", [id]);
    const html = await (await env.get(`/entries/${id}`)).text();

    expect(html).not.toContain(">Approve draft</button>");
    expect(html).not.toContain(">Reject</button>");
    expect(html).toContain(">Save text</button>");
    env.close();
  });
});

describe("favicon", () => {
  test("the three page shells ship the favicon link so /favicon.ico stops 404ing", async () => {
    const { env, id } = envWithDraft();
    const list = await (await env.get("/")).text();
    const editor = await (await env.get(`/entries/${id}`)).text();
    const notFound = await (await env.get("/entries/does-not-exist")).text();

    for (const html of [list, editor, notFound]) {
      // hono self-closes the void link tag; the attribute pair is the load-bearing part.
      expect(html).toContain('<link rel="icon" href="data:,"');
    }
    env.close();
  });
});

describe("mcp-only integration pin", () => {
  test("with the dashboard unmounted, no mcp tool can move a draft to approved or rejected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewzy-mcp-only-"));
    tempDirs.push(dir);
    const config = loadConfig({ REVIEWZY_DB: join(dir, "reviewzy.db") });
    const store = openStore(config);
    const app = new Hono();
    app.use(originGate(config));
    mountMcp(app, config, store);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-method": "tools/call",
          "mcp-name": name,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name,
            arguments: args,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "reviewzy-pin", version: "0" },
            },
          },
        }),
      });
      return (await response.json()) as {
        result?: { structuredContent?: Record<string, unknown>; isError?: boolean };
      };
    };

    // Every tool against one fresh store, in the order an agent would drive them.
    const filed = await call("file_entries", {
      project: "pin",
      entries: [
        { repo: "https://example.com/repo.git", file: "src/a.ts", anchor_text: "first anchor", anchor_before: "before", anchor_after: "after", agent_draft: "draft a", file_content: "first anchor\n", context: {}, constraints: {} },
        { repo: "https://example.com/repo.git", file: "src/b.ts", anchor_text: "second anchor", anchor_before: "before", anchor_after: "after", agent_draft: "draft b", file_content: "second anchor\n", context: {}, constraints: {} },
      ],
    });
    const ids = ((filed.result?.structuredContent as { results: { id: string }[] }).results).map((r) => r.id);
    expect(ids).toHaveLength(2);

    // Successes carry no isError at all; the listing must show exactly the two filed drafts.
    const listed = await call("list_entries", {});
    expect(listed.result?.isError).toBeUndefined();
    expect((listed.result?.structuredContent as { entries: unknown[] }).entries).toHaveLength(2);
    // fetch_approved takes the project; nothing is approved, so no entries are fetched.
    const fetched = await call("fetch_approved", { project: "pin" });
    expect(fetched.result?.structuredContent).toMatchObject({ entries: [] });
    const waited = await call("await_approved", { ids, timeout_ms: 50 });
    expect(waited.result?.structuredContent).toMatchObject({ resolved: false });
    const marked = await call("mark_applied", { id: ids[0]!, result: "applied" });
    // The refusal matrix is untouched: a draft cannot be marked applied.
    expect(marked.result?.isError).toBe(true);

    // The aggregate pin: a whole mcp session against a fresh store never left a row's status.
    const rows = store.db.query("SELECT status FROM entries ORDER BY id").all() as { status: string }[];
    expect(rows).toEqual(ids.map(() => ({ status: "draft" })));

    void server.stop(true);
    store.close();
  });
});

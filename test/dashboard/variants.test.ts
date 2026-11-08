import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { createApp } from "../../src/daemon/app.ts";
import { openStore } from "../../src/db/store.ts";

/**
 * The dashboard's one-card-per-variant grouping: entries sharing project, file and a non-null
 * variant render as one card with labeled sub-blocks in ascending id order, each sub-block its own
 * anchor, proposal and status actions; approve and reject stay per sub-block. Entries with no
 * variant render exactly as the ungrouped rows always have, and the editor stays per-entry with a
 * variant chip beside the tag chip.
 *
 * The markup contract the assertions read: the group card carries `data-variant-group="<variant>"`,
 * each sub-block `data-variant-block="id"` — the classes and styling are the view's own.
 */

const REVISION = "2026-07-28";

const META = {
  "io.modelcontextprotocol/protocolVersion": REVISION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "reviewzy-probe", version: "0" },
};

const dir = mkdtempSync(join(tmpdir(), "reviewzy-dashboard-variants-"));
const config = loadConfig({ REVIEWZY_DB: join(dir, "reviewzy.db") });
const store = openStore(config);
const app = createApp(config, store);

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

type WireReply = {
  result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text: string }[] };
};

async function callTool(name: string, args: Record<string, unknown>): Promise<WireReply> {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-method": "tools/call",
      "mcp-name": name,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: META } }),
  });
  return (await response.json()) as WireReply;
}

/** Files one entry through the wire, with the optional variant and tag, and returns its id. */
async function fileEntry(project: string, anchor: string, variant: string | undefined, tag?: string): Promise<string> {
  const filed = await callTool("file_entries", {
    project,
    entries: [
      {
        repo: "https://example.com/org/repo.git",
        file: "src/app.ts",
        anchor_text: anchor,
        agent_draft: `Draft for ${anchor}`,
        file_hash: sha256(`${project}:${anchor}`),
        ...(variant === undefined ? {} : { variant }),
        ...(tag === undefined ? {} : { tag }),
      },
    ],
  });
  expect(filed.result?.isError).toBeUndefined();
  return ((filed.result?.structuredContent as { results: { id: string }[] }).results)[0]!.id;
}

const html = async (path: string) => await (await app.request(path)).text();
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("variant grouping on the list", () => {
  test("two entries sharing project, file and variant render as one card with two labeled sub-blocks", async () => {
    // One filing call mints all four ids in the same millisecond, where ascending id order and
    // filing order diverge on random bits (docs/gotchas.md): the order pin below binds on whichever
    // way the ulids land, not only on the fixture's own sequence.
    const filed = await callTool("file_entries", {
      project: "grouped",
      entries: [
        { repo: "https://example.com/org/repo.git", file: "src/app.ts", anchor_text: "Save changes", agent_draft: "Draft for Save changes", file_hash: sha256("grouped:Save changes"), variant: "--verbose" },
        { repo: "https://example.com/org/repo.git", file: "src/app.ts", anchor_text: "Discard", agent_draft: "Draft for Discard", file_hash: sha256("grouped:Discard"), variant: "--verbose" },
        { repo: "https://example.com/org/repo.git", file: "src/app.ts", anchor_text: "Export", agent_draft: "Draft for Export", file_hash: sha256("grouped:Export"), variant: "error: no git" },
        { repo: "https://example.com/org/repo.git", file: "src/app.ts", anchor_text: "Import", agent_draft: "Draft for Import", file_hash: sha256("grouped:Import") },
      ],
    });
    expect(filed.result?.isError).toBeUndefined();
    const results = (filed.result?.structuredContent as { results: { id: string }[] }).results;
    const a = results[0]!.id;
    const b = results[1]!.id;
    const other = results[2]!.id;
    const ungrouped = results[3]!.id;

    const page = await html("/");
    // One card per distinct variant, each labeled sub-block naming its own entry.
    expect(count(page, 'data-variant-group="--verbose"')).toBe(1);
    expect(count(page, 'data-variant-group="error: no git"')).toBe(1);
    expect(count(page, "data-variant-block")).toBe(3);
    expect(page).toContain(`data-variant-block="${a}"`);
    expect(page).toContain(`data-variant-block="${b}"`);
    expect(page).toContain(`data-variant-block="${other}"`);
    // Ascending id order inside the card: the older filing leads.
    const [first, second] = [a, b].sort();
    expect(page.indexOf(`data-variant-block="${first!}"`)).toBeLessThan(page.indexOf(`data-variant-block="${second!}"`));
    // Each sub-block carries its own approve action, so the human signs one case at a time.
    for (const id of [a, b, other]) {
      expect(page).toContain(`hx-post="/entries/${id}/approve"`);
    }
    // The ungrouped entry renders as today's row, outside every variant card.
    expect(page).toContain(ungrouped);
    expect(count(page, "data-variant-group=")).toBe(2);
  });

  test("approving one sub-block leaves its siblings untouched: the human signs one case at a time", async () => {
    const a = await fileEntry("independent", "Save changes", "--verbose");
    const b = await fileEntry("independent", "Discard", "--verbose");

    // The htmx approve posts a form body (the batch form's hidden filters ride along); an empty
    // urlencoded body is the minimal shape of that call.
    const response = await app.request(`/entries/${a}/approve`, {
      method: "POST",
      headers: { "HX-Request": "true", "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    expect(response.status).toBe(200);
    const region = await response.text();
    expect(region).toContain(`data-variant-block="${b}"`);

    const statuses = store.db
      .query("SELECT id, status FROM entries WHERE project_id = (SELECT id FROM projects WHERE slug = 'independent') ORDER BY id")
      .all() as { id: string; status: string }[];
    const byId = new Map(statuses.map((r) => [r.id, r.status]));
    expect(byId.get(a)).toBe("approved");
    expect(byId.get(b)).toBe("draft");
  });

  test("the editor header carries the entry's tag chip and its variant chip", async () => {
    const id = await fileEntry("editor-chip", "Save changes", "error: no git", "sample-tag");

    const page = await html(`/entries/${id}`);
    // The tag reached no editor surface before its chip existed, and the variant chip sits beside
    // it in the same page-meta; the fresh entry carries no history, so the page's only data chips
    // are these two. The layout tests own the styling.
    expect(count(page, "tag tag-data")).toBe(2);
    expect(page).toContain("sample-tag");
    expect(page).toContain("error: no git");
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { loadConfig } from "../../src/config.ts";
import { fileEntries, type NewEntry } from "../../src/db/queries.ts";
import { approveStyleGuideDraft, fileStyleGuideDraft, readStyleGuideDraft } from "../../src/db/style-guide-drafts.ts";
import { mergedStyleGuide } from "../../src/db/style-guide.ts";
import { openStore } from "../../src/db/store.ts";
import { originGate } from "../../src/daemon/origin.ts";
import { mountMcp } from "../../src/mcp/route.ts";

/**
 * The sixth tool, `file_style_guide`: an agent proposes a project style guide as a draft that stays
 * inert — absent from the merged guide (the resource and the fetch_approved rider) — until the
 * human approves it on the dashboard. One draft per project; a re-file replaces the draft.
 */

const REVISION = "2026-07-28";

const META = {
  "io.modelcontextprotocol/protocolVersion": REVISION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "reviewzy-probe", version: "0" },
};

const tempDirs: string[] = [];

function serveApp() {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-style-guide-draft-"));
  tempDirs.push(dir);
  const config = loadConfig({ REVIEWZY_DB: join(dir, "reviewzy.db") });
  const store = openStore(config);
  const app = new Hono();
  app.use(originGate(config));
  mountMcp(app, config, store);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  return { store, call, close: () => { void server.stop(true); store.close(); } };

  async function call(method: string, params: Record<string, unknown>, name?: string) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-method": method,
    };
    if (name !== undefined) headers["mcp-name"] = name;
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } }),
    });
    return (await response.json()) as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text: string }[] };
      error?: { code: number; message: string };
    };
  }
}

const env = serveApp();

function draft(over: Partial<NewEntry> = {}): NewEntry {
  return {
    repo: "https://example.com/org/repo.git",
    file: "src/app.ts",
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

const fileStyleGuide = (args: Record<string, unknown>) =>
  env.call("tools/call", { name: "file_style_guide", arguments: args }, "file_style_guide");

const fetchApproved = (args: Record<string, unknown>) =>
  env.call("tools/call", { name: "fetch_approved", arguments: args }, "fetch_approved");

const resourceText = async (slug: string) => {
  const reply = await env.call("resources/read", { uri: `reviewzy://projects/${slug}/style-guide` }, `reviewzy://projects/${slug}/style-guide`);
  return (reply as unknown as { result?: { contents?: { text: string }[] } }).result?.contents?.[0]?.text;
};

afterAll(() => {
  env.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("file_style_guide", () => {
  test("is advertised beside the five v1 tools", async () => {
    const reply = await env.call("tools/list", {});
    const tools = (reply as unknown as { result?: { tools?: { name: string }[] } }).result?.tools ?? [];
    expect(tools.map((t) => t.name)).toContain("file_style_guide");
  });

  test("files a draft that is absent from the merge, the resource, and the rider until approved", async () => {
    // The project must exist before a guide can address it (reads and drafts never mint one).
    fileEntries(env.store, "voice", null, [draft()]);

    const filed = await fileStyleGuide({
      project: "voice",
      markdown: "Project voice rules.",
      banned_words: ["utilize"],
      glossary: { widget: "the widget slot" },
    });
    expect(filed.error).toBeUndefined();
    expect(filed.result?.isError).toBeUndefined();
    expect(filed.result?.structuredContent).toEqual({ project: "voice", status: "draft" });

    const stored = readStyleGuideDraft(env.store, "voice");
    expect(stored).toEqual({
      markdown: "Project voice rules.",
      bannedWords: ["utilize"],
      glossary: { widget: "the widget slot" },
    });

    // Inert until approval: the merged guide is empty, so the resource reads empty and the
    // fetch_approved rider ships no key at all.
    expect(mergedStyleGuide(env.store, "voice")).toBe("");
    expect(await resourceText("voice")).toBe("");
    const fetched = await fetchApproved({ project: "voice" });
    expect("style_guide" in (fetched.result?.structuredContent ?? {})).toBe(false);
  });

  test("approving publishes the draft into the live guide and clears it", async () => {
    approveStyleGuideDraft(env.store, "voice");

    const merged = mergedStyleGuide(env.store, "voice");
    expect(merged).toContain("Project voice rules.");
    expect(merged).toContain("## banned");
    expect(merged).toContain("- utilize");
    expect(merged).toContain("## glossary");
    expect(merged).toContain("- widget: the widget slot");

    expect(await resourceText("voice")).toBe(merged);
    const fetched = await fetchApproved({ project: "voice" });
    expect((fetched.result?.structuredContent as { style_guide?: string }).style_guide).toBe(merged);

    expect(readStyleGuideDraft(env.store, "voice")).toBeNull();
  });

  test("a re-file replaces the one draft per project and stays inert until approved", async () => {
    await fileStyleGuide({ project: "voice", markdown: "Second proposal.", banned_words: [], glossary: {} });
    expect(readStyleGuideDraft(env.store, "voice")?.markdown).toBe("Second proposal.");
    expect(mergedStyleGuide(env.store, "voice")).not.toContain("Second proposal.");

    approveStyleGuideDraft(env.store, "voice");
    const merged = mergedStyleGuide(env.store, "voice");
    expect(merged).toContain("Second proposal.");
    expect(merged).not.toContain("Project voice rules.");
  });

  test("an unknown project is refused by name and creates nothing", async () => {
    const refused = await fileStyleGuide({ project: "ghost", markdown: "rules" });
    expect(refused.result?.isError).toBe(true);
    expect(refused.result?.content?.[0]?.text).toContain("ghost");

    const projects = env.store.db.query("SELECT COUNT(*) AS n FROM projects WHERE slug = 'ghost'").get() as { n: number };
    expect(projects.n).toBe(0);
  });
});

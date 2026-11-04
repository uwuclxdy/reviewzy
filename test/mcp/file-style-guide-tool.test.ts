import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { loadConfig } from "../../src/config.ts";
import { fileEntries } from "../../src/db/queries.ts";
import { readStyleGuideDraft } from "../../src/db/style-guide-drafts.ts";
import { mergedStyleGuide } from "../../src/db/style-guide.ts";
import { openStore } from "../../src/db/store.ts";
import { originGate } from "../../src/daemon/origin.ts";
import { mountMcp } from "../../src/mcp/route.ts";

/**
 * The wire surface of `file_style_guide`, probed the way the daemon's own tests probe it: the
 * envelope carries the `Mcp-Method`/`Mcp-Name` headers the 2026-07-28 leg validates. The
 * acceptance test in `file-style-guide.test.ts` owns the tool's pins; this file pins the refusal
 * and inertness behavior on the same wire.
 */

const REVISION = "2026-07-28";

const META = {
  "io.modelcontextprotocol/protocolVersion": REVISION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "reviewzy-probe", version: "0" },
};

const tempDirs: string[] = [];

function serveApp() {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-style-guide-tool-"));
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

afterAll(() => {
  env.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const fileStyleGuide = (args: Record<string, unknown>) =>
  env.call("tools/call", { name: "file_style_guide", arguments: args }, "file_style_guide");

const resourceText = async (slug: string) => {
  const reply = await env.call(
    "resources/read",
    { uri: `reviewzy://projects/${slug}/style-guide` },
    `reviewzy://projects/${slug}/style-guide`,
  );
  return (reply as unknown as { result?: { contents?: { text: string }[] } }).result?.contents?.[0]?.text;
};

describe("file_style_guide over the wire", () => {
  test("files a draft and answers {project, status: draft}", async () => {
    fileEntries(env.store, "voice", null, [
      {
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
      },
    ]);

    const filed = await fileStyleGuide({
      project: "voice",
      markdown: "Project voice rules.",
      banned_words: ["utilize"],
      glossary: { widget: "the widget slot" },
    });
    expect(filed.error).toBeUndefined();
    expect(filed.result?.isError).toBeUndefined();
    expect(filed.result?.structuredContent).toEqual({ project: "voice", status: "draft" });
    expect(readStyleGuideDraft(env.store, "voice")).toEqual({
      markdown: "Project voice rules.",
      bannedWords: ["utilize"],
      glossary: { widget: "the widget slot" },
    });
  });

  test("an unrecognized argument key is refused by name, with the fix", async () => {
    const refused = await fileStyleGuide({ project: "voice", markdown: "rules", banned_word: ["utilize"] });
    expect(refused.result?.isError).toBe(true);
    expect(refused.result?.content?.[0]?.text).toContain("banned_word");
    expect(refused.result?.content?.[0]?.text).toContain("file_style_guide takes only project, markdown, banned_words, and glossary");
  });

  test("an unknown project is refused by name, naming the fix, and creates nothing", async () => {
    const refused = await fileStyleGuide({ project: "ghost", markdown: "rules" });
    expect(refused.result?.isError).toBe(true);
    expect(refused.result?.content?.[0]?.text).toContain("ghost");
    expect(refused.result?.content?.[0]?.text).toContain("file an entry into it with file_entries first");
    const projects = env.store.db.query("SELECT COUNT(*) AS n FROM projects WHERE slug = 'ghost'").get() as { n: number };
    expect(projects.n).toBe(0);
  });

  test("a malformed slug is refused with the shape it must have", async () => {
    const refused = await fileStyleGuide({ project: "My App", markdown: "rules" });
    expect(refused.result?.isError).toBe(true);
    expect(refused.result?.content?.[0]?.text).toContain("lowercase letters, digits, and inner hyphens");
  });

  test("duplicate banned words and an empty glossary key are refused", async () => {
    const dupes = await fileStyleGuide({ project: "voice", markdown: "rules", banned_words: ["utilize", "utilize"] });
    expect(dupes.result?.isError).toBe(true);
    expect(dupes.result?.content?.[0]?.text).toContain("unique");

    const emptyKey = await fileStyleGuide({ project: "voice", markdown: "rules", glossary: { "": "value" } });
    expect(emptyKey.result?.isError).toBe(true);
    expect(emptyKey.result?.content?.[0]?.text).toContain("empty string");

    const nonString = await fileStyleGuide({ project: "voice", markdown: "rules", glossary: { widget: 5 } });
    expect(nonString.result?.isError).toBe(true);
    // The key reaches the message JSON-encoded, so a hostile key cannot forge a "fix:" clause.
    expect(nonString.result?.content?.[0]?.text).toContain('glossary."widget"');
  });

  test("a __proto__ glossary term stores as an own key, never swallowed", async () => {
    // The computed key is the own property; a bare `__proto__:` literal would set the prototype
    // and never reach the wire.
    const filed = await fileStyleGuide({ project: "voice", markdown: "rules", glossary: { ["__proto__"]: "x", widget: "y" } });
    expect(filed.result?.isError).toBeUndefined();
    const stored = readStyleGuideDraft(env.store, "voice")?.glossary as Record<string, string>;
    expect(Object.hasOwn(stored, "__proto__")).toBe(true);
    expect(stored["__proto__"]).toBe("x");
    expect(stored.widget).toBe("y");
  });

  test("a filed draft is inert: the merge stays empty, the resource reads empty, the rider ships no key", async () => {
    fileEntries(env.store, "quiet", null, [
      {
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
      },
    ]);
    await fileStyleGuide({ project: "quiet", markdown: "Quiet rules.", banned_words: [], glossary: {} });

    expect(mergedStyleGuide(env.store, "quiet")).toBe("");
    expect(await resourceText("quiet")).toBe("");
    const fetched = await env.call("tools/call", { name: "fetch_approved", arguments: { project: "quiet" } }, "fetch_approved");
    expect("style_guide" in (fetched.result?.structuredContent ?? {})).toBe(false);
  });
});

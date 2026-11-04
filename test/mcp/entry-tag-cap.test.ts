import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { createApp } from "../../src/daemon/app.ts";
import { openStore } from "../../src/db/store.ts";

/**
 * The tag's cap mirrors title's: no input cap at the wire boundary, the store keeps the full
 * value, and the `list_entries` lean row caps display with the `…+N chars` marker.
 */

const REVISION = "2026-07-28";

const META = {
  "io.modelcontextprotocol/protocolVersion": REVISION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "reviewzy-probe", version: "0" },
};

const dir = mkdtempSync(join(tmpdir(), "reviewzy-entry-tag-cap-"));
const config = loadConfig({ REVIEWZY_DB: join(dir, "reviewzy.db") });
const store = openStore(config);
const app = createApp(config, store);

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

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** One well-formed entry; every leg overrides only the field it is about. */
const entry = (overrides: Record<string, unknown> = {}) => ({
  repo: "https://example.com/repo.git",
  file: "src/app.ts",
  anchor_text: "Click here to continue",
  file_hash: sha256("line one\nClick here to continue\nline three\n"),
  ...overrides,
});

/** Reads one project's rows straight out of the store, ordered like the tool orders them. */
function rows(project: string) {
  return store.db
    .query("SELECT e.* FROM entries e JOIN projects p ON p.id = e.project_id WHERE p.slug = ? ORDER BY e.id")
    .all(project) as Record<string, unknown>[];
}

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the tag cap mirrors title's", () => {
  test("a 250-char tag files whole: the lean row names its remainder, the store keeps every char", async () => {
    const LONG = "x".repeat(250);
    const filed = await callTool("file_entries", { project: "longtag", entries: [entry({ tag: LONG })] });
    expect(filed.result?.isError).toBeUndefined();

    const listed = await callTool("list_entries", { project: "longtag" });
    expect(listed.result?.isError).toBeUndefined();
    const row = (listed.result?.structuredContent as { entries: { tag: string | null }[] }).entries[0]!;
    // 250 code points, the first 200 kept: the marker names exactly the dropped 50.
    expect(row.tag).toBe(`${"x".repeat(200)}…+50 chars`);
    expect(rows("longtag")[0]!.tag).toBe(LONG);
  });

  test("a 120-emoji tag files and lists whole: the caps count code points, never UTF-16 units", async () => {
    const EMOJI = "🔍".repeat(120);
    // The old input cap counted the 240 UTF-16 units; the lean cap counts the 120 code points.
    expect(EMOJI.length).toBe(240);
    expect([...EMOJI].length).toBe(120);

    const filed = await callTool("file_entries", { project: "emojitag", entries: [entry({ tag: EMOJI })] });
    expect(filed.result?.isError).toBeUndefined();

    const listed = await callTool("list_entries", { project: "emojitag" });
    expect(listed.result?.isError).toBeUndefined();
    const row = (listed.result?.structuredContent as { entries: { tag: string | null }[] }).entries[0]!;
    expect(row.tag).toBe(EMOJI);
    expect(rows("emojitag")[0]!.tag).toBe(EMOJI);
  });
});

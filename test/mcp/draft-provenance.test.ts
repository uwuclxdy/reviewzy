import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { loadConfig } from "../../src/config.ts";
import { fileEntries, type NewEntry } from "../../src/db/queries.ts";
import { rejectEntry, saveHumanNotes, saveHumanText } from "../../src/db/human-save.ts";
import { openStore } from "../../src/db/store.ts";
import { originGate } from "../../src/daemon/origin.ts";
import { mountMcp } from "../../src/mcp/route.ts";

/**
 * A later session must see how the human changed a draft: `fetch_approved` returns `agent_draft`
 * beside the approved text, plus the entry's `human_notes` (the human's why — reachable on a
 * rejected entry too, through `list_entries` ids). The `list_entries` lean row
 * stays lean: `human_notes` rides it, `agent_draft` never does.
 */

const REVISION = "2026-07-28";

const META = {
  "io.modelcontextprotocol/protocolVersion": REVISION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "reviewzy-probe", version: "0" },
};

const tempDirs: string[] = [];

function serveApp() {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-draft-fields-"));
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
    };
  }
}

const env = serveApp();

function draft(over: Partial<NewEntry> = {}): NewEntry {
  return {
    repo: "https://example.com/org/repo.git",
    file: "src/app.ts",
    title: null,
    tag: null,
    anchorText: "anchor",
    anchorBefore: "",
    anchorAfter: "",
    anchorHash: `h-${Math.random()}`,
    fileHash: "f-file",
    agentDraft: null,
    contextJson: "{}",
    constraintsJson: "{}",
    imagesJson: null,
    ...over,
  };
}

const fetchApproved = (args: Record<string, unknown>) =>
  env.call("tools/call", { name: "fetch_approved", arguments: args }, "fetch_approved");

const listEntriesCall = (args: Record<string, unknown>) =>
  env.call("tools/call", { name: "list_entries", arguments: args }, "list_entries");

const awaitApproved = (args: Record<string, unknown>) =>
  env.call("tools/call", { name: "await_approved", arguments: args }, "await_approved");

afterAll(() => {
  env.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("draft provenance on the wire", () => {
  test("an entry filed with draft A and approved as B returns both A and B, plus the human's notes", async () => {
    fileEntries(env.store, "edits", null, [draft({ anchorHash: "h-a", agentDraft: "Draft A wording" })]);
    const row = env.store.db
      .query("SELECT e.id FROM entries e JOIN projects p ON p.id = e.project_id WHERE p.slug = 'edits'")
      .get() as { id: string };
    saveHumanText(env.store, { id: row.id, text: "Human B wording" });
    saveHumanNotes(env.store, { id: row.id, notes: "keep it short" });

    const fetched = await fetchApproved({ project: "edits" });
    const entry = (fetched.result?.structuredContent as { entries: Record<string, unknown>[] }).entries[0]!;
    expect(entry.text).toBe("Human B wording");
    expect(entry.agent_draft).toBe("Draft A wording");
    expect(entry.human_notes).toBe("keep it short");
    expect(Object.keys(entry).sort()).toEqual([
      "agent_draft",
      "anchor_after",
      "anchor_before",
      "anchor_text",
      "constraints",
      "file",
      "human_notes",
      "id",
      "repo",
      "text",
    ]);
  });

  test("a rejected entry's human_notes reach list_entries; the lean row stays lean", async () => {
    fileEntries(env.store, "edits-rejected", null, [draft({ anchorHash: "h-b" })]);
    const rows = env.store.db
      .query("SELECT e.id FROM entries e JOIN projects p ON p.id = e.project_id WHERE p.slug = 'edits-rejected'")
      .all() as { id: string }[];
    const rejectedId = rows[0]!.id;
    rejectEntry(env.store, rejectedId);
    saveHumanNotes(env.store, { id: rejectedId, notes: "no — we say deploy" });

    const fetched = await fetchApproved({ project: "edits-rejected" });
    expect((fetched.result?.structuredContent as { entries: unknown[] }).entries).toHaveLength(0);

    const listed = await listEntriesCall({ project: "edits-rejected", ids: [rejectedId] });
    const lean = (listed.result?.structuredContent as { entries: Record<string, unknown>[] }).entries[0]!;
    expect(lean.status).toBe("rejected");
    expect(lean.human_notes).toBe("no — we say deploy");
    expect("agent_draft" in lean).toBe(false);
  });

  test("an entry without a draft or notes returns null fields, keys present", async () => {
    fileEntries(env.store, "edits-plain", null, [draft({ anchorHash: "h-c" })]);
    const rows = env.store.db
      .query("SELECT e.id FROM entries e JOIN projects p ON p.id = e.project_id WHERE p.slug = 'edits-plain'")
      .all() as { id: string }[];
    saveHumanText(env.store, { id: rows[0]!.id, text: "signed" });

    const fetched = await fetchApproved({ project: "edits-plain" });
    const entry = (fetched.result?.structuredContent as { entries: Record<string, unknown>[] }).entries[0]!;
    expect(entry.agent_draft).toBeNull();
    expect(entry.human_notes).toBeNull();
  });

  test("await_approved resolves a rejected id in statuses; the why rides list_entries, not the wait", async () => {
    fileEntries(env.store, "edits-await", null, [draft({ anchorHash: "h-d" })]);
    const rows = env.store.db
      .query("SELECT e.id FROM entries e JOIN projects p ON p.id = e.project_id WHERE p.slug = 'edits-await'")
      .all() as { id: string }[];
    const id = rows[0]!.id;
    rejectEntry(env.store, id);
    saveHumanNotes(env.store, { id, notes: "wrong tone for the header" });

    const reply = await awaitApproved({ ids: [id], timeout_ms: 5000 });
    const resolved = reply.result?.structuredContent as {
      resolved: boolean;
      statuses?: Record<string, string>;
      entries?: Record<string, unknown>[];
    };
    expect(resolved.resolved).toBe(true);
    expect(resolved.statuses?.[id]).toBe("rejected");
    // The wait's entries stay the approved slice (the frozen surface's shape); the human's why on a
    // rejected entry flows through list_entries, which the lean-row test above pins.
    expect(resolved.entries?.find((e) => e.id === id)).toBeUndefined();
  });
});

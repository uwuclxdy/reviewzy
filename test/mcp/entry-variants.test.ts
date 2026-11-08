import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { createApp } from "../../src/daemon/app.ts";
import { openStore } from "../../src/db/store.ts";

/**
 * The per-entry `variant`: a case label the filing agent groups the cases of one surface by
 * (`--verbose` beside the default output, the error case beside the success case). Accepted like
 * `tag` — optional, stored raw, outside the identity key, overwritten by a re-file that carries it
 * and kept by one that omits it — and carried by the lean row, the apply-back rows, and the
 * dashboard's one-card-per-variant grouping.
 */

const REVISION = "2026-07-28";

const META = {
  "io.modelcontextprotocol/protocolVersion": REVISION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "reviewzy-probe", version: "0" },
};

const dir = mkdtempSync(join(tmpdir(), "reviewzy-entry-variants-"));
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

const entry = (overrides: Record<string, unknown> = {}) => ({
  repo: "https://example.com/org/repo.git",
  file: "src/app.ts",
  anchor_text: "Save changes",
  agent_draft: "Save your changes",
  file_hash: sha256("variant-file"),
  ...overrides,
});

/** Approves one entry the way the human's save does, so apply-back reads have a row to return. */
function approve(id: string, text: string): void {
  store.db.run("UPDATE entries SET status = 'approved', human_text = ? WHERE id = ?", [text, id]);
}

const storeVariants = (slug: string) =>
  (
    store.db
      .query(
        "SELECT e.variant FROM entries e JOIN projects p ON p.id = e.project_id WHERE p.slug = ? ORDER BY e.id",
      )
      .all(slug) as { variant: string | null }[]
  ).map((r) => r.variant);

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("per-entry variants", () => {
  test("file_entries accepts variant: a variant-carrying entry files and the store row carries it raw", async () => {
    const filed = await callTool("file_entries", {
      project: "variants",
      entries: [entry({ variant: "--verbose" }), entry({ anchor_text: "Discard", agent_draft: "Discard it", file_hash: sha256("v2"), variant: "error: no git" })],
    });
    expect(filed.result?.isError).toBeUndefined();
    expect(storeVariants("variants").sort()).toEqual(["--verbose", "error: no git"]);
  });

  test("a variant is optional: an entry without one stores null", async () => {
    const filed = await callTool("file_entries", {
      project: "variants-optional",
      entries: [entry({ anchor_text: "plain", file_hash: sha256("plain") })],
    });
    expect(filed.result?.isError).toBeUndefined();
    expect(storeVariants("variants-optional")).toEqual([null]);
  });

  test("the lean row carries variant beside tag, capped by the same 200-char marker", async () => {
    const long = "x".repeat(250);
    await callTool("file_entries", {
      project: "variants-lean",
      entries: [entry({ anchor_text: "long", file_hash: sha256("long"), variant: long }), entry({ anchor_text: "short", file_hash: sha256("short"), variant: "--verbose" })],
    });
    const listed = await callTool("list_entries", { project: "variants-lean", limit: 200 });
    expect(listed.result?.isError).toBeUndefined();
    const out = (listed.result?.structuredContent as { entries: { variant: string | null }[] }).entries;
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.variant).sort()).toEqual(["--verbose", `${"x".repeat(200)}…+50 chars`]);
    // The cap is display-side: the store keeps the full value the caller sent.
    const stored = (
      store.db
        .query("SELECT e.variant FROM entries e JOIN projects p ON p.id = e.project_id WHERE p.slug = 'variants-lean'")
        .all() as { variant: string | null }[]
    ).map((r) => r.variant);
    expect(stored.sort()).toEqual(["--verbose", long]);
  });

  test("a re-file carrying a new variant overwrites the draft; an omitted one keeps it", async () => {
    const first = await callTool("file_entries", {
      project: "variants-refile",
      entries: [entry({ variant: "--verbose" })],
    });
    expect(first.result?.isError).toBeUndefined();

    const refiled = await callTool("file_entries", {
      project: "variants-refile",
      entries: [entry({ variant: "error: no git", agent_draft: "Draft updated" })],
    });
    expect(refiled.result?.isError).toBeUndefined();
    expect(((refiled.result?.structuredContent as { results: { deduped: boolean; updated: boolean }[] }).results)[0]).toMatchObject({ deduped: true, updated: true });
    expect(storeVariants("variants-refile")).toEqual(["error: no git"]);

    await callTool("file_entries", {
      project: "variants-refile",
      entries: [entry({ agent_draft: "Draft updated again" })],
    });
    expect(storeVariants("variants-refile")).toEqual(["error: no git"]);
  });

  test("a re-file against an approved entry comes back untouched whatever variant it carries", async () => {
    const filed = await callTool("file_entries", {
      project: "variants-approved",
      entries: [entry({ variant: "--verbose" })],
    });
    const id = ((filed.result?.structuredContent as { results: { id: string }[] }).results)[0]!.id;
    approve(id, "human prose");

    const refiled = await callTool("file_entries", {
      project: "variants-approved",
      entries: [entry({ variant: "error: no git" })],
    });
    expect(refiled.result?.isError).toBeUndefined();
    expect(((refiled.result?.structuredContent as { results: { deduped: boolean; updated: boolean }[] }).results)[0]).toMatchObject({ deduped: true, updated: false });
    expect(storeVariants("variants-approved")).toEqual(["--verbose"]);
  });

  test("fetch_approved rows carry variant beside agent_draft, null when the entry has none", async () => {
    const filed = await callTool("file_entries", {
      project: "variants-fetch",
      entries: [entry({ variant: "--verbose" }), entry({ anchor_text: "plain", file_hash: sha256("fetch-plain") })],
    });
    const ids = (filed.result?.structuredContent as { results: { id: string }[] }).results.map((r) => r.id);
    approve(ids[0]!, "first prose");
    approve(ids[1]!, "second prose");

    const fetched = await callTool("fetch_approved", { project: "variants-fetch" });
    expect(fetched.result?.isError).toBeUndefined();
    const rows = (fetched.result?.structuredContent as { entries: { id: string; variant: string | null }[] }).entries;
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ["agent_draft", "anchor_after", "anchor_before", "anchor_text", "constraints", "file", "human_notes", "id", "repo", "text", "variant"],
    );
    expect(rows.map((r) => r.variant).sort()).toEqual(["--verbose", null]);
  });

  test("await_approved rows carry variant through the shared mapping", async () => {
    const filed = await callTool("file_entries", {
      project: "variants-await",
      entries: [entry({ variant: "error: no git" })],
    });
    const id = ((filed.result?.structuredContent as { results: { id: string }[] }).results)[0]!.id;
    approve(id, "human prose");

    const awaited = await callTool("await_approved", { ids: [id], timeout_ms: 1000 });
    expect(awaited.result?.isError).toBeUndefined();
    const rows = (awaited.result?.structuredContent as { entries: { variant: string | null }[] }).entries ?? [];
    expect(rows.map((r) => r.variant)).toEqual(["error: no git"]);
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { createApp } from "../../src/daemon/app.ts";
import { openStore } from "../../src/db/store.ts";

/**
 * An optional per-entry tag: the dashboard filters and groups by it, and `list_entries` filters on
 * it. 20 entries tagged `prefix` among 200 show alone under that filter, on the dashboard and
 * through `list_entries`.
 */

const REVISION = "2026-07-28";

const META = {
  "io.modelcontextprotocol/protocolVersion": REVISION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "reviewzy-probe", version: "0" },
};

const TAGGED = 20;
const TOTAL = 200;
const TAG = "prefix";

const dir = mkdtempSync(join(tmpdir(), "reviewzy-entry-tags-"));
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

// Seeded once, before the tests: 200 entries in one call, the first 20 tagged. The results array
// is filing order, so the tagged ids are the first 20 results.
const seeded = (async () => {
  const entries = Array.from({ length: TOTAL }, (_, n) => ({
    repo: "https://example.com/org/repo.git",
    file: `src/f${n}.ts`,
    anchor_text: `anchor ${n}`,
    agent_draft: `Draft ${n}`,
    file_hash: sha256(`file ${n}`),
    ...(n < TAGGED ? { tag: TAG } : {}),
  }));
  return (await callTool("file_entries", { project: "tags", entries })).result?.structuredContent as {
    results: { id: string }[];
  };
})();

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("entry tags", () => {
  test("filed tags persist and ride the lean row", async () => {
    const filed = await seeded;
    expect(filed?.results).toHaveLength(TOTAL);

    const listed = await callTool("list_entries", { project: "tags", limit: TOTAL });
    const out = listed.result?.structuredContent as { entries: { id: string; tag: string | null }[] };
    expect(out.entries).toHaveLength(TOTAL);
    const tagged = out.entries.filter((e) => e.tag === TAG);
    expect(tagged).toHaveLength(TAGGED);
    expect(tagged.map((e) => e.id).sort()).toEqual(filed!.results.slice(0, TAGGED).map((r) => r.id).sort());
    // Filing order is the results array's order, never id order (same-millisecond ulids shuffle), so
    // the untagged half is counted, never sliced by position.
    expect(out.entries.filter((e) => e.tag === null)).toHaveLength(TOTAL - TAGGED);
  });

  test("list_entries filters on the tag: the 20 tagged among 200 show alone", async () => {
    const filed = await seeded;
    const listed = await callTool("list_entries", { project: "tags", tag: TAG, limit: TOTAL });
    expect(listed.result?.isError).toBeUndefined();
    const out = listed.result?.structuredContent as { entries: { id: string; tag: string }[] };
    expect(out.entries).toHaveLength(TAGGED);
    expect(out.entries.every((e) => e.tag === TAG)).toBe(true);
    expect(out.entries.map((e) => e.id).sort()).toEqual(filed!.results.slice(0, TAGGED).map((r) => r.id).sort());
  });

  test("a tag nothing carries is an empty result, not a refusal", async () => {
    const listed = await callTool("list_entries", { project: "tags", tag: "no-such-tag", limit: TOTAL });
    expect(listed.result?.isError).toBeUndefined();
    expect(((listed.result?.structuredContent as { entries: unknown[] }).entries) ?? []).toHaveLength(0);
  });

  test("a draft re-file updates the tag; a re-file without one keeps it", async () => {
    await seeded;
    const rows = store.db
      .query("SELECT id, file, anchor_text, tag FROM entries WHERE tag = ? ORDER BY id")
      .all(TAG) as { id: string; file: string; anchor_text: string; tag: string | null }[];
    const target = rows[0]!;

    // Re-file one tagged entry with a new tag: same identity key (repo, file, anchor_text), so it
    // dedupes onto the same row.
    const refiled = await callTool("file_entries", {
      project: "tags",
      entries: [{
        repo: "https://example.com/org/repo.git",
        file: target.file,
        anchor_text: target.anchor_text,
        agent_draft: "Draft updated",
        file_hash: sha256("refile"),
        tag: "renamed",
      }],
    });
    expect(refiled.result?.isError).toBeUndefined();
    expect(((refiled.result?.structuredContent as { results: { deduped: boolean }[] }).results)[0]?.deduped).toBe(true);
    const after = store.db.query("SELECT tag FROM entries WHERE id = ?").get(target.id) as { tag: string | null };
    expect(after.tag).toBe("renamed");

    // A re-file carrying no tag keeps the stored one.
    await callTool("file_entries", {
      project: "tags",
      entries: [{
        repo: "https://example.com/org/repo.git",
        file: target.file,
        anchor_text: target.anchor_text,
        agent_draft: "Draft updated again",
        file_hash: sha256("refile"),
      }],
    });
    const kept = store.db.query("SELECT tag FROM entries WHERE id = ?").get(target.id) as { tag: string | null };
    expect(kept.tag).toBe("renamed");
  });

  test("an empty tag is refused at the boundary", async () => {
    const reply = await callTool("file_entries", {
      project: "tags",
      entries: [{
        repo: "https://example.com/org/repo.git",
        file: "src/x.ts",
        anchor_text: "a",
        file_hash: sha256("empty-tag"),
        tag: "",
      }],
    });
    // The entry carries provenance, so the refusal is the tag's own minimum, not a missing-hash
    // rejection riding the same isError.
    expect(reply.result?.isError).toBe(true);
    expect(reply.result?.content?.[0]?.text).toContain("tag");
  });

  test("the dashboard shows the tagged entries alone under the tag filter", async () => {
    // The sets derive from the store at render time: an earlier leg re-files one tagged entry to
    // "renamed", so the current tagged set is 19, never the filed 20. The list renders every row
    // (no pagination), so both sides are exact.
    const taggedIds = (store.db
      .query(
        "SELECT e.id FROM entries e JOIN projects p ON p.id = e.project_id WHERE p.slug = 'tags' AND e.tag = ?",
      )
      .all(TAG) as { id: string }[]).map((r) => r.id);
    const untaggedIds = (store.db
      .query(
        "SELECT e.id FROM entries e JOIN projects p ON p.id = e.project_id WHERE p.slug = 'tags' AND e.tag IS NULL",
      )
      .all() as { id: string }[]).map((r) => r.id);

    const response = await app.request("/?project=tags&tag=prefix");
    expect(response.status).toBe(200);
    const html = await response.text();

    const missing = taggedIds.filter((id) => !html.includes(id));
    expect(missing).toHaveLength(0);
    const leaked = untaggedIds.filter((id) => html.includes(id));
    expect(leaked).toHaveLength(0);
  });

  test("the tag filter matches whole values only: prefix never answers for prefix-2 or xprefix", async () => {
    await seeded;
    const plants = [
      { file: "src/prefix-2.ts", anchor_text: "anchor p2", agent_draft: "Draft p2", tag: "prefix-2" },
      { file: "src/xprefix.ts", anchor_text: "anchor x", agent_draft: "Draft x", tag: "xprefix" },
      { file: "src/prefix-upper.ts", anchor_text: "anchor u", agent_draft: "Draft u", tag: "Prefix" },
      { file: "src/prefix-pad.ts", anchor_text: "anchor pad", agent_draft: "Draft pad", tag: " prefix " },
      { file: "src/pre-wild.ts", anchor_text: "anchor w1", agent_draft: "Draft w1", tag: "pre_fix" },
      { file: "src/prezfix.ts", anchor_text: "anchor w2", agent_draft: "Draft w2", tag: "prezfix" },
    ];
    const planted = await callTool("file_entries", {
      project: "tags",
      entries: plants.map((p) => ({
        repo: "https://example.com/org/repo.git",
        file: p.file,
        anchor_text: p.anchor_text,
        agent_draft: p.agent_draft,
        file_hash: sha256(p.file),
        tag: p.tag,
      })),
    });
    expect(planted.result?.isError).toBeUndefined();
    const plantedIds = (planted.result?.structuredContent as { results: { id: string }[] }).results.map((r) => r.id);
    expect(plantedIds).toHaveLength(plants.length);

    // The tags stored exactly as sent, so the exclusions below are never vacuous.
    const stored = new Map(
      (
        store.db
          .query(`SELECT id, tag FROM entries WHERE id IN (${plants.map(() => "?").join(", ")})`)
          .all(...plantedIds) as { id: string; tag: string }[]
      ).map((r) => [r.id, r.tag]),
    );
    expect(plantedIds.every((id) => stored.has(id))).toBe(true);
    expect([...stored.values()].sort()).toEqual(plants.map((p) => p.tag).sort());

    // The store's exact rows carrying `prefix` (the oracle is raw SQL spelling the whole-value
    // rule, never the code under test): the re-file test may have renamed one to "renamed", so
    // the set is derived at assertion time, not sliced from the filed 20.
    const expected = (
      store.db
        .query("SELECT e.id FROM entries e JOIN projects p ON p.id = e.project_id WHERE p.slug = 'tags' AND e.tag = 'prefix'")
        .all() as { id: string }[]
    ).map((r) => r.id);

    const listed = await callTool("list_entries", { project: "tags", tag: TAG, limit: 200 });
    expect(listed.result?.isError).toBeUndefined();
    const out = listed.result?.structuredContent as { entries: { id: string; tag: string }[] };
    expect(out.entries.every((e) => e.tag === "prefix")).toBe(true);
    expect(out.entries.map((e) => e.id).sort()).toEqual([...expected].sort());
    expect(plantedIds.filter((id) => out.entries.some((e) => e.id === id))).toHaveLength(0);

    // A wildcard-bearing filter answers for exactly its own row: `pre_fix` must not reach
    // `prezfix` the way SQL's LIKE would (the underscore is a one-char wildcard there).
    const wild = await callTool("list_entries", { project: "tags", tag: "pre_fix", limit: 200 });
    expect(wild.result?.isError).toBeUndefined();
    const wildOut = wild.result?.structuredContent as { entries: { id: string; tag: string }[] };
    expect(wildOut.entries).toHaveLength(1);
    expect(wildOut.entries[0]?.tag).toBe("pre_fix");

    // An unmatched tag that is a proper substring of a planted tag still yields the empty page.
    const unmatched = await callTool("list_entries", { project: "tags", tag: "prefix-", limit: 200 });
    expect(unmatched.result?.isError).toBeUndefined();
    expect(((unmatched.result?.structuredContent as { entries: unknown[] }).entries) ?? []).toHaveLength(0);

    // A padded query answers for exactly its own padded row, never for the unpadded tag either
    // side of it (trimming the stored value or the query both move this count).
    const padded = await callTool("list_entries", { project: "tags", tag: " prefix ", limit: 200 });
    expect(padded.result?.isError).toBeUndefined();
    const paddedOut = padded.result?.structuredContent as { entries: { id: string; tag: string }[] };
    expect(paddedOut.entries).toHaveLength(1);
    expect(paddedOut.entries[0]?.tag).toBe(" prefix ");

    // The dashboard's tag filter routes through the store's exact match too, so a mutant at the
    // store reds both channels through this one test.
    const response = await app.request("/?project=tags&tag=prefix");
    expect(response.status).toBe(200);
    const html = await response.text();
    const missing = [...expected].sort().filter((id) => !html.includes(id));
    expect(missing).toHaveLength(0);
    expect(plantedIds.filter((id) => html.includes(id))).toHaveLength(0);
  });
});

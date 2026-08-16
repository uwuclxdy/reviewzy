import { createHash } from "node:crypto";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { loadConfig } from "../../src/config.ts";
import { upsertStyleGuide } from "../../src/db/style-guide.ts";
import { openStore } from "../../src/db/store.ts";
import type { Store } from "../../src/db/store.ts";
import { originGate } from "../../src/daemon/origin.ts";
import { mountMcp } from "../../src/mcp/route.ts";

const REVISION = "2026-07-28";

const META = {
  "io.modelcontextprotocol/protocolVersion": REVISION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "reviewzy-probe", version: "0" },
};

/** The advertised port; the actual bind is port 0, see `serveApp`. */
const PORT = 3198;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

type WireEntry = {
  id: string;
  repo: string;
  file: string;
  anchor_text: string;
  anchor_before: string;
  anchor_after: string;
  anchor_hash: string;
  file_hash: string;
  text: string | null;
  constraints: Record<string, unknown>;
};
type FetchResult = { entries: WireEntry[]; style_guide: string; next_since?: string };
type FiledResult = { results: { id: string }[] };

type WireResult = {
  resultType?: string;
  isError?: boolean;
  structuredContent?: FetchResult | FiledResult;
  content?: { type: string; text: string }[];
};

const tempDirs: string[] = [];

/**
 * One app per suite-leg, not per test: the app holds the one store the daemon would hold, and a
 * cursor leg needs the rows a seeding leg wrote, so tests inside a describe share state by name.
 */
function serveApp() {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-fetch-approved-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "reviewzy.db");
  const config = loadConfig({ REVIEWZY_DB: dbPath, REVIEWZY_PORT: String(PORT) });
  const store = openStore(config);

  const app = new Hono();
  app.use(originGate(config));
  mountMcp(app, config, store);

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return { store, call, close: () => { void server.stop(true); store.close(); } };

  async function call(method: string, params: Record<string, unknown>, name?: string) {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-method": method,
    };
    if (name !== undefined) headers["mcp-name"] = name;

    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } }),
    });
    const body = (await response.json()) as {
      jsonrpc: string;
      id: number;
      result?: WireResult & {
        tools?: { name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown }[];
        contents?: { uri: string; mimeType?: string; text: string }[];
      };
      error?: { code: number; message: string };
    };
    return { status: response.status, body };
  }
}

const first = serveApp();

afterAll(() => {
  void first.close();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** One well-formed entry; every leg overrides only the field it is about. */
const entry = (overrides: Record<string, unknown> = {}) => ({
  repo: "https://example.com/repo.git",
  file: "src/app.ts",
  anchor_text: "Click here to continue",
  anchor_before: "const label = t(`home.hero`)",
  anchor_after: "</button>",
  agent_draft: "Continue",
  file_content: "line one\nClick here to continue\nline three\n",
  context: { where: "hero button", surrounding: "<button>{{label}}</button>" },
  constraints: { max_len: 24, placeholders: ["{name}"], tone: "plain", notes: "no exclamation marks" },
  ...overrides,
});

const fileEntries = (args: Record<string, unknown>) =>
  first.call("tools/call", { name: "file_entries", arguments: args }, "file_entries");

const fetchApproved = (args: Record<string, unknown>) =>
  first.call("tools/call", { name: "fetch_approved", arguments: args }, "fetch_approved");

/** Reads one project's rows straight out of the store, ordered like the tool orders them. */
function rows(store: Store, project: string) {
  return store.db
    .query("SELECT e.* FROM entries e JOIN projects p ON p.id = e.project_id WHERE p.slug = ? ORDER BY e.id")
    .all(project) as Record<string, unknown>[];
}

/**
 * Flips rows the way the dashboard save will (queue task 13 owns the real path): status to
 * approved, the prose into human_text. `text` null leaves human_text null, which a hand-edited
 * row could hold.
 */
function approve(store: Store, ids: readonly string[], text: string | null): void {
  if (ids.length === 0) return;
  store.db.run(
    `UPDATE entries SET status = 'approved', human_text = ? WHERE id IN (${ids.map(() => "?").join(", ")})`,
    [text, ...ids],
  );
}

describe("the tool surface", () => {
  test("fetch_approved is advertised beside file_entries and list_entries, with both schemas and the apply-back contract in the description", async () => {
    const { body } = await first.call("tools/list", {});
    const tools = body.result?.tools ?? [];
    expect(tools.map((t) => t.name)).toEqual(["file_entries", "list_entries", "fetch_approved", "mark_applied", "await_approved"]);

    const tool = tools[2]!;
    const input = tool.inputSchema as {
      type?: string;
      properties?: Record<string, Record<string, unknown>>;
    };
    expect(input.type).toBe("object");
    expect(Object.keys(input.properties ?? {})).toEqual(["project", "ids", "since"]);

    const output = tool.outputSchema as { properties?: Record<string, unknown> };
    expect(Object.keys(output.properties ?? {})).toEqual(["entries", "style_guide", "next_since"]);

    const description = tool.description ?? "";
    expect(description).toContain("approved");
    expect(description).toContain("50");
    expect(description).toContain("next_since");
  });
});

describe("what comes back", () => {
  test("only approved entries appear: draft, applied, or rejected never does, even when its id is named", async () => {
    const filed = (await fileEntries({
      project: "gated",
      entries: [
        entry({ anchor_text: "first" }),
        entry({ anchor_text: "second" }),
        entry({ anchor_text: "third" }),
        entry({ anchor_text: "fourth" }),
        entry({ anchor_text: "fifth" }),
      ],
    })).body.result?.structuredContent as FiledResult;
    const [a, b, c, d, e] = filed.results.map((r) => r.id);
    approve(first.store, [a!], "signed off one");
    approve(first.store, [c!], "signed off three");
    // The other three statuses, written the way their owners will: b leaves via mark_applied
    // (queue task 9), d is rejected on the dashboard (queue task 13), e stays the filed draft.
    first.store.db.run("UPDATE entries SET status = 'applied' WHERE id = ?", [b!]);
    first.store.db.run("UPDATE entries SET status = 'rejected' WHERE id = ?", [d!]);

    const all = (await fetchApproved({ project: "gated" })).body.result?.structuredContent as FetchResult;
    expect(all.entries.map((x) => x.id).sort()).toEqual([a!, c!].sort());
    const byId = new Map(all.entries.map((x) => [x.id, x]));
    expect(byId.get(a!)?.text).toBe("signed off one");
    expect(byId.get(c!)?.text).toBe("signed off three");

    // An ids filter naming any other status filters it out, never a refusal.
    const others = (await fetchApproved({ project: "gated", ids: [b!, d!, e!] })).body.result
      ?.structuredContent as FetchResult;
    expect(others.entries).toEqual([]);
    const mixed = (await fetchApproved({ project: "gated", ids: [a!, b!] })).body.result
      ?.structuredContent as FetchResult;
    expect(mixed.entries.map((x) => x.id)).toEqual([a!]);
  });

  test("an approved row whose human_text was never written still returns, text null", async () => {
    const filed = (await fileEntries({
      project: "null-text",
      entries: [entry({ anchor_text: "anchor null" })],
    })).body.result?.structuredContent as FiledResult;
    approve(first.store, [filed.results[0]!.id], null);

    const out = (await fetchApproved({ project: "null-text" })).body.result?.structuredContent as FetchResult;
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]?.text).toBeNull();
  });

  test("each entry carries the applying shape: text from human_text, the anchor fields, and no context or status", async () => {
    await fileEntries({ project: "shape", entries: [entry()] });
    const stored = rows(first.store, "shape");
    approve(first.store, [stored[0]!.id as string], "human prose");

    const { body } = await fetchApproved({ project: "shape" });
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBeUndefined();
    expect(body.result?.resultType).toBe("complete");
    const out = body.result?.structuredContent as FetchResult;
    const wire = out.entries[0]!;
    expect(Object.keys(wire).sort()).toEqual([
      "anchor_after",
      "anchor_before",
      "anchor_hash",
      "anchor_text",
      "constraints",
      "file",
      "file_hash",
      "id",
      "repo",
      "text",
    ]);
    expect(wire.text).toBe("human prose");
    expect(wire.repo).toBe("https://example.com/repo.git");
    expect(wire.file).toBe("src/app.ts");
    expect(wire.anchor_text).toBe("Click here to continue");
    expect(wire.anchor_before).toBe("const label = t(`home.hero`)");
    expect(wire.anchor_after).toBe("</button>");
    expect(wire.anchor_hash).toBe(sha256("Click here to continue"));
    expect(wire.file_hash).toBe(sha256("line one\nClick here to continue\nline three\n"));
    expect("status" in wire).toBe(false);
    expect("context" in wire).toBe(false);
  });
});

describe("constraints", () => {
  test("constraints arrive parsed into the typed object, missing fields omitted", async () => {
    const filed = (await fileEntries({
      project: "constraints",
      entries: [
        entry({ anchor_text: "full" }),
        entry({ anchor_text: "partial", constraints: { max_len: 12 } }),
      ],
    })).body.result?.structuredContent as FiledResult;
    // `ulid()` within one batch is not monotonic, so the two ids are resolved by id, never by
    // filing position — the result is ordered by id, which sorts either way.
    const [fullId, partialId] = filed.results.map((r) => r.id);
    approve(first.store, [fullId!, partialId!], "a modest line");

    const out = (await fetchApproved({ project: "constraints" })).body.result?.structuredContent as FetchResult;
    const byId = new Map(out.entries.map((e) => [e.id, e]));
    expect(byId.get(fullId!)?.constraints).toEqual({
      max_len: 24,
      placeholders: ["{name}"],
      tone: "plain",
      notes: "no exclamation marks",
    });
    expect(byId.get(partialId!)?.constraints).toEqual({ max_len: 12 });
    expect("tone" in byId.get(partialId!)!.constraints).toBe(false);
  });

  test("a row storing malformed constraints json renders as the empty object", async () => {
    const filed = (await fileEntries({
      project: "malformed",
      entries: [entry()],
    })).body.result?.structuredContent as FiledResult;
    const id = filed.results[0]!.id;
    approve(first.store, [id!], "text");

    for (const bad of ["not json", "[]", '"tone"', '{"maxLen": 24}', '{"max_len": "24"}', '{"tone": 5}']) {
      first.store.db.run("UPDATE entries SET constraints = ? WHERE id = ?", [bad, id]);
      const out = (await fetchApproved({ project: "malformed" })).body.result?.structuredContent as FetchResult;
      expect(out.entries[0]?.constraints, bad).toEqual({});
    }
  });
});

describe("the style guide", () => {
  test("the embedded style_guide equals the merged resource text byte-for-byte", async () => {
    await fileEntries({ project: "voice", entries: [entry()] });
    upsertStyleGuide(first.store, null, {
      markdown: "Global rules.",
      bannedWords: ["awesome"],
      glossary: { widget: "a screen element" },
    });
    upsertStyleGuide(first.store, "voice", {
      markdown: "Project rules.",
      bannedWords: ["utilize", "awesome"],
      glossary: { widget: "the widget slot", layout: "the grid" },
    });

    const resource = await first.call(
      "resources/read",
      { uri: "reviewzy://projects/voice/style-guide" },
      "reviewzy://projects/voice/style-guide",
    );
    const resourceText = resource.body.result?.contents?.[0]?.text ?? "";
    expect(resourceText).not.toBe("");

    const { body } = await fetchApproved({ project: "voice" });
    expect(body.error).toBeUndefined();
    const out = body.result?.structuredContent as FetchResult;
    expect(out.style_guide).toBe(resourceText);
  });
});

describe("pagination", () => {
  /**
   * The walk compares against ids SORTED, never insertion order: plain `ulid()` is not monotonic
   * within one millisecond, so a batch filed in one call can sort any which way. The contract pins
   * the ORDER BY id, which is deterministic either way.
   */
  test("walks more approved rows than one page holds via since: no duplicate, no gap, next_since only on full pages", async () => {
    const filed = (await fileEntries({
      project: "walk",
      entries: Array.from({ length: 51 }, (_, i) => entry({ anchor_text: `Anchor ${i}` })),
    })).body.result?.structuredContent as FiledResult;
    const sorted = filed.results.map((r) => r.id).sort();
    approve(first.store, sorted, "signed off");

    const pages: FetchResult[] = [];
    let since: string | undefined;
    let guard = 0;
    do {
      const { body } = await fetchApproved({
        project: "walk",
        ...(since === undefined ? {} : { since }),
      });
      const result = body.result?.structuredContent as FetchResult;
      pages.push(result);
      since = result.next_since;
    } while (since !== undefined && ++guard < 10);
    expect(guard).toBeLessThan(10);

    expect(pages.map((p) => p.entries.length)).toEqual([50, 1]);
    expect(pages[0]?.next_since).toBe(pages[0]?.entries.at(-1)?.id);
    expect("next_since" in pages[1]!).toBe(false);

    const walked: string[] = [];
    let previous: string | undefined;
    for (const page of pages) {
      const ids = page.entries.map((e) => e.id);
      expect(ids).toEqual([...ids].sort());
      if (previous !== undefined) {
        for (const id of ids) expect(id > previous).toBe(true);
      }
      if (ids.length > 0) previous = ids.at(-1);
      walked.push(...ids);
    }
    expect(walked).toEqual(sorted);
    expect(new Set(walked).size).toBe(51);
  });

  test("ids and since combine with AND", async () => {
    const filed = (await fileEntries({
      project: "combo",
      entries: Array.from({ length: 6 }, (_, i) => entry({ anchor_text: `Combo ${i}` })),
    })).body.result?.structuredContent as FiledResult;
    const sorted = filed.results.map((r) => r.id).sort();
    approve(first.store, sorted, "signed off");
    const [a, b, c, d, e] = sorted;

    const out = (await fetchApproved({ project: "combo", ids: [b!, c!, d!, e!], since: b! })).body.result
      ?.structuredContent as FetchResult;
    expect(out.entries.map((x) => x.id)).toEqual([c!, d!, e!]);

    const before = (await fetchApproved({ project: "combo", ids: [a!, b!], since: e! })).body.result
      ?.structuredContent as FetchResult;
    expect(before.entries).toEqual([]);
    expect("next_since" in before).toBe(false);
  });

  test("a project with no approved entries returns an empty entries list, no next_since, and the guide", async () => {
    await fileEntries({ project: "empty", entries: [entry()] });

    // The "voice" leg above seeded global guide rows into this shared store; clear them so this
    // leg reaches the no-rows state, the same leg style-guide-resource.test.ts uses. Byte-equality
    // against the resource then pins the empty-guide case the seeded leg cannot reach: the tool
    // and the resource read through the same merge, so only a state where the merge yields ""
    // separates them.
    first.store.db.run("DELETE FROM style_guides");

    const resource = await first.call(
      "resources/read",
      { uri: "reviewzy://projects/empty/style-guide" },
      "reviewzy://projects/empty/style-guide",
    );
    const resourceText = resource.body.result?.contents?.[0]?.text ?? "";

    const out = (await fetchApproved({ project: "empty" })).body.result?.structuredContent as FetchResult;
    expect(out.entries).toEqual([]);
    expect("next_since" in out).toBe(false);
    expect(out.style_guide).toBe(resourceText);
    expect(out.style_guide).toBe("");
  });
});

describe("refusals", () => {
  test("an unknown project is a business refusal naming the slug and the fix, and creates nothing", async () => {
    const { status, body } = await fetchApproved({ project: "ghost" });
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBe(true);
    const text = body.result?.content?.[0]?.text ?? "";
    expect(text).toContain("ghost");
    expect(text).toContain("fix:");

    const projects = first.store.db.query("SELECT COUNT(*) AS n FROM projects WHERE slug = 'ghost'").get() as {
      n: number;
    };
    expect(projects.n).toBe(0);
  });

  test("a missing project and an empty ids array are refused at the schema boundary", async () => {
    const noProject = await fetchApproved({ ids: ["nope"] });
    expect(noProject.body.result?.isError).toBe(true);
    expect(noProject.body.result?.content?.[0]?.text).toContain("project");

    const emptyIds = await fetchApproved({ project: "gated", ids: [] });
    expect(emptyIds.body.result?.isError).toBe(true);
  });
});

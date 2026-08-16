import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { loadConfig } from "../../src/config.ts";
import { openStore } from "../../src/db/store.ts";
import type { Store } from "../../src/db/store.ts";
import { mountMcp, originGate } from "../../src/mcp/route.ts";

const REVISION = "2026-07-28";

const META = {
  "io.modelcontextprotocol/protocolVersion": REVISION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "reviewzy-probe", version: "0" },
};

/** The advertised port; the actual bind is port 0, see `serveApp`. */
const PORT = 3200;

type WireEntry = Record<string, unknown>;
type ListResult = { entries: WireEntry[]; next_cursor?: string };
type FiledResult = { results: { id: string }[] };

type WireResult = {
  resultType?: string;
  isError?: boolean;
  structuredContent?: ListResult | FiledResult;
  content?: { type: string; text: string }[];
};

const tempDirs: string[] = [];

/**
 * One app per suite-leg, not per test: the app holds the one store the daemon would hold, and a
 * filter leg needs the rows a seeding leg wrote, so tests inside a describe share state by name.
 */
function serveApp() {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-list-entries-"));
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
      result?: WireResult & { tools?: { name: string; inputSchema?: unknown; outputSchema?: unknown }[] };
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

const listEntries = (args: Record<string, unknown>) =>
  first.call("tools/call", { name: "list_entries", arguments: args }, "list_entries");

/** Reads one project's rows straight out of the store, ordered like the tool orders them. */
function rows(store: Store, project: string) {
  return store.db
    .query("SELECT e.* FROM entries e JOIN projects p ON p.id = e.project_id WHERE p.slug = ? ORDER BY e.id")
    .all(project) as Record<string, unknown>[];
}

describe("the tool surface", () => {
  test("list_entries is advertised beside file_entries, with the filters, the limit bounds, and both schemas", async () => {
    const { body } = await first.call("tools/list", {});
    const tools = body.result?.tools ?? [];
    expect(tools.map((t) => t.name)).toEqual(["file_entries", "list_entries", "fetch_approved", "mark_applied", "await_approved"]);

    const tool = tools[1]!;
    const input = tool.inputSchema as {
      type?: string;
      properties?: Record<string, Record<string, unknown>>;
    };
    expect(input.type).toBe("object");
    expect(Object.keys(input.properties ?? {})).toEqual(["project", "status", "ids", "q", "limit", "cursor"]);
    const limit = input.properties?.limit ?? {};
    expect(limit.default).toBe(50);
    expect(limit.maximum).toBe(200);
    expect(limit.minimum).toBe(1);

    const output = tool.outputSchema as { properties?: Record<string, unknown> };
    expect(Object.keys(output.properties ?? {})).toEqual(["entries", "next_cursor"]);
  });
});

describe("the returned rows", () => {
  test("carry the stored fields as stored, context and constraints as their json strings, archived_at null", async () => {
    await fileEntries({ project: "fields", filed_by: "audit-agent", entries: [entry()] });
    const { body } = await listEntries({ project: "fields" });
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBeUndefined();
    expect(body.result?.resultType).toBe("complete");

    const out = (body.result?.structuredContent as ListResult).entries[0]!;
    const stored = rows(first.store, "fields")[0]!;

    const FIELDS = [
      "id", "project_id", "batch_id", "repo", "file", "anchor_text", "anchor_before",
      "anchor_after", "anchor_hash", "file_hash", "agent_draft", "human_text", "status",
      "context", "constraints", "filed_by", "stale_note", "applied_hash", "created_at", "updated_at", "applied_at", "archived_at",
    ];
    for (const field of FIELDS) {
      expect(out[field], field).toBe(stored[field]);
    }
    // The frozen entry schema carries `archived_at`; every v1 row is null (no archive sweep yet).
    expect("archived_at" in out).toBe(true);
    expect(out.archived_at).toBeNull();

    // applied_hash round-trips: a null wire value alone could hide a schema omission, so write a
    // real hash the way mark_applied stores one and re-list it.
    first.store.db.run("UPDATE entries SET applied_hash = ? WHERE id = ?", ["a".repeat(64), out.id as string]);
    const relisted = (await listEntries({ project: "fields" })).body.result
      ?.structuredContent as ListResult;
    expect(relisted.entries[0]?.applied_hash).toBe("a".repeat(64));

    expect(typeof out.context).toBe("string");
    expect(JSON.parse(out.context as string)).toEqual(entry().context);
    expect(JSON.parse(out.constraints as string)).toEqual(entry().constraints);
  });
});

describe("filters", () => {
  test("project limits to one project's rows; omitted, the list spans projects", async () => {
    const alpha = (await fileEntries({
      project: "alpha",
      entries: [entry(), entry({ anchor_text: "second anchor" })],
    })).body.result?.structuredContent as FiledResult;
    const beta = (await fileEntries({ project: "beta", entries: [entry({ anchor_text: "beta anchor" })] })).body.result
      ?.structuredContent as FiledResult;
    const alphaIds = alpha.results.map((r) => r.id).sort();
    const betaId = beta.results[0]!.id;

    const scoped = (await listEntries({ project: "alpha" })).body.result?.structuredContent as ListResult;
    expect(scoped.entries.map((e) => e.id).sort()).toEqual(alphaIds);
    expect(scoped.entries.map((e) => e.id)).not.toContain(betaId);

    // The spans assertion is containment, not a total count: earlier legs seeded other projects
    // into the same store, and an exact number would depend on test order.
    const both = (await listEntries({})).body.result?.structuredContent as ListResult;
    const ids = both.entries.map((e) => e.id);
    for (const id of [...alphaIds, betaId]) expect(ids).toContain(id);
  });

  test("status limits to rows in that state", async () => {
    const filed = (await fileEntries({
      project: "statuses",
      entries: [entry(), entry({ anchor_text: "approved one" })],
    })).body.result?.structuredContent as FiledResult;
    const [draftId, approvedId] = filed.results.map((r) => r.id);
    first.store.db.run("UPDATE entries SET status = 'approved', human_text = 'signed off' WHERE id = ?", [
      approvedId!,
    ]);

    const drafts = (await listEntries({ project: "statuses", status: "draft" })).body.result
      ?.structuredContent as ListResult;
    expect(drafts.entries.map((e) => e.id)).toEqual([draftId]);
    const approved = (await listEntries({ project: "statuses", status: "approved" })).body.result
      ?.structuredContent as ListResult;
    expect(approved.entries.map((e) => e.id)).toEqual([approvedId]);
  });

  test("ids returns exactly those entries, in id order regardless of the input order", async () => {
    const filed = (await fileEntries({
      project: "ids",
      entries: [entry(), entry({ anchor_text: "second" }), entry({ anchor_text: "third" })],
    })).body.result?.structuredContent as FiledResult;
    const [a, b, c] = filed.results.map((r) => r.id);

    const picked = (await listEntries({ ids: [c!, a!] })).body.result?.structuredContent as ListResult;
    // The result is id-sorted, never input-sorted; `ulid()` within one batch is not monotonic, so
    // the ids are sorted explicitly rather than assumed to equal the filing order.
    expect(picked.entries.map((e) => e.id)).toEqual([a, c].sort());
    // The ids filter itself never excludes the untouched middle row from other lists.
    expect(picked.entries.map((e) => e.id)).not.toContain(b);
  });

  test("q matches case-insensitively as a substring of any of file, anchor_text, agent_draft, human_text — and nothing else", async () => {
    const filed = (await fileEntries({
      project: "q",
      entries: [
        entry({ file: "src/welcome.ts", anchor_text: "Continue reading", agent_draft: "Read more" }),
        entry({ file: "src/help.ts", anchor_text: "Need assistance", agent_draft: "KEEP GOING" }),
        entry({ file: "src/legal.ts", anchor_text: "Accept terms", agent_draft: undefined }),
        entry({ file: "src/faq.ts", anchor_text: "Read the MANUAL", agent_draft: "Docs" }),
        // The query term appears in anchor_before and context only, which q must not see.
        entry({ file: "src/decoy.ts", anchor_text: "Log in", anchor_before: "KEEP the old button" }),
        // The file column's term is uppercase: only a folded column matches a lowercase query.
        entry({ file: "src/SPEC.ts", anchor_text: "Start here", agent_draft: "Overview" }),
      ],
    })).body.result?.structuredContent as FiledResult;
    const ids = filed.results.map((r) => r.id);
    // `human_text` is authored on the dashboard; this leg writes it the way that save would.
    first.store.db.run("UPDATE entries SET human_text = 'Scroll to the fine print' WHERE id = ?", [ids[2]!]);

    const keep = (await listEntries({ project: "q", q: "keep" })).body.result?.structuredContent as ListResult;
    expect(keep.entries.map((e) => e.id)).toEqual([ids[1]]);
    const manual = (await listEntries({ project: "q", q: "Manual" })).body.result?.structuredContent as ListResult;
    expect(manual.entries.map((e) => e.id)).toEqual([ids[3]]);
    const print = (await listEntries({ project: "q", q: "print" })).body.result?.structuredContent as ListResult;
    expect(print.entries.map((e) => e.id)).toEqual([ids[2]]);
    const welcome = (await listEntries({ project: "q", q: "welcome" })).body.result
      ?.structuredContent as ListResult;
    expect(welcome.entries.map((e) => e.id)).toEqual([ids[0]]);
    const spec = (await listEntries({ project: "q", q: "spec" })).body.result?.structuredContent as ListResult;
    expect(spec.entries.map((e) => e.id)).toEqual([ids[5]]);
  });

  test("q treats % and _ as literal characters, never LIKE wildcards", async () => {
    const filed = (await fileEntries({
      project: "wildcards",
      entries: [
        entry({ anchor_text: "100% done" }),
        entry({ anchor_text: "a_b" }),
        entry({ anchor_text: "plain words" }),
      ],
    })).body.result?.structuredContent as FiledResult;
    const [percent, underscore] = filed.results.map((r) => r.id);

    // Under a LIKE-based search these two queries would match every row: `%` and `_` are
    // wildcards there, and `instr` keeps them literal.
    const percentHit = (await listEntries({ project: "wildcards", q: "%" })).body.result
      ?.structuredContent as ListResult;
    expect(percentHit.entries.map((e) => e.id)).toEqual([percent]);
    const underscoreHit = (await listEntries({ project: "wildcards", q: "_" })).body.result
      ?.structuredContent as ListResult;
    expect(underscoreHit.entries.map((e) => e.id)).toEqual([underscore]);
  });

  test("project, status, ids, and q combine with AND", async () => {
    const filed = (await fileEntries({
      project: "comb",
      entries: [
        entry({ file: "src/a.ts", anchor_text: "One", agent_draft: "KEEP GOING" }),
        entry({ file: "src/b.ts", anchor_text: "Two", agent_draft: "KEEP GOING" }),
        entry({ file: "src/c.ts", anchor_text: "Three", agent_draft: "FULL SEND" }),
      ],
    })).body.result?.structuredContent as FiledResult;
    const [a, b, c] = filed.results.map((r) => r.id);
    first.store.db.run("UPDATE entries SET status = 'approved' WHERE id = ?", [b!]);
    await fileEntries({ project: "other", entries: [entry({ file: "src/d.ts", anchor_text: "Four", agent_draft: "KEEP GOING" })] });

    const out = (await listEntries({ project: "comb", status: "draft", q: "keep", ids: [a!, b!, c!] })).body.result
      ?.structuredContent as ListResult;
    // project drops the "other" row, status drops b, q drops c, ids admits only a, b, c.
    expect(out.entries.map((e) => e.id)).toEqual([a]);
  });
});

describe("pagination", () => {
  /**
   * The walk compares against ids SORTED, never insertion order: plain `ulid()` is not monotonic
   * within one millisecond, so a batch filed in one call can sort any which way. The contract pins
   * the ORDER BY id, which is deterministic either way.
   */
  test("walks a page of 3 through 10 entries to exhaustion: no duplicate, no gap, cursor only on full pages", async () => {
    const filed = (await fileEntries({
      project: "pages",
      entries: Array.from({ length: 10 }, (_, i) => entry({ anchor_text: `Anchor ${i}` })),
    })).body.result?.structuredContent as FiledResult;
    const sorted = filed.results.map((r) => r.id).sort();

    const pages: ListResult[] = [];
    let cursor: string | undefined;
    let guard = 0;
    do {
      const { body } = await listEntries({
        project: "pages",
        limit: 3,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const result = body.result?.structuredContent as ListResult;
      expect(body.error).toBeUndefined();
      pages.push(result);
      cursor = result.next_cursor;
    } while (cursor !== undefined && ++guard < 10);
    expect(guard).toBeLessThan(10);

    expect(pages.map((p) => p.entries.length)).toEqual([3, 3, 3, 1]);
    expect(pages.slice(0, 3).map((p) => p.next_cursor === p.entries.at(-1)!.id)).toEqual([true, true, true]);
    expect(pages[3]?.next_cursor).toBeUndefined();

    const walked: string[] = [];
    let previousCursor: string | undefined;
    for (const page of pages) {
      const ids = page.entries.map((e) => e.id as string);
      expect(ids).toEqual([...ids].sort());
      if (previousCursor !== undefined) {
        for (const id of ids) expect(id > previousCursor).toBe(true);
      }
      if (ids.length > 0) previousCursor = ids.at(-1)!;
      walked.push(...ids);
    }
    expect(walked).toEqual(sorted);
    expect(new Set(walked).size).toBe(10);
  });

  test("a filter matching nothing returns an empty page with no next_cursor, and a cursor past the end does the same", async () => {
    const filed = (await fileEntries({
      project: "empty",
      entries: [entry(), entry({ anchor_text: "another" })],
    })).body.result?.structuredContent as FiledResult;
    const last = filed.results.map((r) => r.id).sort().at(-1)!;

    const none = (await listEntries({ project: "empty", status: "rejected" })).body.result
      ?.structuredContent as ListResult;
    expect(none.entries).toEqual([]);
    expect("next_cursor" in none).toBe(false);

    const past = (await listEntries({ project: "empty", cursor: last })).body.result
      ?.structuredContent as ListResult;
    expect(past.entries).toEqual([]);
    expect("next_cursor" in past).toBe(false);
  });
});

describe("refusals", () => {
  test("an unknown project is a business refusal naming the slug and the fix; a read tool creates nothing", async () => {
    const { status, body } = await listEntries({ project: "ghost" });
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

  test("refuses a limit above 200, at 0, non-integer, and negative; an empty ids array; and an empty q — accepting the 200 boundary", async () => {
    await fileEntries({ project: "cap", entries: [entry()] });

    for (const bad of [{ limit: 201 }, { limit: 0 }, { limit: 1.5 }, { limit: -1 }]) {
      const { body } = await listEntries({ project: "cap", ...bad });
      expect(body.result?.isError, JSON.stringify(bad)).toBe(true);
      expect(body.result?.content?.[0]?.text, JSON.stringify(bad)).toContain("limit");
    }
    for (const bad of [{ ids: [] }, { q: "" }]) {
      const { body } = await listEntries({ project: "cap", ...bad });
      expect(body.result?.isError, JSON.stringify(bad)).toBe(true);
      expect(body.result?.content?.[0]?.text, JSON.stringify(bad)).toContain(Object.keys(bad)[0]!);
    }

    const ok = (await listEntries({ project: "cap", limit: 200 })).body.result?.structuredContent as ListResult;
    expect(ok.entries).toHaveLength(1);
    expect(ok.next_cursor).toBeUndefined();
  });
});

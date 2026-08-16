import { createHash } from "node:crypto";
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

/** The advertised port dashboard_url carries; the actual bind is port 0, see `serveApp`. */
const PORT = 3199;

/** Crockford base32, the alphabet ulid draws from: 26 chars, no I L O U. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

type Result = {
  batch_id: string;
  results: { id: string; status: string; deduped: boolean; updated: boolean }[];
  dashboard_url: string;
};

type WireResult = {
  resultType?: string;
  isError?: boolean;
  structuredContent?: Result;
  content?: { type: string; text: string }[];
};

const tempDirs: string[] = [];

/**
 * One app per suite-leg, not per test: the app holds the one store the daemon would hold, and a
 * re-file leg needs the row a first-file leg wrote, so tests inside a describe share state by name.
 */
function serveApp() {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-file-entries-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "reviewzy.db");
  // A fixed advertised port, since dashboard_url is built from `config.baseUrl`: the value the
  // daemon would print, not the kernel-assigned one this bind lands on. The desync touches only
  // the origin gate's loopback branch, and no probe here sends an Origin at all.
  const config = loadConfig({ REVIEWZY_DB: dbPath, REVIEWZY_PORT: String(PORT) });
  const store = openStore(config);

  // The same mounting `createApp` performs, minus the sibling-owned file: origin gate then mcp.
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

/** Reads one project's rows straight out of the store the tool wrote through: every leg shares the suite's single store, so a count must be scoped or it counts other legs' rows. */
function rows(store: Store, project: string) {
  return store.db
    .query("SELECT e.* FROM entries e JOIN projects p ON p.id = e.project_id WHERE p.slug = ? ORDER BY e.id")
    .all(project) as Record<string, unknown>[];
}

describe("the tool surface", () => {
  test("file_entries is advertised beside list_entries, with an input and an output schema", async () => {
    const { status, body } = await first.call("tools/list", {});
    expect(status).toBe(200);
    const tools = body.result?.tools ?? [];
    expect(tools.map((t) => t.name)).toEqual(["file_entries", "list_entries", "fetch_approved", "mark_applied"]);
    expect((tools[0]?.inputSchema as { type?: string }).type).toBe("object");
    expect(Object.keys(tools[0]?.outputSchema as object).length).toBeGreaterThan(0);
  });
});

describe("a first file", () => {
  test("creates entries with minted ulid ids, status draft, deduped and updated false, one shared batch, and the dashboard url", async () => {
    const { status, body } = await fileEntries({
      project: "app",
      filed_by: "audit-agent",
      entries: [
        entry(),
        entry({ file: "src/settings.ts", anchor_text: "Save changes now" }),
      ],
    });

    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    const result = body.result;
    expect(result?.isError).toBeUndefined();
    expect(result?.resultType).toBe("complete");

    const out = result?.structuredContent as Result;
    expect(out.batch_id).toMatch(ULID);
    expect(out.dashboard_url).toBe(`http://127.0.0.1:${PORT}/projects/app`);

    expect(out.results).toHaveLength(2);
    for (const r of out.results) {
      expect(r.id).toMatch(ULID);
      expect(r.status).toBe("draft");
      expect(r.deduped).toBe(false);
      expect(r.updated).toBe(false);
    }
    expect(out.results[0]?.id).not.toBe(out.results[1]?.id);

    const stored = rows(first.store, "app");
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      expect(row.batch_id).toBe(out.batch_id);
      expect(row.status).toBe("draft");
      expect(row.filed_by).toBe("audit-agent");
      expect(row.anchor_hash).toBe(sha256(row.anchor_text as string));
      expect(row.file_hash).toBe(sha256("line one\nClick here to continue\nline three\n"));
      expect(row.human_text).toBeNull();
      expect(JSON.parse(row.constraints as string)).toEqual(entry().constraints);
      expect(JSON.parse(row.context as string)).toEqual(entry().context);
    }
  });

  test("auto-creates the project on an unknown slug, and a second file reuses it", async () => {
    await fileEntries({ project: "solo", entries: [entry()] });
    await fileEntries({ project: "solo", entries: [entry({ anchor_text: "another anchor" })] });

    // Scoped to the slug: earlier legs filed into other projects, and a global count would count theirs.
    const projects = first.store.db
      .query("SELECT slug FROM projects WHERE slug = 'solo'")
      .all() as { slug: string }[];
    expect(projects).toEqual([{ slug: "solo" }]);
    expect(rows(first.store, "solo")).toHaveLength(2);
  });

  test("stores a caller-supplied file_hash verbatim when no file content is sent", async () => {
    const hash = "a".repeat(64);
    await fileEntries({ project: "hashes", entries: [entry({ file_content: undefined, file_hash: hash })] });
    expect(rows(first.store, "hashes")[0]?.file_hash).toBe(hash);
  });

  test("refuses a file_hash that is not sha256 hex, naming the entry, the field, and the fix", async () => {
    for (const bad of ["xyz", "A".repeat(64), "a".repeat(63)]) {
      const { body } = await fileEntries({
        project: "hashes-bad",
        entries: [entry({ file_content: undefined, file_hash: bad })],
      });
      expect(body.result?.isError).toBe(true);
      expect(body.error).toBeUndefined();
      expect(body.result?.content?.[0]?.text).toContain("file_hash");
      expect(body.result?.content?.[0]?.text).toContain("src/app.ts");
    }
    expect(rows(first.store, "hashes-bad")).toHaveLength(0);
  });

  test("refuses an entry with neither file_content nor file_hash, and writes nothing", async () => {
    const { body } = await fileEntries({
      project: "hashes-none",
      entries: [entry({ file_content: undefined, file_hash: undefined })],
    });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("file_hash");
    expect(rows(first.store, "hashes-none")).toHaveLength(0);
  });

  test("refuses an entry supplying both file_content and file_hash", async () => {
    const { body } = await fileEntries({
      project: "hashes-both",
      entries: [entry({ file_hash: "b".repeat(64) })],
    });
    expect(body.result?.isError).toBe(true);
    expect(rows(first.store, "hashes-both")).toHaveLength(0);
  });

  test("accepts 1-char and hyphenated slugs, refuses every other spelling naming the rule", async () => {
    for (const good of ["a", "app-42"]) {
      const { body } = await fileEntries({ project: good, entries: [entry()] });
      expect(body.result?.isError, `slug ${good}`).toBeUndefined();
    }
    for (const bad of ["My-App", "-lead", "trail-", "under_score", "a".repeat(64), "has space"]) {
      const { body } = await fileEntries({ project: bad, entries: [entry()] });
      expect(body.result?.isError, `slug ${bad}`).toBe(true);
      expect(body.result?.content?.[0]?.text).toContain("project");
    }
  });

  test("ignores keys the schema does not know: a smuggled status and human_text still file as draft", async () => {
    const { body } = await fileEntries({
      project: "smuggle",
      entries: [entry({ status: "approved", human_text: "pre-written" })],
    });

    // The status machine is server-enforced: the result echoes the real status, draft.
    expect(body.result?.isError).toBeUndefined();
    const out = body.result?.structuredContent as Result;
    expect(out.results[0]?.status).toBe("draft");
    const row = rows(first.store, "smuggle")[0]!;
    expect(row.status).toBe("draft");
    expect(row.human_text).toBeNull();
    expect(row.agent_draft).toBe("Continue");
  });

  test("a first file without context, constraints, or draft stores the empty defaults", async () => {
    const { body } = await fileEntries({
      project: "bare",
      entries: [entry({ agent_draft: undefined, context: undefined, constraints: undefined })],
    });

    expect(body.result?.isError).toBeUndefined();
    const row = rows(first.store, "bare")[0]!;
    expect(row.agent_draft).toBeNull();
    expect(JSON.parse(row.context as string)).toEqual({});
    expect(JSON.parse(row.constraints as string)).toEqual({});
  });
});

describe("re-file semantics", () => {
  /**
   * Backdates the row a production write made, so "did the re-file move it" is answered against a
   * sentinel the environment cannot produce, never against two Date.now() reads inside one ms.
   */
  function backdate(store: Store, id: string, column: "created_at" | "updated_at", ms = 1000) {
    store.db.run(`UPDATE entries SET ${column} = ? WHERE id = ?`, [ms, id]);
  }

  test("a re-file at draft overwrites the agent draft, context, and constraints in place", async () => {
    const filed = (await fileEntries({ project: "refile", filed_by: "first-agent", entries: [entry()] })).body.result
      ?.structuredContent as Result;
    const id = filed.results[0]!.id;
    backdate(first.store, id, "created_at");
    backdate(first.store, id, "updated_at");

    const redone = await fileEntries({
      project: "refile",
      filed_by: "second-agent",
      entries: [
        entry({
          agent_draft: "Keep going",
          context: { where: "moved to the footer" },
          constraints: { max_len: 12 },
        }),
      ],
    });

    const out = redone.body.result?.structuredContent as Result;
    expect(out.results[0]).toMatchObject({ id, status: "draft", deduped: true, updated: true });

    const row = rows(first.store, "refile").at(-1)!;
    expect(row.id).toBe(id);
    expect(row.agent_draft).toBe("Keep going");
    expect(JSON.parse(row.context as string)).toEqual({ where: "moved to the footer" });
    expect(JSON.parse(row.constraints as string)).toEqual({ max_len: 12 });
    // The overwrite is exactly the contract's three fields: provenance of the first filing stays.
    expect(row.batch_id).toBe(filed.batch_id);
    expect(row.created_at).toBe(1000);
    expect(row.filed_by).toBe("first-agent");
    expect(row.updated_at as number).toBeGreaterThan(1_000_000);
    // Overwritten in place, so the re-file minted no second row.
    expect(rows(first.store, "refile").length).toBe(1);
  });

  /**
   * The wipe this pins: before the COALESCE fix, a re-file that did not carry a field replaced it
   * with the empty default — draft became NULL, context and constraints became "{}".
   */
  test.each([
    {
      carried: "agent_draft",
      project: "partial-draft",
      only: { agent_draft: "Keep going" },
      after: { agent_draft: "Keep going", context: entry().context, constraints: entry().constraints },
    },
    {
      carried: "context",
      project: "partial-context",
      only: { context: { where: "moved" } },
      after: { agent_draft: "Continue", context: { where: "moved" }, constraints: entry().constraints },
    },
    {
      carried: "constraints",
      project: "partial-constraints",
      only: { constraints: { max_len: 12 } },
      after: { agent_draft: "Continue", context: entry().context, constraints: { max_len: 12 } },
    },
  ] as const)(
    "a re-file carrying only $carried keeps the first filing's other fields",
    async ({ carried, project, only, after }) => {
      const filed = (await fileEntries({ project, entries: [entry()] })).body.result
        ?.structuredContent as Result;
      const id = filed.results[0]!.id;

      const redone = await fileEntries({
        project,
        entries: [{ ...entry({ agent_draft: undefined, context: undefined, constraints: undefined }), ...only }],
      });

      expect((redone.body.result?.structuredContent as Result).results[0]).toMatchObject({
        id,
        status: "draft",
        deduped: true,
        updated: true,
      });

      const row = rows(first.store, project)[0]!;
      expect(row.agent_draft).toBe(after.agent_draft);
      expect(JSON.parse(row.context as string)).toEqual(after.context);
      expect(JSON.parse(row.constraints as string)).toEqual(after.constraints);
      expect(rows(first.store, project).length).toBe(1);
    },
  );

  test("explicit null in a re-file reads as absent: the stored notes and draft survive", async () => {
    const filed = (await fileEntries({ project: "partial-null", entries: [entry()] })).body.result
      ?.structuredContent as Result;
    const id = filed.results[0]!.id;

    const redone = await fileEntries({
      project: "partial-null",
      entries: [entry({ agent_draft: undefined, context: null, constraints: null })],
    });

    expect((redone.body.result?.structuredContent as Result).results[0]).toMatchObject({
      id,
      status: "draft",
      deduped: true,
      updated: true,
    });

    const row = rows(first.store, "partial-null")[0]!;
    expect(row.agent_draft).toBe("Continue");
    expect(JSON.parse(row.context as string)).toEqual(entry().context);
    expect(JSON.parse(row.constraints as string)).toEqual(entry().constraints);
  });

  test.each(["approved", "applied", "rejected"] as const)(
    "a re-file against an existing %s entry no-ops, returning that entry and its status",
    async (status) => {
      const filed = (await fileEntries({
        project: `noop-${status}`,
        entries: [entry({ anchor_text: `anchor ${status}` })],
      })).body.result?.structuredContent as Result;
      const id = filed.results[0]!.id;
      first.store.db.run("UPDATE entries SET status = ?, human_text = ?, updated_at = 1000 WHERE id = ?", [
        status,
        "human prose",
        id,
      ]);

      const redone = await fileEntries({
        project: `noop-${status}`,
        entries: [entry({ anchor_text: `anchor ${status}`, agent_draft: "late draft" })],
      });

      const out = redone.body.result?.structuredContent as Result;
      expect(out.results[0]).toMatchObject({ id, status, deduped: true, updated: false });

      const row = rows(first.store, `noop-${status}`).at(-1)!
      expect(row.agent_draft).toBe("Continue");
      expect(row.human_text).toBe("human prose");
      expect(row.updated_at).toBe(1000);
      // The no-op minted no second row: the project still holds exactly its one entry.
      expect(rows(first.store, `noop-${status}`).length).toBe(1);
    },
  );

  test("a re-file against a rejected anchor stays silent: no new row, no status change, no overwrite", async () => {
    const filed = (await fileEntries({ project: "silent", entries: [entry()] })).body.result
      ?.structuredContent as Result;
    first.store.db.run("UPDATE entries SET status = 'rejected' WHERE id = ?", [filed.results[0]!.id]);

    const redone = await fileEntries({ project: "silent", entries: [entry({ agent_draft: "again" })] });

    expect((redone.body.result?.structuredContent as Result).results[0]).toMatchObject({
      status: "rejected",
      deduped: true,
      updated: false,
    });
    expect(rows(first.store, "silent")).toHaveLength(1);
    expect(rows(first.store, "silent")[0]?.agent_draft).toBe("Continue");
  });
});

describe("the json boundary", () => {
  test("malformed constraints is refused as a tool error naming the entry, the bad field, and the fix", async () => {
    const { status, body } = await fileEntries({
      project: "boundary",
      entries: [
        entry(),
        entry({
          file: "src/other.ts",
          anchor_text: "Delete this item",
          constraints: { max_len: "24" },
        }),
      ],
    });

    // A business refusal is a tool result, never a json-rpc protocol error.
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBe(true);
    const text = body.result?.content?.[0]?.text ?? "";
    expect(text).toContain("entries[1]");
    expect(text).toContain("src/other.ts");
    expect(text).toContain("max_len");
    expect(text).toMatch(/fix:/i);

    // The whole call is refused: the well-formed entries[0] never landed either.
    expect(rows(first.store, "boundary")).toHaveLength(0);
  });

  test("a non-object context is refused the same way", async () => {
    const { body } = await fileEntries({
      project: "boundary",
      entries: [entry({ context: "renders on the homepage" })],
    });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("context");
    expect(rows(first.store, "boundary")).toHaveLength(0);
  });

  test("an unrecognized constraints key is refused naming the key it does not know", async () => {
    const { body } = await fileEntries({
      project: "boundary",
      entries: [entry({ constraints: { maxLen: 24 } })],
    });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("maxLen");
    expect(rows(first.store, "boundary")).toHaveLength(0);
  });

  test("a duplicate placeholder is refused naming placeholders", async () => {
    const { body } = await fileEntries({
      project: "boundary",
      entries: [entry({ constraints: { placeholders: ["{user}", "{user}"] } })],
    });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("placeholders");
    expect(rows(first.store, "boundary")).toHaveLength(0);
  });
});

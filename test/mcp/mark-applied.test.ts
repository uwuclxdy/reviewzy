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

/** The advertised port; the actual bind is port 0, see `serveApp`. */
const PORT = 3201;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

type MarkResult = { id: string; status: "applied" | "approved" };
type FiledResult = { results: { id: string }[] };

type WireResult = {
  resultType?: string;
  isError?: boolean;
  structuredContent?: MarkResult | FiledResult;
  content?: { type: string; text: string }[];
};

const tempDirs: string[] = [];

/**
 * One app per suite-leg, not per test: the app holds the one store the daemon would hold, and a
 * transition leg needs the rows a seeding leg wrote, so tests inside a describe share state by name.
 */
function serveApp() {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-mark-applied-"));
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

const markApplied = (args: Record<string, unknown>) =>
  first.call("tools/call", { name: "mark_applied", arguments: args }, "mark_applied");

/** Files one entry through the wire and returns its id. */
async function seed(project: string, anchor: string): Promise<string> {
  const filed = (await fileEntries({ project, entries: [entry({ anchor_text: anchor })] })).body.result
    ?.structuredContent as FiledResult;
  return filed.results[0]!.id;
}

/**
 * Flips a row the way the dashboard save will (queue task 13 owns the real path): status to
 * approved, the prose into human_text.
 */
function approve(store: Store, id: string, text = "signed off"): void {
  store.db.run("UPDATE entries SET status = 'approved', human_text = ? WHERE id = ?", [text, id]);
}

/** The dashboard's other transition (queue task 13): rejected is terminal. */
function reject(store: Store, id: string): void {
  store.db.run("UPDATE entries SET status = 'rejected' WHERE id = ?", [id]);
}

function row(store: Store, id: string) {
  return store.db.query("SELECT * FROM entries WHERE id = ?").get(id) as Record<string, unknown>;
}

/** A refusal must write nothing at all: the whole row, updated_at included, is byte-identical. */
function expectUnchanged(store: Store, id: string, before: Record<string, unknown>): void {
  expect(JSON.stringify(row(store, id))).toBe(JSON.stringify(before));
}

describe("the tool surface", () => {
  test("mark_applied is advertised beside the other three tools, with the loop-close schemas and the boundary rules in the description", async () => {
    const { body } = await first.call("tools/list", {});
    const tools = body.result?.tools ?? [];
    expect(tools.map((t) => t.name)).toEqual(["file_entries", "list_entries", "fetch_approved", "mark_applied", "await_approved"]);

    const tool = tools[3]!;
    const input = tool.inputSchema as {
      type?: string;
      properties?: Record<string, Record<string, unknown>>;
    };
    expect(input.type).toBe("object");
    expect(Object.keys(input.properties ?? {})).toEqual(["id", "result", "applied_hash", "found_text"]);
    expect((input.properties?.result as { enum?: unknown }).enum).toEqual(["applied", "anchor_stale"]);

    const output = tool.outputSchema as { properties?: Record<string, unknown> };
    expect(Object.keys(output.properties ?? {})).toEqual(["id", "status"]);

    const description = tool.description ?? "";
    expect(description).toContain("applied");
    expect(description).toContain("anchor_stale");
  });
});

describe("applying", () => {
  test("approved + applied stamps applied_at, which was null, and answers the resulting status", async () => {
    const id = await seed("apply", "Click here to continue");
    approve(first.store, id);
    expect(row(first.store, id).applied_at).toBeNull();

    const { status, body } = await markApplied({ id, result: "applied" });
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBeUndefined();
    expect(body.result?.resultType).toBe("complete");
    expect(body.result?.structuredContent).toEqual({ id, status: "applied" });

    const after = row(first.store, id);
    expect(after.status).toBe("applied");
    expect(typeof after.applied_at).toBe("number");
    expect(after.applied_hash).toBeNull();
  });

  test("applied_hash is stored on apply and overwritten by the next apply", async () => {
    const id = await seed("hash-overwrite", "Save now");
    approve(first.store, id);

    await markApplied({ id, result: "applied", applied_hash: sha256("one") });
    expect(row(first.store, id).applied_hash).toBe(sha256("one"));

    // A stale anchor is the only path that re-opens an applied entry.
    await markApplied({ id, result: "anchor_stale", found_text: "Save immediately" });
    expect(row(first.store, id).status).toBe("approved");

    await markApplied({ id, result: "applied", applied_hash: sha256("two") });
    expect(row(first.store, id).applied_hash).toBe(sha256("two"));
  });

  test("applied_hash is left untouched when the call omits it", async () => {
    const id = await seed("hash-omit", "Click to submit");
    approve(first.store, id);

    await markApplied({ id, result: "applied", applied_hash: sha256("one") });
    await markApplied({ id, result: "anchor_stale" });
    await markApplied({ id, result: "applied" });

    expect(row(first.store, id).applied_hash).toBe(sha256("one"));
  });

  test("found_text with result applied is accepted and writes no stale_note", async () => {
    const id = await seed("found-text-ignored", "Dismiss");
    approve(first.store, id);

    const { body } = await markApplied({ id, result: "applied", found_text: "whatever" });
    expect(body.result?.isError).toBeUndefined();
    expect(row(first.store, id).status).toBe("applied");
    expect(row(first.store, id).stale_note).toBeNull();
  });
});

describe("stale anchors", () => {
  test("approved + anchor_stale keeps the entry approved, records found_text, and stamps nothing", async () => {
    const id = await seed("stale-approved", "Continue");
    approve(first.store, id);

    const { status, body } = await markApplied({ id, result: "anchor_stale", found_text: "Go on" });
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBeUndefined();
    expect(body.result?.structuredContent).toEqual({ id, status: "approved" });

    const after = row(first.store, id);
    expect(after.status).toBe("approved");
    expect(after.stale_note).toBe("Go on");
    expect(after.applied_at).toBeNull();
    expect(after.applied_hash).toBeNull();
  });

  test("a stale report without found_text clears a previous note", async () => {
    const id = await seed("stale-clear", "Sign in");
    approve(first.store, id);

    await markApplied({ id, result: "anchor_stale", found_text: "Log in" });
    expect(row(first.store, id).stale_note).toBe("Log in");

    await markApplied({ id, result: "anchor_stale" });
    expect(row(first.store, id).status).toBe("approved");
    expect(row(first.store, id).stale_note).toBeNull();
  });

  test("applied + anchor_stale returns the entry to approved with the note, keeping the apply stamp", async () => {
    const id = await seed("stale-applied", "Retry");
    approve(first.store, id);
    await markApplied({ id, result: "applied" });
    const stamped = row(first.store, id).applied_at;
    expect(typeof stamped).toBe("number");

    const { body } = await markApplied({ id, result: "anchor_stale", found_text: "Try again" });
    expect(body.result?.isError).toBeUndefined();
    expect(body.result?.structuredContent).toEqual({ id, status: "approved" });

    const after = row(first.store, id);
    expect(after.status).toBe("approved");
    expect(after.stale_note).toBe("Try again");
    // Only the applied transition writes applied_at: a stale report leaves the stamp alone.
    expect(after.applied_at).toBe(stamped);
  });
});

describe("the refused transitions", () => {
  test("an unknown id is refused naming the id and the fix, for both results", async () => {
    for (const result of ["applied", "anchor_stale"]) {
      const { status, body } = await markApplied({ id: "00000000000000000000000000", result });
      expect(status).toBe(200);
      expect(body.error).toBeUndefined();
      expect(body.result?.isError).toBe(true);
      const text = body.result?.content?.[0]?.text ?? "";
      expect(text).toContain("00000000000000000000000000");
      expect(text).toContain("no such entry");
      expect(text).toContain("fix:");
    }
  });

  test("draft + applied is refused naming the draft status, and writes nothing", async () => {
    const id = await seed("refuse-draft-apply", "Draft anchor");
    const before = row(first.store, id);

    const { body } = await markApplied({ id, result: "applied" });
    expect(body.result?.isError).toBe(true);
    const text = body.result?.content?.[0]?.text ?? "";
    expect(text).toContain(id);
    expect(text).toContain("draft");
    expect(text).toContain("fix:");
    expectUnchanged(first.store, id, before);
  });

  test("draft + anchor_stale is refused naming the draft status, and writes nothing", async () => {
    const id = await seed("refuse-draft-stale", "Another draft");
    const before = row(first.store, id);

    const { body } = await markApplied({ id, result: "anchor_stale", found_text: "moved" });
    expect(body.result?.isError).toBe(true);
    const text = body.result?.content?.[0]?.text ?? "";
    expect(text).toContain(id);
    expect(text).toContain("draft");
    expect(text).toContain("fix:");
    expectUnchanged(first.store, id, before);
  });

  test("rejected + either result is refused naming rejected as terminal, and writes nothing", async () => {
    for (const [slug, result] of [
      ["refuse-rejected-apply", "applied"],
      ["refuse-rejected-stale", "anchor_stale"],
    ] as const) {
      const id = await seed(slug, slug);
      reject(first.store, id);
      const before = row(first.store, id);

      const { body } = await markApplied({ id, result });
      expect(body.result?.isError).toBe(true);
      const text = body.result?.content?.[0]?.text ?? "";
      expect(text).toContain(id);
      expect(text).toContain("rejected");
      expect(text).toContain("fix:");
      expectUnchanged(first.store, id, before);
    }
  });

  test("applied + applied is refused naming the applied status, and writes nothing", async () => {
    const id = await seed("refuse-applied-again", "Done");
    approve(first.store, id);
    await markApplied({ id, result: "applied" });
    const before = row(first.store, id);

    const { body } = await markApplied({ id, result: "applied" });
    expect(body.result?.isError).toBe(true);
    const text = body.result?.content?.[0]?.text ?? "";
    expect(text).toContain(id);
    expect(text).toContain("applied");
    expect(text).toContain("fix:");
    expectUnchanged(first.store, id, before);
  });

  test("applied_hash with anchor_stale is refused naming the field, and writes nothing", async () => {
    const id = await seed("refuse-hash-stale", "Submit");
    approve(first.store, id);
    const before = row(first.store, id);

    const { body } = await markApplied({ id, result: "anchor_stale", applied_hash: sha256("hash") });
    expect(body.result?.isError).toBe(true);
    const text = body.result?.content?.[0]?.text ?? "";
    expect(text).toContain(id);
    expect(text).toContain("applied_hash");
    expect(text).toContain("fix:");
    expectUnchanged(first.store, id, before);
  });
});

describe("the schema boundary", () => {
  test("a result outside the two enum values is refused", async () => {
    for (const bad of ["approved", "appliedd", "stale"]) {
      const { body } = await markApplied({ id: "whatever", result: bad });
      expect(body.result?.isError, bad).toBe(true);
      expect(body.result?.content?.[0]?.text ?? "").toContain("result");
    }
  });

  test("applied_hash must be sha256 as 64 lowercase hex characters", async () => {
    for (const bad of ["A".repeat(64), "a".repeat(63), "z".repeat(64)]) {
      const { body } = await markApplied({ id: "whatever", result: "applied", applied_hash: bad });
      expect(body.result?.isError, bad).toBe(true);
      expect(body.result?.content?.[0]?.text ?? "").toContain("applied_hash");
    }
  });

  test("an empty found_text is refused", async () => {
    const { body } = await markApplied({ id: "whatever", result: "anchor_stale", found_text: "" });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text ?? "").toContain("found_text");
  });
});

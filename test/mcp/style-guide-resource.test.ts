import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { Hono } from "hono";
import { loadConfig } from "../../src/config.ts";
import { upsertStyleGuide } from "../../src/db/style-guide.ts";
import { openStore } from "../../src/db/store.ts";
import { originGate } from "../../src/daemon/origin.ts";
import { mountMcp } from "../../src/mcp/route.ts";

const REVISION = "2026-07-28";

const META = {
  "io.modelcontextprotocol/protocolVersion": REVISION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "reviewzy-probe", version: "0" },
};

const PORT = 3200;

const STYLE_GUIDE_URI = "reviewzy://projects/{slug}/style-guide";

const tempDirs: string[] = [];

/** One app per suite-leg, holding the one store the daemon would hold; rows are seeded into that same store. */
function serveApp() {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-style-guide-resource-"));
  tempDirs.push(dir);
  const config = loadConfig({ REVIEWZY_DB: join(dir, "reviewzy.db"), REVIEWZY_PORT: String(PORT) });
  const store = openStore(config);

  const app = new Hono();
  app.use(originGate(config));
  mountMcp(app, config, store);

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return {
    store,
    call,
    close: () => {
      void server.stop(true);
      store.close();
    },
  };

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
      result?: {
        resultType?: string;
        resourceTemplates?: { name: string; uriTemplate: string; title?: string; description?: string; mimeType?: string }[];
        contents?: { uri: string; mimeType?: string; text: string }[];
        ttlMs?: number;
        cacheScope?: string;
      };
      error?: { code: number; message: string; data?: { uri?: string } };
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

/** A project row with a fixed id, so a later guide row can reference it without a join. */
function insertProject(slug: string): void {
  first.store.db.run("INSERT INTO projects (id, slug, created_at) VALUES (?, ?, ?)", [ulid(), slug, Date.now()]);
}

const readGuide = (slug: string) =>
  first.call("resources/read", { uri: `reviewzy://projects/${slug}/style-guide` }, `reviewzy://projects/${slug}/style-guide`);

describe("resources/templates/list", () => {
  test("advertises the style-guide template with the pinned uri, mime, and cache hint", async () => {
    const { status, body } = await first.call("resources/templates/list", {});

    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    const result = body.result;
    expect(result?.resultType).toBe("complete");
    expect(result?.resourceTemplates).toEqual([
      {
        name: "style-guide",
        uriTemplate: STYLE_GUIDE_URI,
        title: "Style guide",
        description:
          "The merged style guide for a project: the global guide, then the project's own rules below it, then the union of banned words and the glossary (a term defined in both resolves to the project). Read this before drafting any entry.",
        mimeType: "text/markdown",
      },
    ]);
    expect(result?.ttlMs).toBe(60_000);
    expect(result?.cacheScope).toBe("private");
  });
});

describe("resources/read", () => {
  test("returns the merged guide for a project with both rows, with the pinned cache hint", async () => {
    insertProject("app");
    upsertStyleGuide(first.store, null, {
      markdown: "Global rules.",
      bannedWords: ["awesome"],
      glossary: { widget: "a screen element" },
    });
    upsertStyleGuide(first.store, "app", {
      markdown: "Project rules.",
      bannedWords: ["utilize"],
      glossary: { widget: "the widget slot" },
    });

    const { status, body } = await readGuide("app");

    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    const result = body.result;
    expect(result?.resultType).toBe("complete");
    expect(result?.ttlMs).toBe(60_000);
    expect(result?.cacheScope).toBe("private");
    expect(result?.contents).toEqual([
      {
        uri: "reviewzy://projects/app/style-guide",
        mimeType: "text/markdown",
        text: "Global rules.\n\nProject rules.\n\n## banned\n- awesome\n- utilize\n\n## glossary\n- widget: the widget slot",
      },
    ]);
  });

  test("a project without a guide row reads the global guide alone", async () => {
    insertProject("solo");
    upsertStyleGuide(first.store, null, { markdown: "Global rules.", bannedWords: [], glossary: {} });

    const { body } = await readGuide("solo");

    expect(body.error).toBeUndefined();
    expect(body.result?.contents?.[0]?.text).toBe("Global rules.");
  });

  test("a project with no rows at all reads an empty guide", async () => {
    // Earlier legs seeded the shared store's global row; this leg's precondition is a store with
    // no guide rows at all.
    first.store.db.run("DELETE FROM style_guides");
    insertProject("bare");

    const { body } = await readGuide("bare");

    expect(body.error).toBeUndefined();
    expect(body.result?.contents?.[0]?.text).toBe("");
  });

  test("an unknown project slug answers resource-not-found and creates no project", async () => {
    const uri = "reviewzy://projects/nope/style-guide";
    const { status, body } = await first.call("resources/read", { uri }, uri);

    // The SDK's own answer for a handler-thrown ResourceNotFoundError: HTTP 200 with the
    // `-32602` envelope, measured over live http. The 400 rungs in the contract's error table
    // are envelope-level rejections, not handler-thrown protocol errors.
    expect(status).toBe(200);
    expect(body.result).toBeUndefined();
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toContain("nope");
    expect(body.error?.data?.uri).toBe(uri);
    const projects = first.store.db.query("SELECT id FROM projects WHERE slug = 'nope'").all();
    expect(projects).toEqual([]);
  });
});

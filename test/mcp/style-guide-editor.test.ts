import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { createApp } from "../../src/daemon/app.ts";
import { fileEntries } from "../../src/db/queries.ts";
import type { NewEntry } from "../../src/db/queries.ts";
import { openStore } from "../../src/db/store.ts";

/**
 * The queue task 15 acceptance test: an edit made in the dashboard editor must appear in the merged
 * style guide a real mcp client reads. One app serves both surfaces over real http, the same wire
 * pattern as `test/mcp/style-guide-resource.test.ts`; the editor edits go through the dashboard
 * route, the read through the mcp client.
 */

const REVISION = "2026-07-28";

const META = {
  "io.modelcontextprotocol/protocolVersion": REVISION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "reviewzy-probe", version: "0" },
};

const tempDirs: string[] = [];

function serveApp() {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-style-guide-editor-"));
  tempDirs.push(dir);
  const config = loadConfig({ REVIEWZY_DB: join(dir, "reviewzy.db") });
  const store = openStore(config);
  const app = createApp(config, store);
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  return {
    store,
    baseUrl,
    close: () => {
      void server.stop(true);
      store.close();
    },
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const FIXTURE: NewEntry = {
  repo: "https://example.com/org/repo.git",
  file: "docs/setup.md",
  anchorText: "Run bun install",
  anchorBefore: "Run this before anything else.",
  anchorAfter: "Then run the tests.",
  anchorHash: "h-accept",
  fileHash: "f-accept",
  agentDraft: "Fix the wording of the setup section.",
  contextJson: JSON.stringify({}),
  constraintsJson: JSON.stringify({}),
};

/** The save form the editor posts; `project` empty means the global section. */
function guideForm(over: { project?: string; markdown?: string; bannedWords?: string; glossary?: string } = {}): FormData {
  const form = new FormData();
  form.set("project", over.project ?? "");
  form.set("markdown", over.markdown ?? "");
  form.set("banned_words", over.bannedWords ?? "");
  form.set("glossary", over.glossary ?? "");
  return form;
}

/** One dashboard save, as the browser's plain no-JS form post would send it; manual redirect so the 303 Post/Redirect/Get status is observable instead of followed. */
function saveGuide(baseUrl: string, over: Parameters<typeof guideForm>[0]): Promise<Response> {
  return fetch(`${baseUrl}/style-guide/save`, { method: "POST", body: guideForm(over), redirect: "manual" });
}

/** One mcp request over the wire, the same envelope `test/mcp/style-guide-resource.test.ts` uses. */
async function call(baseUrl: string, method: string, params: Record<string, unknown>, name?: string) {
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
    result?: { contents?: { uri: string; mimeType?: string; text: string }[] };
  };
  return { status: response.status, body };
}

describe("the dashboard editor feeds the merged resource", () => {
  test("an edit saved through the dashboard route appears in the merged guide a real mcp client reads", async () => {
    const env = serveApp();
    try {
      // The project must exist for its section: a filing mints it, as it does in the real daemon.
      fileEntries(env.store, "alpha", "probe-agent", [FIXTURE]);

      // The editor saves the global section, then the alpha section.
      const global = await saveGuide(env.baseUrl, {
        markdown: "Global rules revised by the editor.",
        bannedWords: "awesome",
        glossary: "widget: a screen element",
      });
      expect(global.status).toBe(303);
      const project = await saveGuide(env.baseUrl, {
        project: "alpha",
        markdown: "Alpha rules revised by the editor.",
        bannedWords: "utilize, leverage",
        glossary: "widget: the widget slot\ncta: call to action",
      });
      expect(project.status).toBe(303);

      // A real mcp client reads the merged resource, exactly as an agent would.
      const { status, body } = await call(
        env.baseUrl,
        "resources/read",
        { uri: "reviewzy://projects/alpha/style-guide" },
        "reviewzy://projects/alpha/style-guide",
      );
      expect(status).toBe(200);
      expect(body.result?.contents).toEqual([
        {
          uri: "reviewzy://projects/alpha/style-guide",
          mimeType: "text/markdown",
          text: [
            "Global rules revised by the editor.",
            "",
            "Alpha rules revised by the editor.",
            "",
            "## banned",
            "- awesome",
            "- utilize",
            "- leverage",
            "",
            "## glossary",
            "- widget: the widget slot",
            "- cta: call to action",
          ].join("\n"),
        },
      ]);
    } finally {
      env.close();
    }
  });
});

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { loadConfig, startupWarnings } from "../../src/config.ts";
import { openStore } from "../../src/db/store.ts";
import type { Store } from "../../src/db/store.ts";
import { originGate } from "../../src/daemon/origin.ts";
import { mountMcp } from "../../src/mcp/route.ts";
import { Notifier } from "../../src/notify.ts";

const REVISION = "2026-07-28";

const META = {
  "io.modelcontextprotocol/protocolVersion": REVISION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "reviewzy-probe", version: "0" },
};

/** The advertised port dashboard_url carries; the actual bind is port 0, see `serve`. */
const PORT = 3199;

/** The injected debounce window: short enough to keep suites quick, long enough that 3-4 sequential loopback round-trips all land inside one window even while bun test runs other files alongside. */
const WINDOW_MS = 400;

/** Crockford base32, the alphabet ulid draws from: 26 chars, no I L O U. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

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
const stores: Store[] = [];
const apps: { close(): void }[] = [];
const endpoints: { received: Received[]; stop(): void }[] = [];

type Received = { method: string; headers: Headers; body: string };

/** A real http server standing in for one transport; every request is captured for assertions. */
function fakeEndpoint(respond: () => Response = () => new Response("ok")) {
  const received: Received[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      received.push({ method: req.method, headers: req.headers, body: await req.text() });
      return respond();
    },
  });
  const port = server.port;
  if (port === undefined) throw new Error("fake endpoint bound no tcp port");
  const endpoint = {
    url: `http://127.0.0.1:${port}`,
    received,
    stop: () => {
      void server.stop(true);
    },
  };
  endpoints.push(endpoint);
  return endpoint;
}

/** Both fakes reachable and captured, ready to be pointed at by a config. */
function armedFakes() {
  return { ntfy: fakeEndpoint(), webhook: fakeEndpoint() };
}

/**
 * One app per test, with its own notifier over the injected window: the mounting is the same
 * `file-entries.test.ts` performs (origin gate then mcp), plus the notifier `createApp` would
 * thread in the daemon.
 */
function serve(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-notify-"));
  tempDirs.push(dir);
  const config = loadConfig({ REVIEWZY_DB: join(dir, "reviewzy.db"), REVIEWZY_PORT: String(PORT), ...env });
  const store = openStore(config);
  stores.push(store);
  const notifier = new Notifier({ config, baseUrl: config.baseUrl, windowMs: WINDOW_MS });

  const app = new Hono();
  app.use(originGate(config));
  mountMcp(app, config, store, notifier);

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const port = server.port;
  if (port === undefined) throw new Error("app bound no tcp port");
  const baseUrl = `http://127.0.0.1:${port}`;
  const handle = { store, notifier, call, close: () => { void server.stop(true); store.close(); } };
  apps.push(handle);
  return handle;

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
      result?: WireResult;
      error?: { code: number; message: string };
    };
    return { status: response.status, body };
  }
}

afterAll(() => {
  for (const app of apps) app.close();
  for (const endpoint of endpoints) endpoint.stop();
  for (const store of stores) store.close();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** Polls until `probe` yields a value; the debounce means pings arrive at window end, never inline. */
async function waitFor<T>(probe: () => T | null | undefined, label: string, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value != null) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(10);
  }
}

/** Three full windows: long enough that a second, un-debounced ping would have landed. */
const settle = () => Bun.sleep(WINDOW_MS * 3);

const entry = (overrides: Record<string, unknown> = {}) => ({
  repo: "https://example.com/repo.git",
  file: "src/app.ts",
  anchor_text: "Click here to continue",
  agent_draft: "Continue",
  file_content: "line one\nClick here to continue\nline three\n",
  ...overrides,
});

const fileEntries = (app: ReturnType<typeof serve>, args: Record<string, unknown>) =>
  app.call("tools/call", { name: "file_entries", arguments: args }, "file_entries");

describe("filing notifications", () => {
  test("one filing pings both transports exactly once, with the ntfy headers and webhook body the contract pins", async () => {
    const { ntfy, webhook } = armedFakes();
    const app = serve({ NTFY_URL: ntfy.url, NTFY_TOPIC: "alerts", WEBHOOK_URL: webhook.url });

    const { status, body } = await fileEntries(app, {
      project: "app",
      entries: [entry(), entry({ file: "src/settings.ts", anchor_text: "Save changes now" })],
    });
    expect(status).toBe(200);
    expect(body.result?.isError).toBeUndefined();
    const out = body.result?.structuredContent as Result;
    expect(out.results).toHaveLength(2);

    const ntfyHit = await waitFor(() => ntfy.received[0], "the ntfy ping");
    const webhookHit = await waitFor(() => webhook.received[0], "the webhook ping");
    await settle();
    expect(ntfy.received).toHaveLength(1);
    expect(webhook.received).toHaveLength(1);

    expect(ntfyHit.method).toBe("POST");
    expect(ntfyHit.headers.get("topic")).toBe("alerts");
    expect(ntfyHit.headers.get("title")).toBe("reviewzy: app");
    expect(ntfyHit.headers.get("priority")).toBe("3");
    expect(ntfyHit.headers.get("click")).toBe(out.dashboard_url);
    expect(ntfyHit.body).toContain("app");
    expect(ntfyHit.body).toContain("2");

    expect(webhookHit.method).toBe("POST");
    expect(webhookHit.headers.get("content-type")).toBe("application/json");
    const parsed = JSON.parse(webhookHit.body) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["batch_id", "count", "dashboard_url", "project"]);
    expect(parsed.project).toBe("app");
    expect(parsed.batch_id).toBe(out.batch_id);
    expect(parsed.count).toBe(2);
    expect(parsed.dashboard_url).toBe(out.dashboard_url);
  });

  test("both transports unset keeps filing silent", async () => {
    const { ntfy, webhook } = armedFakes();
    const app = serve({});

    const { status, body } = await fileEntries(app, { project: "quiet", entries: [entry()] });
    expect(status).toBe(200);
    expect(body.result?.isError).toBeUndefined();

    await settle();
    expect(ntfy.received).toHaveLength(0);
    expect(webhook.received).toHaveLength(0);
  });

  test("a burst of rapid filings into one project collapses to one ping per transport, count summed, batch id the latest", async () => {
    const { ntfy, webhook } = armedFakes();
    const app = serve({ NTFY_URL: ntfy.url, NTFY_TOPIC: "alerts", WEBHOOK_URL: webhook.url });

    await fileEntries(app, { project: "burst", entries: [entry({ anchor_text: "First line" })] });
    await fileEntries(app, { project: "burst", entries: [entry({ anchor_text: "Second line" })] });
    const third = await fileEntries(app, { project: "burst", entries: [entry({ anchor_text: "Third line" })] });

    await waitFor(() => (webhook.received.length > 0 ? true : undefined), "the webhook ping");
    await settle();
    expect(webhook.received).toHaveLength(1);
    expect(ntfy.received).toHaveLength(1);

    const parsed = JSON.parse(webhook.received[0]!.body) as { count: number; batch_id: string };
    expect(parsed.count).toBe(3);
    expect(parsed.batch_id).toBe((third.body.result?.structuredContent as Result).batch_id);
  });

  test("interleaved projects debounce separately: one ping per project", async () => {
    const { ntfy, webhook } = armedFakes();
    const app = serve({ NTFY_URL: ntfy.url, NTFY_TOPIC: "alerts", WEBHOOK_URL: webhook.url });

    await fileEntries(app, { project: "app-a", entries: [entry({ anchor_text: "A one" })] });
    await fileEntries(app, { project: "app-b", entries: [entry({ anchor_text: "B one" })] });
    const lastA = await fileEntries(app, { project: "app-a", entries: [entry({ anchor_text: "A two" })] });
    await fileEntries(app, { project: "app-b", entries: [entry({ anchor_text: "B two" })] });

    await waitFor(() => (webhook.received.length >= 2 ? true : undefined), "two webhook pings");
    await settle();
    expect(webhook.received).toHaveLength(2);
    expect(ntfy.received).toHaveLength(2);

    const bodies = webhook.received.map((r) => JSON.parse(r.body)) as { project: string; count: number; batch_id: string }[];
    const a = bodies.find((b) => b.project === "app-a");
    const b = bodies.find((b) => b.project === "app-b");
    expect(a?.count).toBe(2);
    expect(b?.count).toBe(2);
    expect(a?.batch_id).toBe((lastA.body.result?.structuredContent as Result).batch_id);
    expect(ntfy.received.map((r) => r.headers.get("title")).sort()).toEqual(["reviewzy: app-a", "reviewzy: app-b"]);
  });

  test("a draft re-file overwriting in place pings, counting the updated entry", async () => {
    const { ntfy, webhook } = armedFakes();
    const app = serve({ NTFY_URL: ntfy.url, NTFY_TOPIC: "alerts", WEBHOOK_URL: webhook.url });

    const filed = await fileEntries(app, { project: "reword", entries: [entry()] });
    expect(filed.body.result?.isError).toBeUndefined();
    await waitFor(() => webhook.received[0], "the first filing's ping");
    await settle();

    const redone = await fileEntries(app, {
      project: "reword",
      entries: [entry({ agent_draft: "Keep going" })],
    });
    expect((redone.body.result?.structuredContent as Result).results[0]).toMatchObject({
      deduped: true,
      updated: true,
    });

    await waitFor(() => webhook.received[1], "the re-file's ping");
    await settle();
    expect(webhook.received).toHaveLength(2);
    expect(ntfy.received).toHaveLength(2);
    expect((JSON.parse(webhook.received[1]!.body) as { count: number }).count).toBe(1);
  });

  test("an all-dedupe no-op re-file stays silent", async () => {
    const { ntfy, webhook } = armedFakes();
    const app = serve({ NTFY_URL: ntfy.url, NTFY_TOPIC: "alerts", WEBHOOK_URL: webhook.url });

    const filed = await fileEntries(app, { project: "noop", entries: [entry()] });
    expect(filed.body.result?.isError).toBeUndefined();
    await waitFor(() => webhook.received[0], "the first filing's ping");
    await settle();

    const id = (filed.body.result?.structuredContent as Result).results[0]!.id;
    app.store.db.run("UPDATE entries SET status = 'approved' WHERE id = ?", [id]);

    const redone = await fileEntries(app, { project: "noop", entries: [entry({ agent_draft: "late draft" })] });
    expect((redone.body.result?.structuredContent as Result).results[0]).toMatchObject({
      deduped: true,
      updated: false,
    });

    await settle();
    expect(webhook.received).toHaveLength(1);
    expect(ntfy.received).toHaveLength(1);
  });

  test("a transport answering 500 leaves the file_entries result unchanged", async () => {
    const ntfy = fakeEndpoint();
    const webhook = fakeEndpoint(() => new Response("boom", { status: 500 }));
    const app = serve({ NTFY_URL: ntfy.url, NTFY_TOPIC: "alerts", WEBHOOK_URL: webhook.url });

    const { status, body } = await fileEntries(app, {
      project: "flaky",
      entries: [entry(), entry({ file: "src/settings.ts", anchor_text: "Save changes now" })],
    });

    expect(status).toBe(200);
    expect(body.result?.isError).toBeUndefined();
    const out = body.result?.structuredContent as Result;
    expect(out.batch_id).toMatch(ULID);
    expect(out.results).toHaveLength(2);
    for (const r of out.results) {
      expect(r.status).toBe("draft");
      expect(r.deduped).toBe(false);
      expect(r.updated).toBe(false);
    }

    await waitFor(() => webhook.received[0], "the webhook request");
    await settle();
    expect(webhook.received).toHaveLength(1);
    expect(ntfy.received).toHaveLength(1);
  });

  test("NTFY_URL without NTFY_TOPIC leaves ntfy silent and the webhook unaffected", async () => {
    const ntfy = fakeEndpoint();
    const webhook = fakeEndpoint();
    const app = serve({ NTFY_URL: ntfy.url, WEBHOOK_URL: webhook.url });

    const { body } = await fileEntries(app, { project: "no-topic", entries: [entry()] });
    expect(body.result?.isError).toBeUndefined();

    const hit = await waitFor(() => webhook.received[0], "the webhook ping");
    await settle();
    expect(ntfy.received).toHaveLength(0);
    expect((JSON.parse(hit.body) as { project: string }).project).toBe("no-topic");
  });

  test("dispose cancels a pending debounce: no ping fires after", async () => {
    const { ntfy, webhook } = armedFakes();
    const app = serve({ NTFY_URL: ntfy.url, NTFY_TOPIC: "alerts", WEBHOOK_URL: webhook.url });

    const { body } = await fileEntries(app, { project: "doomed", entries: [entry()] });
    expect(body.result?.isError).toBeUndefined();
    app.notifier.dispose();

    await settle();
    expect(ntfy.received).toHaveLength(0);
    expect(webhook.received).toHaveLength(0);
  });

  test("a refused file_entries never pings", async () => {
    const { ntfy, webhook } = armedFakes();
    const app = serve({ NTFY_URL: ntfy.url, NTFY_TOPIC: "alerts", WEBHOOK_URL: webhook.url });

    const { body } = await fileEntries(app, {
      project: "refused",
      entries: [entry({ constraints: { max_len: "24" } })],
    });
    expect(body.result?.isError).toBe(true);

    await settle();
    expect(ntfy.received).toHaveLength(0);
    expect(webhook.received).toHaveLength(0);
  });

  test("startupWarnings flags an NTFY_URL with no topic, and stays quiet when both are set", () => {
    const urlOnly = loadConfig({ NTFY_URL: "https://ntfy.example" });
    const warning = startupWarnings(urlOnly).find((w) => w.includes("NTFY_TOPIC"));
    expect(warning).toBeString();
    expect(warning).toContain("NTFY_URL");

    const both = loadConfig({ NTFY_URL: "https://ntfy.example", NTFY_TOPIC: "alerts" });
    expect(startupWarnings(both).some((w) => w.toLowerCase().includes("ntfy"))).toBe(false);
  });
});

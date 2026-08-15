import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { HealthBody } from "../src/daemon/app.ts";
import { startDaemon } from "../src/daemon/main.ts";

// Read independently of `src/version.ts`, so the assertion cannot pass by importing its own answer.
const manifest = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
  name: string;
  version: string;
};

// A disposable temp path, so the suite never touches the operator's real REVIEWZY_DB.
const dbDir = mkdtempSync(join(tmpdir(), "reviewzy-daemon-test-"));

// Port 0 lets the kernel pick, so the suite never collides with a daemon already running here.
const { server, store } = startDaemon({
  ...loadConfig({}),
  REVIEWZY_PORT: 0,
  REVIEWZY_DB: join(dbDir, "reviewzy.db"),
});
afterAll(() => {
  void server.stop(true);
  store.close();
  rmSync(dbDir, { recursive: true, force: true });
});

test("the daemon boots and serves its version and pid on /health", async () => {
  const response = await fetch(`http://127.0.0.1:${server.port}/health`);
  expect(response.status).toBe(200);

  const body = (await response.json()) as HealthBody;
  expect(body.name).toBe(manifest.name);
  expect(body.version).toBe(manifest.version);
  expect(body.pid).toBe(process.pid);
  expect(body.nonce).toBeString();
  expect(Date.parse(body.startedAt)).not.toBeNaN();
});

test("the daemon binds loopback only", () => {
  expect(server.hostname).toBe("127.0.0.1");
});

test("startDaemon opens a migrated store", () => {
  const version = (store.db.query("PRAGMA user_version").get() as { user_version: number })
    .user_version;
  expect(version).toBeGreaterThan(0);
});

test("a failed bind closes the store it already opened, so the sqlite connection cannot leak", () => {
  // The shim race from docs/design.md: a daemon already holding the port is the expected
  // failure, and the boot under it must not leave a second store open on the db file.
  const blocker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy") });
  const dbPath = join(dbDir, "busy-port.db");
  const blockedPort = blocker.port;
  expect(blockedPort).toBeGreaterThan(0);

  expect(() =>
    startDaemon({ ...loadConfig({}), REVIEWZY_PORT: blockedPort!, REVIEWZY_DB: dbPath }),
  ).toThrow();

  // sqlite refuses to leave WAL while any other connection still holds the file open, so a
  // successful switch here is the proof the failed boot's store was closed.
  const probe = new Database(dbPath);
  probe.run("PRAGMA journal_mode = DELETE");
  expect((probe.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe(
    "delete",
  );
  probe.close();
  void blocker.stop(true);
});

describe("the drain route", () => {
  /** One short-lived daemon per case: draining is one-way, so a shared instance would couple the cases. */
  function withDrainDaemon(
    env: Record<string, string>,
    body: (port: number, drained: () => number) => Promise<void>,
  ): Promise<void> {
    const caseDir = mkdtempSync(join(tmpdir(), "reviewzy-drain-test-"));
    let drains = 0;
    const daemon = startDaemon(
      { ...loadConfig(env), REVIEWZY_PORT: 0, REVIEWZY_DB: join(caseDir, "reviewzy.db") },
      { onDrain: () => { drains += 1; } },
    );
    return body(daemon.server.port!, () => drains)
      .finally(() => {
        void daemon.server.stop(true);
        daemon.store.close();
        rmSync(caseDir, { recursive: true, force: true });
      });
  }

  test("answers 200, then refuses mcp posts with 503, and fires the drain hook once", async () => {
    await withDrainDaemon({}, async (port, drained) => {
      const response = await fetch(`http://127.0.0.1:${port}/drain`, { method: "POST" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "draining" });

      // The hook runs on a timer set after the response flushes; a beat makes its firing observable
      // without racing it.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(drained()).toBe(1);

      const refused = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 42, method: "tools/list", params: {} }),
      });
      expect(refused.status).toBe(503);
      const frame = (await refused.json()) as { id: number; error: { code: number; message: string } };
      expect(frame.error.code).toBe(-32000);
      expect(frame.error.message).toContain("draining");
      // The refusal must be correlatable: the request's own id echoes, never a bare null.
      expect(frame.id).toBe(42);

      // A notification has no id and JSON-RPC forbids answering one: it gets a bare empty 503.
      const notified = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 42 } }),
      });
      expect(notified.status).toBe(503);
      expect(await notified.text()).toBe("");
    });
  });

  test("a second drain while draining is idempotent", async () => {
    await withDrainDaemon({}, async (port, drained) => {
      const first = await fetch(`http://127.0.0.1:${port}/drain`, { method: "POST" });
      expect(first.status).toBe(200);
      const second = await fetch(`http://127.0.0.1:${port}/drain`, { method: "POST" });
      expect(second.status).toBe(200);
      expect(await second.json()).toEqual({ status: "draining" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(drained()).toBe(1);
    });
  });

  test("refuses a non-POST with 405 and names the one method it takes", async () => {
    await withDrainDaemon({}, async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/drain`, { method: "GET" });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    });
  });

  test("requires the bearer token when REVIEWZY_TOKEN is set, and serves it when sent", async () => {
    await withDrainDaemon({ REVIEWZY_TOKEN: "sekrit" }, async (port, drained) => {
      const missing = await fetch(`http://127.0.0.1:${port}/drain`, { method: "POST" });
      expect(missing.status).toBe(401);
      expect(missing.headers.get("www-authenticate")).toContain("invalid_token");

      const wrong = await fetch(`http://127.0.0.1:${port}/drain`, {
        method: "POST",
        headers: { authorization: "Bearer not-sekrit" },
      });
      expect(wrong.status).toBe(401);

      const right = await fetch(`http://127.0.0.1:${port}/drain`, {
        method: "POST",
        headers: { authorization: "Bearer sekrit" },
      });
      expect(right.status).toBe(200);
      expect(await right.json()).toEqual({ status: "draining" });
      expect(drained()).toBe(0); // the hook is on a timer; it has not fired yet at this point
    });
  });
});

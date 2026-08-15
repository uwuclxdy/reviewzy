import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
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

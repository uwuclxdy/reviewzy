import { afterAll, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import type { HealthBody } from "../src/daemon/app.ts";
import { startDaemon } from "../src/daemon/main.ts";

// Read independently of `src/version.ts`, so the assertion cannot pass by importing its own answer.
const manifest = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
  name: string;
  version: string;
};

// Port 0 lets the kernel pick, so the suite never collides with a daemon already running here.
const server = startDaemon({ ...loadConfig({}), REVIEWZY_PORT: 0 });
afterAll(() => void server.stop(true));

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

import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { isPidAlive, readLockfile } from "../../src/shim/lockfile.ts";

const bin = join(fileURLToPath(new URL("../..", import.meta.url)), "bin", "reviewzy");

const REVISION = "2026-07-28";
const DISCOVER = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "server/discover",
  params: {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": REVISION,
      "io.modelcontextprotocol/clientInfo": { name: "smoke", version: "0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
});
const NOTIFICATION = JSON.stringify({
  jsonrpc: "2.0",
  method: "notifications/cancelled",
  params: { requestId: 1 },
});

const scratch = mkdtempSync(join(tmpdir(), "reviewzy-endtoend-test-"));

afterAll(() => {
  // A failed assertion must not leak a daemon: every lockfile this suite wrote is swept.
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  for (const entry of readdirSync(scratch)) {
    const lock = readLockfile(join(scratch, entry, "reviewzy", "daemon.lock"));
    if (lock !== null && isPidAlive(lock.pid)) {
      try {
        process.kill(lock.pid, "SIGTERM");
      } catch {
        /* gone */
      }
    }
  }
  rmSync(scratch, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

test(
  "the published entrypoint bridges a request to the daemon and exits on stdin EOF",
  async () => {
    const dir = mkdtempSync(join(scratch, "case-"));
    const port = await freePort();
    const env = { ...process.env } as Record<string, string>;
    delete env.REVIEWZY_PORT;
    delete env.REVIEWZY_DB;
    delete env.REVIEWZY_TOKEN;
    delete env.REVIEWZY_BASE_URL;
    delete env.XDG_DATA_HOME;
    env.XDG_DATA_HOME = dir;
    env.REVIEWZY_PORT = String(port);
    env.REVIEWZY_DB = join(dir, "reviewzy.db");

    const child = spawn(process.execPath, ["run", bin], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stdin.write(`${DISCOVER}\n${NOTIFICATION}\n`);
    child.stdin.end();
    const code = await new Promise((resolve) => child.once("exit", resolve));
    expect(code).toBe(0);

    // Exactly one frame on stdout: the discover response. The notification gets none, and the
    // in-flight request survives the stdin EOF instead of being killed by the shim's exit.
    const frames = stdout.split("\n").filter((line) => line.trim() !== "");
    expect(frames).toHaveLength(1);
    const frame = JSON.parse(frames[0]!) as { id: number; result: { resultType: string } };
    expect(frame.id).toBe(1);
    expect(frame.result.resultType).toBe("complete");

    // The lockfile names the daemon the shim spawned, and the daemon outlives the shim.
    const lock = readLockfile(join(dir, "reviewzy", "daemon.lock"));
    expect(lock).not.toBeNull();
    expect(lock?.port).toBe(port);
    expect(isPidAlive(lock!.pid)).toBe(true);

    process.kill(lock!.pid, "SIGTERM");
    const deadline = Date.now() + 5_000;
    while (isPidAlive(lock!.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  },
  30_000,
);

  test(
    "a closed stdout drains to stdin EOF and exits 0 instead of crashing on EPIPE",
    async () => {
      const dir = mkdtempSync(join(scratch, "case-"));
      const port = await freePort();
      const env = { ...process.env } as Record<string, string>;
      delete env.REVIEWZY_PORT;
      delete env.REVIEWZY_DB;
      delete env.REVIEWZY_TOKEN;
      delete env.REVIEWZY_BASE_URL;
      delete env.XDG_DATA_HOME;
      env.XDG_DATA_HOME = dir;
      env.REVIEWZY_PORT = String(port);
      env.REVIEWZY_DB = join(dir, "reviewzy.db");

      const child = spawn(process.execPath, ["run", bin], { env, stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // Wait until the bridge is up, then vanish the reader: the next response write is an EPIPE.
      const boot = Date.now() + 15_000;
      while (!stderr.includes("bridging stdio") && Date.now() < boot) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(stderr).toContain("bridging stdio");
      child.stdout?.destroy();
      child.stdin.write(`${DISCOVER}\n`);

      // Keep stdin open across the EPIPE window: the write lands while the reader is gone, and
      // the shim must still be alive after it. Ending stdin earlier lets the EOF-exit race ahead
      // of the EPIPE delivery and hides a crash.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(child.exitCode).toBeNull();

      child.stdin.end();
      const code = await new Promise((resolve) => child.once("exit", resolve));
      expect(code).toBe(0);

      // Cleanup: the daemon the shim spawned is still up and must not leak.
      const lock = readLockfile(join(dir, "reviewzy", "daemon.lock"));
      if (lock !== null && isPidAlive(lock.pid)) {
        process.kill(lock.pid, "SIGTERM");
        const deadline = Date.now() + 5_000;
        while (isPidAlive(lock.pid) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    },
    30_000,
  );

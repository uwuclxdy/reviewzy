import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockfilePath, readLockfile } from "../../src/shim/lockfile.ts";

/**
 * The shim never re-ensures a dead daemon mid-session today: a drain or crash after session start
 * leaves every later call `-32603` until the session restarts. After the fix, the shim's forward
 * path re-runs the lockfile/health check (or `ensureDaemon`) when the fetch to `/mcp` fails to
 * connect, and the next call goes through against the new daemon.
 */

const REVISION = "2026-07-28";

// A port that was free a moment ago: bound, read, released. A stale listener from an earlier run
// can never wedge the lane.
const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 200 }) });
const PORT = portProbe.port;
portProbe.stop(true);

const tempRoot = mkdtempSync(join(tmpdir(), "reviewzy-reensure-"));
const childEnv: Record<string, string> = {
  HOME: tempRoot,
  XDG_DATA_HOME: join(tempRoot, "data"),
  REVIEWZY_PORT: String(PORT),
  REVIEWZY_DB: join(tempRoot, "reviewzy.db"),
  // An empty string is an unset variable to loadConfig: bun auto-loads the cwd's .env, so a dev
  // token there must not make the spawned daemon demand auth the drain probe never sends.
  REVIEWZY_TOKEN: "",
  TMPDIR: tempRoot,
  PATH: process.env.PATH ?? "",
};
const lock = lockfilePath({ XDG_DATA_HOME: childEnv.XDG_DATA_HOME });

const meta = {
  "io.modelcontextprotocol/protocolVersion": REVISION,
  "io.modelcontextprotocol/clientCapabilities": {},
};
const discover = (id: string) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "server/discover", params: { _meta: meta } });

const killed: number[] = [];
function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
    killed.push(pid);
  } catch {
    // Already gone.
  }
}

async function waitDead(pid: number, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** One line reader per shim stdout; each call waits for the next full line or fails loudly. */
function lineReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return async function readLine(id: string, deadlineMs: number): Promise<string> {
    const end = Date.now() + deadlineMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      for (;;) {
        const remaining = end - Date.now();
        if (remaining <= 0) throw new Error(`reviewzy-reensure test: timeout waiting for the reply to ${id}`);
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`reviewzy-reensure test: timeout waiting for the reply to ${id}`)), remaining);
          }),
        ]);
        if (chunk.done) throw new Error(`reviewzy-reensure test: stdout ended before the reply to ${id}`);
        buffer += decoder.decode(chunk.value, { stream: true });
        const nl = buffer.indexOf("\n");
        if (nl !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          return line;
        }
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

type Frame = { id?: unknown; result?: unknown; error?: { code?: number; message?: string } };

interface ShimSession {
  readLine(id: string, deadlineMs: number): Promise<string>;
  send(frame: string): void;
  close(): Promise<void>;
  pid: number;
}

function spawnShim(): ShimSession {
  const child = Bun.spawn([process.execPath, "bin/reviewzy"], {
    env: childEnv,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const readLine = lineReader(child.stdout);
  // Bun's stdin FileSink buffers writes; without an explicit flush the frame can sit unsent and the
  // shim never receives it.
  const send = (frame: string) => {
    child.stdin.write(frame);
    child.stdin.flush();
  };
  return {
    pid: child.pid,
    readLine,
    send,
    close: async () => {
      killPid(child.pid);
      void new Response(child.stderr).text();
    },
  };
}

afterAll(async () => {
  const current = readLockfile(lock);
  if (current !== null) killPid(current.pid);
  for (const pid of killed) {
    if (!(await waitDead(pid))) throw new Error(`reviewzy-reensure test: pid ${pid} survived cleanup`);
  }
  // A daemon spawned before the shim wrote the lockfile (a test deadline firing mid-boot) is
  // recorded nowhere; sweep /proc for processes whose sandboxed env names this file's temp dir.
  for (const pid of readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
    try {
      const env = readFileSync(`/proc/${pid}/environ`, "utf8");
      if (env.includes(`XDG_DATA_HOME=${tempRoot}`)) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    } catch {
      // The process vanished or its environ is unreadable; not ours to judge.
    }
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("the shim re-ensures a dead daemon mid-session", () => {
  test("a crashed daemon: the next forwarded call recovers against a new daemon, not -32603", async () => {
    const shim = spawnShim();
    try {
      shim.send(discover("boot-1") + "\n");
      const first = JSON.parse(await shim.readLine("boot-1", 10_000)) as Frame;
      expect(first.id).toBe("boot-1");
      expect(first.error).toBeUndefined();

      const before = readLockfile(lock);
      expect(before).not.toBeNull();
      killPid(before!.pid);
      expect(await waitDead(before!.pid)).toBe(true);

      shim.send(discover("boot-2") + "\n");
      const second = JSON.parse(await shim.readLine("boot-2", 12_000)) as Frame;
      expect(second.id).toBe("boot-2");
      expect(second.error).toBeUndefined();

      const after = readLockfile(lock);
      expect(after).not.toBeNull();
      expect(after!.pid).not.toBe(before!.pid);
    } finally {
      await shim.close();
    }
  }, 25_000);

  test("a drained daemon: the next forwarded call recovers the same way", async () => {
    const shim = spawnShim();
    try {
      shim.send(discover("drain-1") + "\n");
      const first = JSON.parse(await shim.readLine("drain-1", 10_000)) as Frame;
      expect(first.id).toBe("drain-1");
      expect(first.error).toBeUndefined();

      const before = readLockfile(lock);
      expect(before).not.toBeNull();
      const drained = await fetch(`http://127.0.0.1:${before!.port}/drain`, { method: "POST" });
      expect(drained.status).toBe(200);
      expect(await waitDead(before!.pid)).toBe(true);

      shim.send(discover("drain-2") + "\n");
      const second = JSON.parse(await shim.readLine("drain-2", 12_000)) as Frame;
      expect(second.id).toBe("drain-2");
      expect(second.error).toBeUndefined();

      const after = readLockfile(lock);
      expect(after).not.toBeNull();
      expect(after!.pid).not.toBe(before!.pid);
    } finally {
      await shim.close();
    }
  }, 25_000);
});

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { fileEntries, type NewEntry } from "../../src/db/queries.ts";
import { upsertStyleGuide } from "../../src/db/style-guide.ts";
import { openStore } from "../../src/db/store.ts";
import { startDaemon } from "../../src/daemon/main.ts";
import { spawnDetachedDaemon } from "../../src/shim/daemon.ts";
import { lockfilePath, writeLockfileAtomic } from "../../src/shim/lockfile.ts";

/**
 * The plugin's SessionStart hook: every session in a repo whose project has a style guide starts
 * with the merged guide already in context — no tool call needed. The slug is the repo directory
 * name (the `/reviewzy` command's default). A session in a repo with no guide, or with the daemon
 * down, carries nothing: empty stdout, exit 0.
 */

const tempDirs: string[] = [];
const hookDaemons: number[] = [];

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

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function draft(over: Partial<NewEntry> = {}): NewEntry {
  return {
    repo: "https://example.com/org/repo.git",
    file: "src/app.ts",
    title: null,
    tag: null,
    variant: null,
    anchorText: "anchor",
    anchorBefore: "",
    anchorAfter: "",
    anchorHash: "h-anchor",
    fileHash: "f-file",
    agentDraft: "a draft",
    contextJson: "{}",
    constraintsJson: "{}",
    imagesJson: null,
    ...over,
  };
}

/** Runs the hook script the way the harness would: hook input json on stdin, sandboxed env. */
function runHook(env: Record<string, string>, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, "hooks/session-start.ts"], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { HOME: env.HOME, XDG_DATA_HOME: env.XDG_DATA_HOME, REVIEWZY_TOKEN: env.REVIEWZY_TOKEN, TMPDIR: env.TMPDIR, PATH: process.env.PATH ?? "" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(JSON.stringify({ session_id: "s1", cwd, hook_event_name: "SessionStart" }));
  child.stdin.end();
  return child.exited.then(async (code) => ({
    code,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  }));
}

describe("the session-start style guide hook", () => {
  // One real daemon for the whole file; the lockfile points the hook at it.
  const dataDir = scratch("reviewzy-hook-data");
  const hookEnvDir = { HOME: dataDir, XDG_DATA_HOME: join(dataDir, "data"), TMPDIR: dataDir };
  const hookLock = lockfilePath({ XDG_DATA_HOME: hookEnvDir.XDG_DATA_HOME });

  const dbPath = join(dataDir, "reviewzy.db");
  const daemon = startDaemon({ ...loadConfig({ REVIEWZY_DB: dbPath }), REVIEWZY_PORT: 0 });

  afterAll(async () => {
    void daemon.server.stop(true);
    daemon.store.close();
    for (const pid of hookDaemons) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      if (!(await waitDead(pid))) throw new Error(`reviewzy-session-hook test: daemon pid ${pid} survived cleanup`);
    }
    while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  test("the daemon serves the merged guide of a project at /style-guide.md", async () => {
    const slug = "hooked";
    fileEntries(daemon.store, slug, null, [draft()]);
    upsertStyleGuide(daemon.store, null, { markdown: "Global rules first.", bannedWords: [], glossary: {} });
    upsertStyleGuide(daemon.store, slug, { markdown: "Project rules second.", bannedWords: ["utilize"], glossary: {} });
    fileEntries(daemon.store, "no-guide-project", null, [draft()]);

    const base = `http://127.0.0.1:${daemon.server.port}`;
    const response = await fetch(`${base}/style-guide.md?project=${slug}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    const body = await response.text();
    expect(body).toContain("Global rules first.");
    expect(body).toContain("Project rules second.");

    const empty = await fetch(`${base}/style-guide.md?project=no-guide-project`);
    // The project exists (an entry was filed into it above); it carries no guide content of its
    // own, so the route answers 204 and the hook stays silent even with a global guide present.
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");

    const ghost = await fetch(`${base}/style-guide.md?project=ghost`);
    expect(ghost.status).toBe(404);

    const missing = await fetch(`${base}/style-guide.md`);
    expect(missing.status).toBe(400);
  });

  test("the route demands the bearer token when REVIEWZY_TOKEN is set, like /mcp and /drain", async () => {
    const token = "hook-test-token";
    const guarded = startDaemon({
      ...loadConfig({ REVIEWZY_DB: join(dataDir, "guarded.db"), REVIEWZY_TOKEN: token }),
      REVIEWZY_PORT: 0,
    });
    fileEntries(guarded.store, "any", null, [draft()]);
    try {
      const denied = await fetch(`http://127.0.0.1:${guarded.server.port}/style-guide.md?project=any`);
      expect(denied.status).toBe(401);
      const allowed = await fetch(`http://127.0.0.1:${guarded.server.port}/style-guide.md?project=any`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(allowed.status).toBe(204);
    } finally {
      void guarded.server.stop(true);
      guarded.store.close();
    }
  });

  test("a session in a repo whose project has a guide starts with the merged guide in context", async () => {
    const repoDir = scratch("hooked-repo");
    const slug = repoDir.split("/").pop()!;
    // liveDaemon rejects a lockfile naming the in-process app (the test runner's own cmdline has no
    // daemon tail), so the injection leg boots a real detached daemon the way the shim does.
    const dbPath = join(dataDir, "hooked-daemon.db");
    const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 200 }) });
    const daemonPort = portProbe.port!;
    portProbe.stop(true);
    const bootPid = spawnDetachedDaemon(
      { ...hookEnvDir, REVIEWZY_PORT: String(daemonPort), REVIEWZY_DB: dbPath, REVIEWZY_TOKEN: "", PATH: process.env.PATH ?? "" },
      hookLock,
    );
    const health = await (async () => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        try {
          const body = (await (await fetch(`http://127.0.0.1:${daemonPort}/health`)).json()) as { pid?: number; nonce?: string };
          if (body.pid === bootPid && typeof body.nonce === "string") return body as { pid: number; nonce: string };
        } catch {
          // Not up yet.
        }
        if (Date.now() > deadline) throw new Error("the booting daemon never answered /health");
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
    writeLockfileAtomic(hookLock, { pid: health.pid, port: daemonPort, version: "0.0.0-test", nonce: health.nonce });
    hookDaemons.push(health.pid);

    // Seed through a second connection: the daemon already ran the migrations on its own open db.
    const store = openStore(loadConfig({ REVIEWZY_DB: dbPath }));
    fileEntries(store, slug, null, [draft()]);
    upsertStyleGuide(store, slug, { markdown: "Hooked project rules.", bannedWords: [], glossary: {} });
    store.close();

    const run = await runHook(hookEnvDir, repoDir);
    expect(run.code).toBe(0);
    const parsed = JSON.parse(run.stdout) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("Hooked project rules.");
  });

  test("a repo whose project has no guide injects nothing", async () => {
    const repoDir = scratch("bare-repo");
    const slug = repoDir.split("/").pop()!;
    fileEntries(daemon.store, slug, null, [draft()]);

    const run = await runHook(hookEnvDir, repoDir);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
  });

  test("a dead daemon injects nothing and exits 0", async () => {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 200 }) });
    const deadPort = probe.port!;
    void probe.stop(true);
    writeLockfileAtomic(hookLock, { pid: process.pid, port: deadPort, version: "0.0.0-test", nonce: "stale" });

    const repoDir = scratch("dead-daemon-repo");
    const run = await runHook(hookEnvDir, repoDir);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
  });
});

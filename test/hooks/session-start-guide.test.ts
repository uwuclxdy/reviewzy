import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { fileEntries, type NewEntry } from "../../src/db/queries.ts";
import { upsertStyleGuide } from "../../src/db/style-guide.ts";
import { openStore, type Store } from "../../src/db/store.ts";
import { startDaemon } from "../../src/daemon/main.ts";
import { fetchHealth, spawnDetachedDaemon, type Health } from "../../src/shim/daemon.ts";
import { isPidAlive, lockfilePath, writeLockfileAtomic } from "../../src/shim/lockfile.ts";
import { NAME } from "../../src/version.ts";

/**
 * The session-start style guide surface: `GET /style-guide.md` on the daemon's un-gated layer and
 * the plugin hook that turns it into SessionStart context. The hook runs the way the manifest
 * wires it, `bun hooks/session-start.ts` from the plugin root, so the spawn here resolves the
 * plugin-root script, not a path relative to this test's own directory.
 *
 * The hook's discovery is the shim's `liveDaemon`, which reads the lockfile pid's cmdline for the
 * daemon entry path. An in-process `startDaemon` runs inside the test runner, whose argv names no
 * daemon, so a lockfile naming the test runner is never adopted: every hook run that expects
 * injection boots a real detached daemon the way the shim does, with the lockfile written from
 * that daemon's own `/health`.
 */

const tempDirs: string[] = [];

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function draft(): NewEntry {
  return {
    repo: "https://example.com/org/repo.git",
    file: "src/app.ts",
    title: null,
    tag: null,
    anchorText: "anchor",
    anchorBefore: "",
    anchorAfter: "",
    anchorHash: "h-anchor",
    fileHash: "f-file",
    agentDraft: "a draft",
    contextJson: "{}",
    constraintsJson: "{}",
    imagesJson: null,
  };
}

const pluginRoot = join(import.meta.dir, "..", "..");

type HookResult = { code: number | null; stdout: string; stderr: string };

/** Spawns the hook with a fully explicit env, so nothing leaks in from the test runner's own. */
function spawnHook(env: Record<string, string>, stdinPayload: string): Promise<HookResult> {
  const child = Bun.spawn([process.execPath, "hooks/session-start.ts"], {
    cwd: pluginRoot,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(stdinPayload);
  child.stdin.end();
  return child.exited.then(async (code) => ({
    code,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  }));
}

function hookEnv(dataDir: string, token?: string): Record<string, string> {
  const env: Record<string, string> = {
    HOME: dataDir,
    XDG_DATA_HOME: dataDir,
    TMPDIR: dataDir,
    PATH: process.env.PATH ?? "",
  };
  if (token !== undefined) env.REVIEWZY_TOKEN = token;
  return env;
}

function hookPayload(cwd: string): string {
  return JSON.stringify({ session_id: "s1", cwd, hook_event_name: "SessionStart" });
}

/** Runs the hook the way the harness would: input json on stdin, a sandboxed env, plugin-root cwd. */
function runHook(dataDir: string, cwd: string, token?: string): Promise<HookResult> {
  return spawnHook(hookEnv(dataDir, token), hookPayload(cwd));
}

function runRawInput(dataDir: string, stdinPayload: string): Promise<HookResult> {
  return spawnHook(hookEnv(dataDir), stdinPayload);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Binds an ephemeral port, then frees it: a concrete port the next bind almost certainly gets. */
async function reservePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 200 }) });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

type TestDaemon = { pid: number; port: number; health: Health; dataDir: string };

/**
 * Boots a daemon the way the shim does: the shim's own detached spawn, then the boot waited out
 * against the spawned pid and the lockfile written from that daemon's real `/health` — so the
 * recorded pid, port, version and nonce are the serving process's own, the only lockfile shape
 * `liveDaemon` adopts. A boot that dies takes its `daemon.log` into the error, since the sandbox
 * dirs this suite deletes are the only place it lands.
 */
async function bootTestDaemon(dataDir: string, extraEnv: Record<string, string> = {}): Promise<TestDaemon> {
  const lockPath = lockfilePath({ XDG_DATA_HOME: dataDir });
  const port = await reservePort();
  const pid = spawnDetachedDaemon(
    {
      HOME: dataDir,
      XDG_DATA_HOME: dataDir,
      TMPDIR: dataDir,
      REVIEWZY_DB: join(dataDir, "reviewzy.db"),
      REVIEWZY_PORT: String(port),
      PATH: process.env.PATH ?? "",
      ...extraEnv,
    },
    lockPath,
  );

  const deadline = Date.now() + 10_000;
  for (;;) {
    const health = await fetchHealth(port);
    if (health !== null && health.name === NAME && health.pid === pid) {
      writeLockfileAtomic(lockPath, { pid: health.pid, port, version: health.version, nonce: health.nonce });
      return { pid, port, health, dataDir };
    }
    if (!isPidAlive(pid) || Date.now() > deadline) {
      let log = "";
      try {
        log = readFileSync(join(dirname(lockPath), "daemon.log"), "utf8");
      } catch {
        log = "(daemon.log unreadable)";
      }
      throw new Error(
        `reviewzy test daemon pid ${pid} ${isPidAlive(pid) ? "never answered" : "died before answering"} /health on port ${port}\ndaemon.log: ${log}`,
      );
    }
    await sleep(50);
  }
}

/** Writes the db before the daemon boots: the daemon is another process and opens it at start. */
function seedGuide(dbPath: string, seed: (store: Store) => void): void {
  const store = openStore(loadConfig({ REVIEWZY_DB: dbPath }));
  try {
    seed(store);
  } finally {
    store.close();
  }
}

const dataDir = scratch("reviewzy-hook-data");
const dbPath = join(dataDir, "reviewzy.db");
const daemon = startDaemon({ ...loadConfig({ REVIEWZY_DB: dbPath }), REVIEWZY_PORT: 0 });

afterAll(async () => {
  void daemon.server.stop(true);
  daemon.store.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("the /style-guide.md route", () => {
  test("serves the merged guide of a project that has one", async () => {
    fileEntries(daemon.store, "routed", null, [draft()]);
    upsertStyleGuide(daemon.store, null, { markdown: "Global rules first.", bannedWords: [], glossary: {} });
    upsertStyleGuide(daemon.store, "routed", { markdown: "Project rules second.", bannedWords: ["utilize"], glossary: {} });

    const response = await fetch(`http://127.0.0.1:${daemon.server.port}/style-guide.md?project=routed`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    const body = await response.text();
    expect(body).toContain("Global rules first.");
    expect(body).toContain("Project rules second.");
  });

  test("a project without its own guide gets 204, even with a global guide in the store", async () => {
    fileEntries(daemon.store, "guideless", null, [draft()]);

    const response = await fetch(`http://127.0.0.1:${daemon.server.port}/style-guide.md?project=guideless`);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  test("a guide row saved with no content of its own serves nothing, global row or not", async () => {
    fileEntries(daemon.store, "empty-guide", null, [draft()]);
    upsertStyleGuide(daemon.store, "empty-guide", { markdown: "", bannedWords: [], glossary: {} });

    const response = await fetch(`http://127.0.0.1:${daemon.server.port}/style-guide.md?project=empty-guide`);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  test("an unknown project is a 404 and a missing project param a 400", async () => {
    const ghost = await fetch(`http://127.0.0.1:${daemon.server.port}/style-guide.md?project=ghost`);
    expect(ghost.status).toBe(404);

    const missing = await fetch(`http://127.0.0.1:${daemon.server.port}/style-guide.md`);
    expect(missing.status).toBe(400);
  });
});

describe("the route's bearer rule beside the dashboard's login gate", () => {
  const guardedDataDir = scratch("reviewzy-hook-guarded");
  const guarded = startDaemon({
    ...loadConfig({
      REVIEWZY_DB: join(guardedDataDir, "guarded.db"),
      REVIEWZY_TOKEN: "hook-test-token",
      DASHBOARD_PASSWORD: "hook-test-password",
    }),
    REVIEWZY_PORT: 0,
  });

  afterAll(() => {
    void guarded.server.stop(true);
    guarded.store.close();
  });

  test("demands the sdk's bearer challenge, and the token alone unlocks the un-gated route", async () => {
    fileEntries(guarded.store, "guarded", null, [draft()]);

    const denied = await fetch(`http://127.0.0.1:${guarded.server.port}/style-guide.md?project=guarded`);
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain('Bearer error="invalid_token"');

    const wrong = await fetch(`http://127.0.0.1:${guarded.server.port}/style-guide.md?project=guarded`, {
      headers: { authorization: "Bearer not-the-token" },
    });
    expect(wrong.status).toBe(401);

    // A DASHBOARD_PASSWORD is set on this daemon: a 303 here would mean the route sits inside the
    // login-gated dashboard mount instead of beside /health and /drain.
    const allowed = await fetch(`http://127.0.0.1:${guarded.server.port}/style-guide.md?project=guarded`, {
      headers: { authorization: "Bearer hook-test-token" },
      redirect: "manual",
    });
    expect(allowed.status).toBe(204);
  });
});

describe("the session-start hook", () => {
  const hookedRepo = scratch("hooked-live-repo");
  const bareRepo = scratch("bare-live-repo");
  const spacedBase = scratch("spaced-live-base");
  const spacedRepo = join(spacedBase, "my repo");
  mkdirSync(spacedRepo, { recursive: true });
  const guardedRepo = scratch("guarded-live-repo");

  let plain: TestDaemon;
  let guarded: TestDaemon;
  const daemonPids: number[] = [];

  beforeAll(async () => {
    const plainDir = scratch("reviewzy-hook-plain");
    const guardedDir = scratch("reviewzy-hook-live-guarded");
    const hookedSlug = hookedRepo.split("/").pop()!;
    const bareSlug = bareRepo.split("/").pop()!;
    const guardedSlug = guardedRepo.split("/").pop()!;
    // The db each daemon opens is seeded inside the daemon's own data dir, before its boot: once
    // the daemon holds it, no second process may write these rows.
    seedGuide(join(plainDir, "reviewzy.db"), (store) => {
      fileEntries(store, hookedSlug, null, [draft()]);
      upsertStyleGuide(store, hookedSlug, { markdown: "Hooked project rules.", bannedWords: [], glossary: {} });
      fileEntries(store, bareSlug, null, [draft()]);
      fileEntries(store, "my repo", null, [draft()]);
      upsertStyleGuide(store, "my repo", { markdown: "Spaced slug rules.", bannedWords: [], glossary: {} });
    });
    seedGuide(join(guardedDir, "reviewzy.db"), (store) => {
      fileEntries(store, guardedSlug, null, [draft()]);
      upsertStyleGuide(store, null, { markdown: "Guarded global rules.", bannedWords: [], glossary: {} });
      upsertStyleGuide(store, guardedSlug, { markdown: "Guarded live rules.", bannedWords: [], glossary: {} });
    });

    plain = await bootTestDaemon(plainDir);
    daemonPids.push(plain.pid);
    guarded = await bootTestDaemon(guardedDir, {
      REVIEWZY_TOKEN: "hook-live-token",
      DASHBOARD_PASSWORD: "hook-live-password",
    });
    daemonPids.push(guarded.pid);
  }, 30_000);

  afterAll(async () => {
    for (const pid of daemonPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone between spawn and here.
      }
    }
    const deadline = Date.now() + 5_000;
    while (daemonPids.some(isPidAlive)) {
      if (Date.now() > deadline) break;
      await sleep(25);
    }
    // Fail closed on a leaked daemon: a survivor outlives the sandbox dirs this file deletes.
    const survivors = daemonPids.filter(isPidAlive);
    expect(survivors).toEqual([]);
  });

  test("injects one json line with the merged guide for a repo whose project has one", async () => {
    const slug = hookedRepo.split("/").pop()!;
    const run = await runHook(plain.dataDir, hookedRepo);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");

    const lines = run.stdout.split("\n");
    expect(lines).toHaveLength(2);
    const parsed = JSON.parse(lines[0]!) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput?.additionalContext).toContain(`reviewzy style guide for ${slug}:`);
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("Hooked project rules.");
  });

  test("a repo whose project has no guide injects nothing", async () => {
    const run = await runHook(plain.dataDir, bareRepo);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  test("a stale lockfile naming a dead port injects nothing", async () => {
    const xdg = scratch("reviewzy-hook-xdg");
    writeLockfileAtomic(lockfilePath({ XDG_DATA_HOME: xdg }), {
      pid: plain.health.pid,
      port: await reservePort(),
      version: plain.health.version,
      nonce: plain.health.nonce,
    });

    const run = await runHook(xdg, hookedRepo);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  test("a missing lockfile injects nothing", async () => {
    const xdg = scratch("reviewzy-hook-empty-xdg");
    const run = await runHook(xdg, bareRepo);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  test("a slug with characters the query needs escaped rides the url untouched", async () => {
    const run = await runHook(plain.dataDir, spacedRepo);
    expect(run.code).toBe(0);
    const parsed = JSON.parse(run.stdout.split("\n")[0]!) as { hookSpecificOutput?: { additionalContext?: string } };
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("reviewzy style guide for my repo:");
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("Spaced slug rules.");
  });

  test("an impostor answering the lockfile's port receives no token and injects nothing", async () => {
    const seen: { path: string; authorization: string | undefined }[] = [];
    const impostor = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const url = new URL(request.url);
        seen.push({ path: url.pathname, authorization: request.headers.get("authorization") ?? undefined });
        if (url.pathname === "/health") {
          // Shape-valid for the bare /health check, yet not ours: a foreign name, a foreign pid,
          // a nonce the lockfile never recorded.
          return Response.json({
            name: "not-reviewzy",
            version: "9.9.9",
            pid: 999_999,
            nonce: "spoof-nonce",
            startedAt: new Date().toISOString(),
          } satisfies Health);
        }
        return new Response("SPOOFED GUIDE TEXT", { status: 200 });
      },
    });

    const xdg = scratch("reviewzy-hook-xdg");
    // The honest lockfile — the real daemon's pid and boot nonce — with only the port repointed at
    // the impostor: the spoof fails at the /health name/nonce rungs, the deepest checks, not at an
    // accident of the pid.
    writeLockfileAtomic(lockfilePath({ XDG_DATA_HOME: xdg }), {
      pid: plain.health.pid,
      port: impostor.port!,
      version: plain.health.version,
      nonce: plain.health.nonce,
    });

    const run = await runHook(xdg, hookedRepo, "hook-spoof-token");
    void impostor.stop(true);

    expect(seen.filter((request) => request.path === "/health").length).toBeGreaterThan(0);
    expect(seen.every((request) => request.authorization === undefined)).toBe(true);
    expect(seen.some((request) => request.path === "/style-guide.md")).toBe(false);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  test("carries the bearer token to a guarded daemon and injects the merged guide", async () => {
    const run = await runHook(guarded.dataDir, guardedRepo, "hook-live-token");
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
    const parsed = JSON.parse(run.stdout) as { hookSpecificOutput?: { additionalContext?: string } };
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("Guarded global rules.");
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("Guarded live rules.");
  });

  test("a wrong token to a guarded daemon injects nothing", async () => {
    const run = await runHook(guarded.dataDir, guardedRepo, "not-the-token");
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  describe("malformed hook stdin is silence", () => {
    // plain.dataDir holds a live daemon's valid lockfile, so any input that slipped past the
    // payload read would reach discovery: only silence here can be the read refusal itself.
    const cases: [string, string][] = [
      ["unparsable json stdin injects nothing", "not json at all"],
      ["a json non-object stdin injects nothing", "[1, 2]"],
      ["a payload without cwd injects nothing", JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart" })],
      ["an empty cwd injects nothing", JSON.stringify({ session_id: "s1", cwd: "", hook_event_name: "SessionStart" })],
    ];

    for (const [name, payload] of cases) {
      test(name, async () => {
        const run = await runRawInput(plain.dataDir, payload);
        expect(run.code).toBe(0);
        expect(run.stdout).toBe("");
        expect(run.stderr).toBe("");
      });
    }
  });
});

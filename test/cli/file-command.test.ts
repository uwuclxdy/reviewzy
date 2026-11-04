import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { openStore } from "../../src/db/store.ts";
import { lockfilePath, readLockfile } from "../../src/shim/lockfile.ts";

/**
 * The `reviewzy file <entries.json>` verb: a CLI that reads each entry's `file` from disk under its
 * `repo`, derives the file provenance itself (the one thing the mcp tool can never do — the server
 * never reads a repo), and files through the daemon's own `file_entries`, so anchor verification,
 * the re-file table, and the notifier all stay server-side. Output contract: one JSON line on
 * stdout (`batch_id`, `results[]`, `dashboard_url`), refusals on stderr with exit 1.
 */

const tempDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "reviewzy-cli-file-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * A port that was free a moment ago: bound, read, released — fresh per test case, so one case's
 * daemon can never be adopted by a later case's CLI (a shared port makes every case file into the
 * first case's store, and a store assertion against the wrong db can never fail).
 */
function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 200 }) });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

function sandboxEnv(workdir: string, port: number): Record<string, string> {
  return {
    REVIEWZY_PORT: String(port),
    REVIEWZY_DB: join(workdir, "reviewzy.db"),
    XDG_DATA_HOME: join(workdir, "data"),
    HOME: workdir,
    TMPDIR: workdir,
    PATH: process.env.PATH ?? "",
  };
}

/** A tiny repo on disk with two files the entries point at. */
function seedRepo(dir: string, name: string): string {
  const repo = join(dir, name);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "app.ts"), 'export const label = "Save changes";\nexport const other = "Discard";\n');
  writeFileSync(join(repo, "README.md"), "# demo\n\nRun bun install to start.\n");
  return repo;
}

/** A repo that carries a git remote, so the verb's repo-text resolution has a remote to prefer. */
function seedGitRepo(dir: string, name: string, remote: string): string {
  const repo = seedRepo(dir, name);
  const init = Bun.spawnSync(["git", "init", "-q", repo]);
  if (init.exitCode !== 0) throw new Error(`git init failed in ${repo}`);
  const add = Bun.spawnSync(["git", "-C", repo, "remote", "add", "origin", remote]);
  if (add.exitCode !== 0) throw new Error(`git remote add failed in ${repo}`);
  return repo;
}

/** Runs the published bin exactly as a user would, every path sandboxed away from the real HOME. */
function runCli(workdir: string, port: number, jsonPath: string, argv: string[] = ["file", jsonPath]) {
  const child = Bun.spawn([process.execPath, "bin/reviewzy", ...argv], {
    env: sandboxEnv(workdir, port),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return child.exited.then(async (code) => ({
    code,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  }));
}

type CliOutput = {
  batch_id: string;
  results: { id: string; status: string; deduped: boolean; updated: boolean }[];
  dashboard_url: string;
};

function writeJson(dir: string, name: string, body: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(body, null, 2));
  return path;
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

afterAll(async () => {
  // Every daemon the CLI ensured is recorded in the sandboxed lockfile; kill it fail-closed before
  // the temp dir goes away, so no spawned daemon outlives the test.
  for (const dir of tempDirs) {
    const lock = readLockfile(lockfilePath({ XDG_DATA_HOME: join(dir, "data") }));
    if (lock !== null) {
      try {
        process.kill(lock.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      if (!(await waitDead(lock.pid))) {
        throw new Error(`reviewzy-cli-file test: daemon pid ${lock.pid} survived cleanup`);
      }
    }
  }
  // A CLI killed between spawn and the lockfile write leaves a daemon the lockfile never names;
  // sweep /proc for processes whose sandboxed env names one of this file's temp dirs.
  for (const pid of readdirSync("/proc").filter((entry) => /^\d+$/.test(entry))) {
    try {
      const env = readFileSync(`/proc/${pid}/environ`, "utf8");
      if (tempDirs.some((dir) => env.includes(`XDG_DATA_HOME=${dir}`))) {
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
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("reviewzy file <entries.json>", () => {
  test("files entries from disk in one run: per-entry results plus the dashboard url, rows in the store", async () => {
    const dir = scratch();
    const port = freePort();
    const repo = seedRepo(dir, "repo");
    const json = writeJson(dir, "entries.json", {
      project: "cli-demo",
      filed_by: "cli-test",
      entries: [
        { repo, file: "src/app.ts", anchor_text: "Save changes", agent_draft: "Save your changes" },
        { repo, file: "src/app.ts", anchor_text: "Discard", agent_draft: "Discard your changes" },
        { repo, file: "README.md", anchor_text: "Run bun install to start.", agent_draft: "Run bun install first." },
      ],
    });

    const run = await runCli(dir, port, json);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);

    const out = JSON.parse(run.stdout) as CliOutput;
    expect(out.results).toHaveLength(3);
    expect(out.results.every((r) => r.deduped === false && r.status === "draft")).toBe(true);
    expect(out.dashboard_url).toContain("/?project=cli-demo");

    const store = openStore(loadConfig({ REVIEWZY_DB: join(dir, "reviewzy.db") }));
    try {
      const rows = store.db.query("SELECT COUNT(*) AS n FROM entries").get() as { n: number };
      expect(rows.n).toBe(3);
    } finally {
      store.close();
    }

    // The daemon-spawn narration the verb captures is a daemon.log record, never stderr noise.
    const log = readFileSync(join(dir, "data", "reviewzy", "daemon.log"), "utf8");
    expect(log).toContain("spawned daemon");
  });

  test("a 200-entry json across 30 files lands in one run, and a second run dedupes all 200", async () => {
    const dir = scratch();
    const port = freePort();
    const repo = seedRepo(dir, "scale-repo");

    const entries: { repo: string; file: string; anchor_text: string; agent_draft: string }[] = [];
    for (let n = 0; n < 200; n++) {
      const file = `src/f${Math.min(Math.floor((n * 30) / 200), 29)}.ts`;
      entries.push({ repo, file, anchor_text: `msg ${n}`, agent_draft: `Msg ${n}` });
    }
    const linesByFile = new Map<string, string[]>();
    for (const entry of entries) {
      const lines = linesByFile.get(entry.file) ?? [];
      lines.push(`const s = "${entry.anchor_text}";`);
      linesByFile.set(entry.file, lines);
    }
    expect(linesByFile.size).toBe(30);
    for (const [file, lines] of linesByFile) writeFileSync(join(repo, file), `${lines.join("\n")}\n`);

    const json = writeJson(dir, "scale.json", { project: "cli-scale", entries });
    const first = await runCli(dir, port, json);
    expect(first.stderr).toBe("");
    expect(first.code).toBe(0);
    const out = JSON.parse(first.stdout) as CliOutput;
    expect(out.results).toHaveLength(200);
    expect(out.results.every((r) => r.deduped === false)).toBe(true);

    const second = await runCli(dir, port, json);
    expect(second.code).toBe(0);
    const out2 = JSON.parse(second.stdout) as CliOutput;
    expect(out2.results).toHaveLength(200);
    expect(out2.results.every((r) => r.deduped === true && r.updated === true)).toBe(true);
  });

  test("a planted wrong anchor refuses by name, exit 1, nothing filed", async () => {
    const dir = scratch();
    const port = freePort();
    const repo = seedRepo(dir, "wrong-anchor-repo");
    const json = writeJson(dir, "wrong.json", {
      project: "cli-wrong",
      entries: [{ repo, file: "src/app.ts", anchor_text: "text that is not in the file", agent_draft: "x" }],
    });

    const run = await runCli(dir, port, json);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("entries[0]");
    expect(run.stderr).toContain("anchor_text not found");

    const store = openStore(loadConfig({ REVIEWZY_DB: join(dir, "reviewzy.db") }));
    try {
      const rows = store.db.query("SELECT COUNT(*) AS n FROM entries").get() as { n: number };
      expect(rows.n).toBe(0);
    } finally {
      store.close();
    }
  });

  test("a second run of the same json dedupes every entry", async () => {
    const dir = scratch();
    const port = freePort();
    const repo = seedRepo(dir, "dedupe-repo");
    const json = writeJson(dir, "dedupe.json", {
      project: "cli-dedupe",
      entries: [{ repo, file: "src/app.ts", anchor_text: "Save changes", agent_draft: "Save your changes" }],
    });

    const first = await runCli(dir, port, json);
    expect(first.code).toBe(0);
    const second = await runCli(dir, port, json);
    expect(second.code).toBe(0);
    const out = JSON.parse(second.stdout) as CliOutput;
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.deduped).toBe(true);
    expect(out.results[0]!.updated).toBe(true);
  });

  test("a repo that is not a local directory refuses by name, exit 1", async () => {
    const dir = scratch();
    const port = freePort();
    const json = writeJson(dir, "ghost.json", {
      project: "cli-ghost",
      entries: [{ repo: join(dir, "no-such-repo"), file: "src/app.ts", anchor_text: "Save changes", agent_draft: "x" }],
    });

    const run = await runCli(dir, port, json);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("no-such-repo");
  });

  test("wrong-arity file verbs are usage errors: exit 2, one usage line, nothing read or spawned", async () => {
    const dir = scratch();
    const port = freePort();
    for (const args of [["file"], ["file", "a", "b"]]) {
      const run = await runCli(dir, port, "", args);
      expect(run.code).toBe(2);
      expect(run.stderr).toBe("usage: reviewzy file <entries.json>\n");
      expect(run.stdout).toBe("");
    }
  });

  test("one call naming the same file under two different repos refuses: one provenance row would back both", async () => {
    const dir = scratch();
    const port = freePort();
    const repoA = seedRepo(dir, "repo-a");
    const repoB = seedRepo(dir, "repo-b");
    const json = writeJson(dir, "cross.json", {
      project: "cli-cross",
      entries: [
        { repo: repoA, file: "src/app.ts", anchor_text: "Save changes", agent_draft: "a" },
        { repo: repoB, file: "src/app.ts", anchor_text: "Save changes", agent_draft: "b" },
      ],
    });

    const run = await runCli(dir, port, json);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("entries[1]");
    expect(run.stderr).toContain("repo-a");
  });

  test("a hand-supplied file_hash is refused: the verb derives provenance from disk", async () => {
    const dir = scratch();
    const port = freePort();
    const repo = seedRepo(dir, "hash-repo");
    const json = writeJson(dir, "hash.json", {
      project: "cli-hash",
      entries: [{ repo, file: "src/app.ts", anchor_text: "Save changes", agent_draft: "x", file_hash: "a".repeat(64) }],
    });

    const run = await runCli(dir, port, json);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("file_hash");
    expect(run.stderr).toContain("derives provenance from disk");
  });

  test("an input file that is not valid json refuses by name, exit 1", async () => {
    const dir = scratch();
    const port = freePort();
    const path = join(dir, "broken.json");
    writeFileSync(path, "{oops");

    const run = await runCli(dir, port, path);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("not valid json");
  });

  test("a repo with a git remote files under the remote url, so cli filings dedupe against mcp filings", async () => {
    const dir = scratch();
    const port = freePort();
    const repo = seedGitRepo(dir, "remote-repo", "https://example.com/org/repo.git");
    const json = writeJson(dir, "remote.json", {
      project: "cli-remote",
      entries: [{ repo, file: "src/app.ts", anchor_text: "Save changes", agent_draft: "Save your changes" }],
    });

    const run = await runCli(dir, port, json);
    expect(run.code).toBe(0);

    const store = openStore(loadConfig({ REVIEWZY_DB: join(dir, "reviewzy.db") }));
    try {
      const row = store.db.query("SELECT repo FROM entries").get() as { repo: string };
      expect(row.repo).toBe("https://example.com/org/repo.git");
    } finally {
      store.close();
    }
  });

  test("an unwritable data home fails fast: exit 1 with the error on stderr", async () => {
    const dir = scratch();
    const port = freePort();
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "x");
    const repo = seedRepo(dir, "fail-repo");
    const json = writeJson(dir, "fail.json", {
      project: "cli-fail",
      entries: [{ repo, file: "src/app.ts", anchor_text: "Save changes", agent_draft: "x" }],
    });

    const child = Bun.spawn([process.execPath, "bin/reviewzy", "file", json], {
      env: { ...sandboxEnv(dir, port), XDG_DATA_HOME: blocker },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await child.exited;
    expect(code).toBe(1);
    const stderr = await new Response(child.stderr).text();
    expect(stderr).toContain("reviewzy");
    expect(await new Response(child.stdout).text()).toBe("");
  });
});

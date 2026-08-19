import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ensureDaemon, fetchHealth, spawnDetachedDaemon } from "../../src/shim/daemon.ts";
import type { DaemonHandle, Health } from "../../src/shim/daemon.ts";
import { isPidAlive, readLockfile, writeLockfileAtomic } from "../../src/shim/lockfile.ts";
import { forwardLine } from "../../src/shim/main.ts";
import { VERSION } from "../../src/version.ts";

const daemonEntry = join(fileURLToPath(new URL("../..", import.meta.url)), "src", "daemon", "main.ts");
const REVISION = "2026-07-28";
const DISCOVER = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "server/discover",
  params: {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": REVISION,
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
});

const scratch = mkdtempSync(join(tmpdir(), "reviewzy-shim-daemon-test-"));
/** Every real daemon this suite creates, directly or through `ensureDaemon`. */
const tracked = new Set<number>();
const track = (pid: number) => {
  tracked.add(pid);
  return pid;
};

/** A distinct XDG_DATA_HOME per case, so no two cases share a lockfile. */
function isolate() {
  const dir = mkdtempSync(join(scratch, "case-"));
  const lockfile = join(dir, "reviewzy", "daemon.lock");
  const env = (port: number, extra: Record<string, string> = {}): Record<string, string> => {
    const base = { ...process.env } as Record<string, string>;
    delete base.REVIEWZY_PORT;
    delete base.REVIEWZY_DB;
    delete base.REVIEWZY_TOKEN;
    delete base.REVIEWZY_BASE_URL;
    delete base.XDG_DATA_HOME;
    return {
      ...base,
      XDG_DATA_HOME: dir,
      REVIEWZY_PORT: String(port),
      REVIEWZY_DB: join(dir, `reviewzy-${port}.db`),
      ...extra,
    };
  };
  return { dir, lockfile, env };
}

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

type RealDaemon = { pid: number; exit: Promise<number | null> };

function spawnRealDaemon(env: Record<string, string>): RealDaemon {
  const child = spawn(process.execPath, ["run", daemonEntry], { env, stdio: ["ignore", "ignore", "pipe"], detached: true });
  child.on("error", (error) => console.error("daemon spawn failed:", error));
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { pid: track(child.pid!), exit };
}

async function waitHealthy(port: number, deadlineMs = 10_000): Promise<Health> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const health = await fetchHealth(port);
    if (health) return health;
    if (Date.now() > deadline) throw new Error(`daemon on port ${port} never became healthy`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Too-many direction of the singleton invariant: how many listeners hold the port right now. */
function listenersOn(port: number): number {
  const out = execSync(`ss -ltnH 'sport = :${port}'`, { encoding: "utf8" });
  return out.split("\n").filter((line) => line.trim() !== "").length;
}

afterAll(async () => {
  // Backstop: a test that fails before tracking its pid must still not leak a daemon. Every case
  // dir's lockfile names the daemon the suite spawned there, so sweep them all.
  const { readdirSync } = await import("node:fs");
  for (const entry of readdirSync(scratch)) {
    const lock = readLockfile(join(scratch, entry, "reviewzy", "daemon.lock"));
    if (lock !== null) tracked.add(lock.pid);
  }
  for (const pid of tracked) {
    if (!isPidAlive(pid)) continue;
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
  const deadline = Date.now() + 5_000;
  while ([...tracked].some(isPidAlive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const pid of tracked) {
    if (isPidAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
  rmSync(scratch, { recursive: true, force: true });
});

describe("ensureDaemon", () => {
  test(
    "spawns a daemon when no lockfile exists and records the serving identity",
    async () => {
      const { lockfile, env } = isolate();
      const port = await freePort();

      const handle = await ensureDaemon({ lockfile, port, shimVersion: VERSION, env: env(port) });
      track(handle.pid);

      expect(handle.pid).toBeGreaterThan(0);
      const health = await fetchHealth(port);
      expect(health).not.toBeNull();
      expect(health!.pid).toBe(handle.pid);
      expect(readLockfile(lockfile)).toEqual({
        pid: handle.pid,
        port,
        version: VERSION,
        nonce: health!.nonce,
      });
      expect(listenersOn(port)).toBe(1);
    },
    30_000,
  );

  test(
    "adopts the daemon a valid lockfile names, spawning nothing",
    async () => {
      const { lockfile, env } = isolate();
      const port = await freePort();
      const real = spawnRealDaemon(env(port));
      const health = await waitHealthy(port);
      expect(health.pid).toBe(real.pid);

      writeLockfileAtomic(lockfile, { pid: health.pid, port, version: health.version, nonce: health.nonce });
      let spawns = 0;
      const handle = await ensureDaemon({
        lockfile,
        port,
        shimVersion: VERSION,
        env: env(port),
        spawnDaemon: (childEnv) => {
          spawns += 1;
          return spawnDetachedDaemon(childEnv, lockfile);
        },
      });

      expect(spawns).toBe(0);
      expect(handle.pid).toBe(real.pid);
    },
    30_000,
  );

  test(
    "refuses to adopt a live foreign pid when its port spoofs /health, even with the name in argv and the nonce echoed",
    async () => {
      const { lockfile, env } = isolate();
      const port = await freePort();
      // The reviewer-measured exploit, full strength: a live foreign process whose argv mentions
      // "reviewzy" (passing any name-substring check), a port answering /health claiming that pid,
      // and a lockfile whose nonce the spoof echoes back.
      const foreign = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)", "reviewzy"], {
        stdio: "ignore",
      });
      const spoof = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch: () =>
          new Response(
            JSON.stringify({
              name: "reviewzy",
              version: VERSION,
              pid: foreign.pid,
              nonce: "n-spoof",
              startedAt: new Date().toISOString(),
            }),
          ),
      });
      let spawned = -1;
      try {
        writeLockfileAtomic(lockfile, {
          pid: foreign.pid!,
          port,
          version: VERSION,
          nonce: "n-spoof",
        });

        // The entry-path identity check is what refuses this: "reviewzy" in argv is not the
        // daemon's entry path, so the pid is foreign, the lockfile is stale, and the spawn cannot
        // bind the spoofed port. The incumbent fallback refuses the spoof for the same reason.
        await expect(
          ensureDaemon({
            lockfile,
            port,
            shimVersion: VERSION,
            env: env(port),
            spawnDaemon: (childEnv) => {
              spawned = spawnDetachedDaemon(childEnv, lockfile);
              tracked.add(spawned);
              return spawned;
            },
          }),
        ).rejects.toThrow(/never answered/);
        expect(isPidAlive(foreign.pid!)).toBe(true);
      } finally {
        void spoof.stop(true);
        foreign.kill();
        await new Promise((resolve) => foreign.once("exit", () => resolve(undefined)));
      }

      // The aborted spawn must not outlive the refusal: a child left booting binds the port the
      // moment the spoof releases it and orphans itself. The wait outlasts a full boot, so a
      // survivor cannot hide in startup latency.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(isPidAlive(spawned)).toBe(false);
    },
    30_000,
  );

  test(
    "a lockfile naming the right daemon with the wrong boot nonce is not adopted directly",
    async () => {
      const { lockfile, env } = isolate();
      const port = await freePort();
      const real = spawnRealDaemon(env(port));
      const health = await waitHealthy(port);
      let spawns = 0;
      writeLockfileAtomic(lockfile, { pid: health.pid, port, version: health.version, nonce: "wrong-nonce" });

      // The nonce rung forces the spawn path; the child dies on the real daemon's bind, and the
      // incumbent fallback re-adopts the real daemon, rewriting the lockfile with the real nonce.
      const handle = await ensureDaemon({
        lockfile,
        port,
        shimVersion: VERSION,
        env: env(port),
        spawnDaemon: (childEnv) => {
          spawns += 1;
          const pid = spawnDetachedDaemon(childEnv, lockfile);
          tracked.add(pid);
          return pid;
        },
      });

      expect(spawns).toBe(1);
      expect(handle.pid).toBe(real.pid);
      expect(readLockfile(lockfile)).toEqual({ pid: real.pid, port, version: VERSION, nonce: health.nonce });
    },
    30_000,
  );

  test(
    "a missing lockfile with a real daemon serving adopts it instead of erroring",
    async () => {
      const { lockfile, env } = isolate();
      const port = await freePort();
      const real = spawnRealDaemon(env(port));
      await waitHealthy(port);
      let spawns = 0;
      let child = -1;

      const handle = await ensureDaemon({
        lockfile,
        port,
        shimVersion: VERSION,
        env: env(port),
        spawnDaemon: (childEnv) => {
          spawns += 1;
          child = spawnDetachedDaemon(childEnv, lockfile);
          tracked.add(child);
          return child;
        },
      });

      expect(spawns).toBe(1); // the child died on the incumbent's bind; the incumbent is adopted
      expect(handle.pid).toBe(real.pid);
      expect(isPidAlive(real.pid)).toBe(true);
      expect(readLockfile(lockfile)?.pid).toBe(real.pid);

      // The aborted child must not outlive the adoption: kill the incumbent immediately and give
      // the child a full boot's grace. A survivor would bind the freed port and orphan itself —
      // no lockfile names it, and nothing ever reclaims it.
      process.kill(real.pid, "SIGTERM");
      expect(await real.exit).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(isPidAlive(child)).toBe(false);
      expect(listenersOn(port)).toBe(0);
    },
    30_000,
  );

  test(
    "a newer shim drains a lockfile-less incumbent before serving",
    async () => {
      const { lockfile, env } = isolate();
      const port = await freePort();
      const old = spawnRealDaemon(env(port));
      const oldHealth = await waitHealthy(port);
      let spawns = 0;

      const handle = await ensureDaemon({
        lockfile,
        port,
        shimVersion: "99.0.0",
        env: env(port),
        spawnDaemon: (childEnv) => {
          spawns += 1;
          const pid = spawnDetachedDaemon(childEnv, lockfile);
          tracked.add(pid);
          return pid;
        },
      });
      track(handle.pid);

      expect(await old.exit).toBe(0);
      // Two or three spawns, both legitimate: the bind-losing child, the replacement, and — when
      // the bind-losing child outlives the drain and steals the freed port — a third, because the
      // incumbent fallback drains the thief too. The invariant is the drain and one survivor.
      expect(spawns).toBeGreaterThanOrEqual(2);
      expect(handle.pid).not.toBe(oldHealth.pid);
      expect((await fetchHealth(port))?.pid).toBe(handle.pid);
      expect(listenersOn(port)).toBe(1);
    },
    45_000,
  );

  test(
    "replaces a lockfile whose pid is a live non-reviewzy process",
    async () => {
      const { lockfile, env } = isolate();
      const port = await freePort();
      const sleeper = spawn("sleep", ["300"], { stdio: "ignore" });
      try {
        writeLockfileAtomic(lockfile, { pid: sleeper.pid!, port, version: VERSION, nonce: "n-foreign" });

        const handle = await ensureDaemon({ lockfile, port, shimVersion: VERSION, env: env(port) });
        track(handle.pid);

        expect(handle.pid).not.toBe(sleeper.pid);
        expect(isPidAlive(sleeper.pid!)).toBe(true); // the foreign process is left alone
        expect(readLockfile(lockfile)?.pid).toBe(handle.pid);
      } finally {
        sleeper.kill();
      }
    },
    30_000,
  );

  test(
    "replaces a lockfile whose pid is dead",
    async () => {
      const { lockfile, env } = isolate();
      const port = await freePort();
      const dying = spawn("sleep", ["300"], { stdio: "ignore" });
      dying.kill();
      await new Promise((resolve) => dying.on("exit", resolve));
      writeLockfileAtomic(lockfile, { pid: dying.pid!, port, version: VERSION, nonce: "n-dead" });

      const handle = await ensureDaemon({ lockfile, port, shimVersion: VERSION, env: env(port) });
      track(handle.pid);
      expect(handle.pid).not.toBe(dying.pid);
      expect(readLockfile(lockfile)?.pid).toBe(handle.pid);
    },
    30_000,
  );

  test(
    "two concurrent ensureDaemon calls spawn exactly one daemon (forced overlap)",
    async () => {
      const { lockfile, env } = isolate();
      const port = await freePort();
      let spawns = 0;
      const counting = (childEnv: Record<string, string | undefined>) => {
        const pid = spawnDetachedDaemon(childEnv, lockfile);
        // Track at spawn time, not assertion time: a failing assertion must not leak the daemon.
        tracked.add(pid);
        spawns += 1;
        return pid;
      };

      // The winner holds the claim across a real multi-100ms health wait, so the loser is guaranteed
      // to find the claim held, not merely likely to: this is the forced overlap.
      const [a, b] = await Promise.all([
        ensureDaemon({ lockfile, port, shimVersion: VERSION, env: env(port), spawnDaemon: counting }),
        ensureDaemon({ lockfile, port, shimVersion: VERSION, env: env(port), spawnDaemon: counting }),
      ]);
      track(a.pid);
      track(b.pid);

      expect(spawns).toBe(1);
      expect(a.pid).toBe(b.pid);
      expect(readLockfile(lockfile)?.pid).toBe(a.pid);
      expect(listenersOn(port)).toBe(1);
    },
    30_000,
  );
});

describe("version handoff", () => {
  test(
    "a newer shim drains the old daemon, starts a new one, and loses no request",
    async () => {
      const { lockfile, env } = isolate();
      const port = await freePort();
      const old = spawnRealDaemon(env(port));
      const oldHealth = await waitHealthy(port);
      writeLockfileAtomic(lockfile, {
        pid: oldHealth.pid,
        port,
        version: oldHealth.version,
        nonce: oldHealth.nonce,
      });

      // A request fired while the drain runs: whatever ordering the handoff and the forward land
      // in, the request must get ITS frame back — the old daemon waits out in-flight requests, a
      // request arriving after the drain flag gets the 503 frame with its id echoed, and one after
      // the handoff is served by the new daemon. Silence is the only failure.
      const inFlight = forwardLine(DISCOVER, port);
      const handle = await ensureDaemon({
        lockfile,
        port,
        shimVersion: "99.0.0",
        env: env(port),
        spawnDaemon: (childEnv) => {
          const pid = spawnDetachedDaemon(childEnv, lockfile);
          tracked.add(pid);
          return pid;
        },
      });
      track(handle.pid);

      expect(await old.exit).toBe(0);
      expect(handle.pid).not.toBe(oldHealth.pid);
      expect((await fetchHealth(port))?.pid).toBe(handle.pid);
      expect(readLockfile(lockfile)).toEqual({
        pid: handle.pid,
        port,
        version: VERSION,
        nonce: (await fetchHealth(port))!.nonce,
      });

      const line = await inFlight;
      expect(line).not.toBeNull();
      expect((JSON.parse(line!) as { id: number }).id).toBe(1);

      // And the daemon the handoff produced answers the next request normally.
      const next = await forwardLine(DISCOVER, port);
      expect((JSON.parse(next!) as { id: number }).id).toBe(1);
    },
    45_000,
  );

  test(
    "an equal-version shim adopts the running daemon without draining it",
    async () => {
      const { lockfile, env } = isolate();
      const port = await freePort();
      const real = spawnRealDaemon(env(port));
      const health = await waitHealthy(port);
      writeLockfileAtomic(lockfile, { pid: health.pid, port, version: health.version, nonce: health.nonce });

      let spawns = 0;
      const handle = await ensureDaemon({
        lockfile,
        port,
        shimVersion: VERSION,
        env: env(port),
        spawnDaemon: (childEnv) => {
          spawns += 1;
          return spawnDetachedDaemon(childEnv, lockfile);
        },
      });

      expect(spawns).toBe(0);
      expect(handle.pid).toBe(real.pid);
      expect(isPidAlive(real.pid)).toBe(true);
    },
    30_000,
  );

  test(
    "dev mode drains an equal-version daemon and respawns a fresh one",
    async () => {
      const { lockfile, env } = isolate();
      const port = await freePort();
      const real = spawnRealDaemon(env(port));
      const health = await waitHealthy(port);
      writeLockfileAtomic(lockfile, { pid: health.pid, port, version: health.version, nonce: health.nonce });

      let spawns = 0;
      const handle = await ensureDaemon({
        lockfile,
        port,
        shimVersion: VERSION,
        dev: true,
        env: env(port),
        spawnDaemon: (childEnv) => {
          spawns += 1;
          const pid = spawnDetachedDaemon(childEnv, lockfile);
          tracked.add(pid);
          return pid;
        },
      });
      track(handle.pid);

      expect(spawns).toBe(1);
      expect(handle.pid).not.toBe(real.pid);
      expect(await real.exit).toBe(0);
      expect((await fetchHealth(port))?.pid).toBe(handle.pid);
      expect(listenersOn(port)).toBe(1);
    },
    45_000,
  );

  test(
    "a guarded daemon refuses a drain from the wrong bearer token and answers the right one",
    async () => {
      const { lockfile, env } = isolate();
      const port = await freePort();
      const real = spawnRealDaemon(env(port, { REVIEWZY_TOKEN: "sekrit" }));
      const health = await waitHealthy(port);
      writeLockfileAtomic(lockfile, { pid: health.pid, port, version: health.version, nonce: health.nonce });

      await expect(
        ensureDaemon({ lockfile, port, shimVersion: "99.0.0", token: "wrong", env: env(port, { REVIEWZY_TOKEN: "sekrit" }) }),
      ).rejects.toThrow(/drain/);
      expect(isPidAlive(real.pid)).toBe(true);

      const handle = await ensureDaemon({
        lockfile,
        port,
        shimVersion: "99.0.0",
        token: "sekrit",
        env: env(port),
        spawnDaemon: (childEnv) => {
          const pid = spawnDetachedDaemon(childEnv, lockfile);
          tracked.add(pid);
          return pid;
        },
      });
      track(handle.pid);
      expect(await real.exit).toBe(0);
      expect((await fetchHealth(port))?.pid).toBe(handle.pid);
    },
    45_000,
  );
});

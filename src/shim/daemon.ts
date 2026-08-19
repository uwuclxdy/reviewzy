import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NAME } from "../version.ts";
import {
  acquireClaim,
  claimHolderIsDead,
  isPidAlive,
  isReviewzyProcess,
  readLockfile,
  releaseClaim,
  writeLockfileAtomic,
  type Lockfile,
} from "./lockfile.ts";
import { compareSemver } from "./semver.ts";

export type Health = { name: string; version: string; pid: number; nonce: string; startedAt: string };
export type DaemonHandle = { pid: number; port: number; version: string };

/** A lifecycle failure a caller can tell apart from a bug: bad state on disk, not broken code. */
export class ShimError extends Error {
  override readonly name = "ShimError";
}

const HEALTH_POLL_MS = 50;
const HEALTH_BOOT_TIMEOUT_MS = 10_000;
const CLAIM_POLL_MS = 50;
const CLAIM_WAIT_MS = 15_000;
const DRAIN_EXIT_TIMEOUT_MS = 10_000;
const ATTEMPTS = 4;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const daemonEntry = fileURLToPath(new URL("../daemon/main.ts", import.meta.url));

/**
 * The daemon's `/health`, or null when nothing reviewzy-shaped answers on that port. This is the
 * authoritative liveness check: the pid and name in its body are what tie a lockfile entry to a
 * process that is really ours and really serving.
 */
export async function fetchHealth(port: number, timeoutMs = 1_500): Promise<Health | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as Partial<Health>;
    if (
      typeof body.name !== "string" ||
      typeof body.version !== "string" ||
      !Number.isInteger(body.pid) ||
      typeof body.nonce !== "string" ||
      typeof body.startedAt !== "string"
    ) {
      return null;
    }
    return body as Health;
  } catch {
    return null;
  }
}

/**
 * Spawns the daemon detached: the shim exits on stdin EOF while the daemon keeps serving, so the
 * child must never share the shim's life. stderr lands in `daemon.log` beside the lockfile — never
 * the shim's own stderr, which a stdio client may pipe and which must stay free of daemon noise.
 */
export function spawnDetachedDaemon(
  env: Record<string, string | undefined>,
  lockPath: string,
): number {
  const dataDir = dirname(lockPath);
  mkdirSync(dataDir, { recursive: true });
  const logFd = openSync(join(dataDir, "daemon.log"), "a");
  const child = spawn(process.execPath, ["run", daemonEntry], {
    env,
    detached: true,
    stdio: ["ignore", "ignore", logFd],
  });
  child.unref();
  if (child.pid === undefined) throw new ShimError("reviewzy: spawning the daemon produced no pid");
  console.error(`reviewzy: spawned daemon (pid ${child.pid})`);
  return child.pid;
}

/**
 * Waits until the process `childPid` spawned is the one answering /health on the port. Anything
 * else answering /health with our name (a spoof, or an incumbent daemon that beat the child to the
 * bind) ends the wait early with null, so the caller's fallback can decide instead of a spoof
 * riding a dead spawn into the lockfile.
 */
async function waitHealthy(port: number, timeoutMs: number, childPid: number): Promise<Health | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const health = await fetchHealth(port);
    if (health !== null && health.name === NAME) {
      if (health.pid === childPid) return health;
      return null;
    }
    if (Date.now() > deadline) return null;
    await sleep(HEALTH_POLL_MS);
  }
}

/** The daemon a valid lockfile names, when it is alive, ours, and actually serving its port. */
async function liveDaemon(lockPath: string): Promise<{ lock: Lockfile; health: Health } | null> {
  const lock = readLockfile(lockPath);
  if (lock === null) return null;
  if (!isPidAlive(lock.pid)) return null;
  if (!isReviewzyProcess(lock.pid)) return null;

  const health = await fetchHealth(lock.port);
  if (health === null || health.name !== NAME || health.pid !== lock.pid) return null;
  // The boot nonce ties this lockfile to the one boot it recorded: a port answered by another
  // process (or another boot's daemon) fails here, and a cross-user spoof cannot read the
  // lockfile to echo the value.
  if (health.nonce !== lock.nonce) return null;
  return { lock, health };
}

/**
 * Asks a running daemon to drain and waits out its exit. The daemon's exit frees the port, so a new
 * daemon cannot be started before this returns without stealing the old one's port out from under
 * in-flight requests.
 */
async function drainAndAwaitExit(lock: Lockfile, token: string | undefined): Promise<void> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${lock.port}/drain`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(2_000),
    });
  } catch (error) {
    throw new ShimError(
      `reviewzy: could not ask daemon pid ${lock.pid} to drain: ${(error as Error).message}`,
    );
  }
  if (response.status !== 200) {
    throw new ShimError(`reviewzy: daemon pid ${lock.pid} refused /drain with http ${response.status}`);
  }

  const deadline = Date.now() + DRAIN_EXIT_TIMEOUT_MS;
  while (isPidAlive(lock.pid)) {
    if (Date.now() > deadline) {
      throw new ShimError(
        `reviewzy: daemon pid ${lock.pid} did not exit within ${DRAIN_EXIT_TIMEOUT_MS}ms of draining`,
      );
    }
    await sleep(HEALTH_POLL_MS);
  }
}

/**
 * Waits for the claim to clear, sweeping it when its holder died mid-spawn (a shim killed between
 * acquiring and releasing would otherwise lock every future session out).
 */
async function waitForClaimRelease(lockPath: string): Promise<boolean> {
  const claim = `${lockPath}.claim`;
  const deadline = Date.now() + CLAIM_WAIT_MS;
  while (Date.now() < deadline) {
    if (!existsSync(claim)) return true;
    if (claimHolderIsDead(lockPath)) {
      try {
        rmSync(claim);
      } catch {
        // Another waiter swept it first; the existsSync above re-decides.
      }
      if (!existsSync(claim)) return true;
    }
    await sleep(CLAIM_POLL_MS);
  }
  return false;
}

export type EnsureDaemonOptions = {
  lockfile: string;
  /** The configured `REVIEWZY_PORT`: the port the daemon is spawned on and health-checked against. */
  port: number;
  /** The shim's own package version, compared semantically against the daemon's `/health` version. */
  shimVersion: string;
  /** Dev mode (`REVIEWZY_DEV=1`): drain and respawn even when the daemon's version is not older. */
  dev?: boolean | undefined;
  /** The bearer token for `/drain` and `/mcp` when `REVIEWZY_TOKEN` is set. */
  token?: string | undefined;
  /** The environment the spawned daemon inherits. */
  env: Record<string, string | undefined>;
  /** Overridable spawner, so tests can count spawns. Defaults to the real detached spawn. */
  spawnDaemon?: ((env: Record<string, string | undefined>, lockPath: string) => number) | undefined;
};

/**
 * Why the shim must drain the running daemon, or null when it may be adopted: the shim's version
 * outranks the daemon's (the production update handoff), or dev mode forces a reload so checkout
 * `src/` edits reach the daemon without a version bump.
 */
function drainReason(shimVersion: string, daemonVersion: string, dev: boolean): string | null {
  if (dev) return "dev mode reloads checkout source";
  const rank = compareSemver(shimVersion, daemonVersion);
  return rank !== null && rank > 0 ? `shim ${shimVersion} outranks daemon ${daemonVersion}` : null;
}

/**
 * Returns a live daemon handle, spawning or handshaking a handoff as needed:
 *
 * 1. A live, reviewzy-owned daemon named by a valid lockfile is adopted (and drained first, when
 *    the shim's version semantically outranks the daemon's, or when dev mode is set).
 * 2. Otherwise, under an exclusive claim, the shim re-checks for a live daemon (another shim may
 *    have finished while this one waited), spawns the daemon detached, waits for `/health`, and
 *    writes the lockfile from the health body — so the recorded pid is always the process that is
 *    actually serving, even when a racing spawn lost the port bind and its child died.
 */
export async function ensureDaemon(options: EnsureDaemonOptions): Promise<DaemonHandle> {
  const spawnDaemon = options.spawnDaemon ?? spawnDetachedDaemon;

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const live = await liveDaemon(options.lockfile);
    if (live !== null) {
      const reason = drainReason(options.shimVersion, live.health.version, options.dev === true);
      if (reason !== null) {
        console.error(`reviewzy: ${reason}; draining pid ${live.health.pid}`);
        await drainAndAwaitExit(live.lock, options.token);
        // Falls through to the spawn phase; the drained daemon is gone and cannot be adopted.
      } else {
        return { pid: live.health.pid, port: live.lock.port, version: live.health.version };
      }
    }

    if (!acquireClaim(options.lockfile)) {
      const cleared = await waitForClaimRelease(options.lockfile);
      if (!cleared) continue;
      // The winner may have finished while we waited; the next loop adopts its daemon, or retries.
      continue;
    }

    try {
      // Re-check under the claim: another shim can have completed between our first read and here.
      const raced = await liveDaemon(options.lockfile);
      if (raced !== null) {
        // The same version rung the adopt path applies: a raced daemon was fully booted before the
        // winning shim released the claim (release follows the health wait), so draining it here
        // cannot interrupt a boot.
        const reason = drainReason(options.shimVersion, raced.health.version, options.dev === true);
        if (reason !== null) {
          console.error(`reviewzy: ${reason}; draining pid ${raced.health.pid}`);
          await drainAndAwaitExit(raced.lock, options.token);
          // Falls through to the spawn phase; the claim is already ours.
        } else {
          return { pid: raced.health.pid, port: raced.lock.port, version: raced.health.version };
        }
      }

      const spawnAndVerify = async (): Promise<DaemonHandle> => {
        const childPid = spawnDaemon(options.env, options.lockfile);
        const health = await waitHealthy(options.port, HEALTH_BOOT_TIMEOUT_MS, childPid);
        if (health !== null) {
          writeLockfileAtomic(options.lockfile, {
            pid: health.pid,
            port: options.port,
            version: health.version,
            nonce: health.nonce,
          });
          console.error(`reviewzy: daemon ${health.version} ready (pid ${health.pid}, port ${options.port})`);
          return { pid: health.pid, port: options.port, version: health.version };
        }

        // The child is not the process answering the port, and it is ours. Kill it HERE, before any
        // branch can leave it behind: left booting, it binds the port the moment the blocker leaves
        // it and orphans itself — on the adoption branch nobody ever reclaims it, and on the drain
        // branch it becomes the thief the drain then has to drain.
        if (isPidAlive(childPid)) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            // Already gone between the check and the kill.
          }
        }

        // Either the bind was lost to an incumbent daemon the (missing or corrupt) lockfile never
        // named, or the child died on its own and a spoof or foreign process is answering. Only a
        // real reviewzy daemon gets the incumbent treatment — the same version rung the adopt path
        // applies, so a newer shim still drains it instead of bridging to an old daemon all session.
        const incumbent = await fetchHealth(options.port);
        if (
          incumbent !== null &&
          incumbent.name === NAME &&
          isReviewzyProcess(incumbent.pid) &&
          incumbent.pid !== childPid
        ) {
          const incumbentLock = {
            pid: incumbent.pid,
            port: options.port,
            version: incumbent.version,
            nonce: incumbent.nonce,
          };
          const reason = drainReason(options.shimVersion, incumbent.version, options.dev === true);
          if (reason !== null) {
            console.error(`reviewzy: ${reason}; draining pid ${incumbent.pid}`);
            await drainAndAwaitExit(incumbentLock, options.token);
            return spawnAndVerify();
          }
          writeLockfileAtomic(options.lockfile, incumbentLock);
          console.error(`reviewzy: adopted daemon ${incumbent.version} (pid ${incumbent.pid}, port ${options.port})`);
          return { pid: incumbent.pid, port: options.port, version: incumbent.version };
        }

        throw new ShimError(
          `reviewzy: the spawned daemon never answered /health on port ${options.port} within ${HEALTH_BOOT_TIMEOUT_MS}ms (see daemon.log beside the lockfile)`,
        );
      };
      return await spawnAndVerify();
    } finally {
      releaseClaim(options.lockfile);
    }
  }

  throw new ShimError(
    `reviewzy: could not establish a daemon on port ${options.port} after ${ATTEMPTS} attempts`,
  );
}

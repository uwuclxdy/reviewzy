import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Lockfile = { pid: number; port: number; version: string; nonce: string };

/**
 * The lockfile lives in the directory the db DEFAULTS to (`docs/design.md` lifecycle row), not
 * wherever `REVIEWZY_DB` points: the daemon's discovery point must stay fixed even when an operator
 * relocates the store, or two shims with different dbs would hunt two different lockfiles and both
 * spawn. Mirrors `defaultDbPath` in `src/config.ts`.
 */
export function lockfilePath(env: Record<string, string | undefined>): string {
  const dataRoot = env.XDG_DATA_HOME ?? join(env.HOME ?? homedir(), ".local", "share");
  return join(dataRoot, "reviewzy", "daemon.lock");
}

/**
 * Reads and validates the lockfile. Anything wrong reads as null (stale): a missing file, a
 * corrupt body, or a shape missing `pid`/`port`/`version`. Staleness of a WELL-FORMED lockfile is
 * decided by the caller from pid liveness, process identity, and `/health`.
 */
export function readLockfile(path: string): Lockfile | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const { pid, port, version, nonce } = parsed as Record<string, unknown>;
  if (!Number.isInteger(pid) || (pid as number) <= 0) return null;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) return null;
  if (typeof version !== "string") return null;
  // The nonce ties the lockfile to one daemon boot: adoption requires /health to carry it.
  if (typeof nonce !== "string") return null;
  return { pid: pid as number, port: port as number, version: version as string, nonce: nonce as string };
}

/**
 * Writes via `rename(2)` from a per-pid temp file in the same directory, so a reader never sees a
 * half-written lockfile and two racing writers each atomically land a complete document. Both
 * writers derive their content from the daemon's own `/health`, so whichever rename lands last,
 * the file names a daemon that is really serving.
 */
export function writeLockfileAtomic(path: string, lock: Lockfile): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(lock)}\n`);
  renameSync(temp, path);
}

/**
 * `kill(pid, 0)` probes without signalling. `EPERM` means the process exists but belongs to
 * another user: alive, which is the only question here.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Answers "could this pid be OUR daemon". The daemon's argv always embeds its entry path
 * (`reviewzy/src/daemon/main.ts`, in a repo checkout or under `node_modules/reviewzy`), and this
 * matches the entry path, not the name: a process that merely mentions "reviewzy" in its argv is
 * still foreign, or an editor with this repo open would read as a daemon. An unreadable cmdline
 * (no `/proc`, or the process vanished mid-read) reads as "could be ours": the caller's `/health`
 * check is the authoritative decision, and refusing here would drain a healthy daemon on a probe
 * hiccup.
 */
/** The real uid `/proc/<pid>/status` reports, or null when the file is unreadable. */
export function processUid(pid: number): number | null {
  try {
    const match = /^Uid:\s*(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

export function isReviewzyProcess(pid: number): boolean {
  let cmdline: string;
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return true;
  }
  if (!cmdline.includes("reviewzy/src/daemon/main.ts")) return false;

  // Cross-user defence: another local user can bind 127.0.0.1 and craft argv embedding the entry
  // path, and a spoof adopted on the lockfile-less incumbent path would receive the shim's bearer
  // token on /mcp. The daemon always runs as the shim's user, so a different uid is never ours.
  // An unreadable status keeps the cmdline verdict.
  const uid = processUid(pid);
  const ownUid = process.getuid?.();
  if (uid !== null && ownUid !== undefined && uid !== ownUid) return false;
  return true;
}

/**
 * One shim may spawn the daemon at a time, enforced by an exclusively-created claim file beside the
 * lockfile. `O_EXCL` is the whole mutex: no advisory locks to leak, and a crashed claimer is
 * detected by the pid it wrote into the claim.
 */
export function acquireClaim(lockPath: string): boolean {
  const claim = `${lockPath}.claim`;
  // The claim is the FIRST thing a fresh install ever writes here: no lockfile has created the
  // directory yet, so the claim creates it.
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    const fd = openSync(claim, "wx");
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export function releaseClaim(lockPath: string): void {
  rmSync(`${lockPath}.claim`, { force: true });
}

/**
 * True when the claim is safe to sweep: the shim that created it is gone, OR its content is
 * unparseable. A holder killed between `openSync(claim, "wx")` and `writeSync` leaves an empty or
 * partial file, and reading that as "still held" would wedge every future shim permanently.
 */
export function claimHolderIsDead(lockPath: string): boolean {
  try {
    const pid = Number.parseInt(readFileSync(`${lockPath}.claim`, "utf8").trim(), 10);
    if (Number.isNaN(pid)) return true;
    return !isPidAlive(pid);
  } catch {
    return false;
  }
}

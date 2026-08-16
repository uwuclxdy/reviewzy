import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireClaim,
  claimHolderIsDead,
  isPidAlive,
  isReviewzyProcess,
  lockfilePath,
  processUid,
  readLockfile,
  releaseClaim,
  writeLockfileAtomic,
  type Lockfile,
} from "../../src/shim/lockfile.ts";

const dataHome = mkdtempSync(join(tmpdir(), "reviewzy-lockfile-test-"));

const lock = join(dataHome, "daemon.lock");
const valid: Lockfile = { pid: 4242, port: 3123, version: "0.1.0", nonce: "n-test" };

// Every staleness rule needs a pid whose liveness is pinned, never assumed: `foreign` is a live
// non-reviewzy process, and `deadPid` belongs to a process that already exited.
const foreign = spawn("sleep", ["300"], { stdio: "ignore" });
const dying = spawn("sleep", ["300"], { stdio: "ignore" });
dying.kill();
const deadPid = dying.pid ?? -1;

afterAll(async () => {
  foreign.kill();
  await new Promise((resolve) => setTimeout(resolve, 150));
  rmSync(dataHome, { recursive: true, force: true });
});

describe("lockfilePath", () => {
  test("lands beside the default db under XDG_DATA_HOME", () => {
    expect(lockfilePath({ XDG_DATA_HOME: dataHome })).toBe(join(dataHome, "reviewzy", "daemon.lock"));
  });

  test("resolves ~/.local/share when XDG_DATA_HOME is unset", () => {
    const home = mkdtempSync(join(tmpdir(), "reviewzy-home-"));
    try {
      expect(lockfilePath({ HOME: home, XDG_DATA_HOME: undefined })).toBe(
        join(home, ".local", "share", "reviewzy", "daemon.lock"),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("readLockfile", () => {
  test("round-trips what writeLockfileAtomic wrote", () => {
    writeLockfileAtomic(lock, valid);
    expect(readLockfile(lock)).toEqual(valid);
  });

  test("writeLockfileAtomic leaves no temp file behind and creates the directory", () => {
    const nested = join(dataHome, "sub", "dir", "daemon.lock");
    writeLockfileAtomic(nested, valid);
    expect(readLockfile(nested)).toEqual(valid);
    expect(readdirSync(join(dataHome, "sub", "dir"))).toEqual(["daemon.lock"]);
  });

  test("a missing lockfile reads as null", () => {
    expect(readLockfile(join(dataHome, "absent.lock"))).toBeNull();
  });

  test("a corrupt lockfile reads as null rather than throwing", () => {
    const corrupt = join(dataHome, "corrupt.lock");
    for (const body of ["{not json", "", "null", '"a string"', "42"]) {
      writeFileSync(corrupt, body);
      expect(readLockfile(corrupt)).toBeNull();
    }
  });

  test("a lockfile missing a field, or holding a non-positive pid or a bad port, is null", () => {
    const partial = join(dataHome, "partial.lock");
    writeFileSync(partial, JSON.stringify({ pid: 1, port: 3123 }));
    expect(readLockfile(partial)).toBeNull();

    const bad: unknown[] = [
      { pid: 0, port: 3123, version: "0.1.0", nonce: "n" },
      { pid: -5, port: 3123, version: "0.1.0", nonce: "n" },
      { pid: 4242, port: 0, version: "0.1.0", nonce: "n" },
      { pid: 4242, port: 65536, version: "0.1.0", nonce: "n" },
      { pid: 4242, port: 3123, version: 7, nonce: "n" },
      { pid: 4242, port: 3123, version: "0.1.0", nonce: 7 },
    ];
    for (const shape of bad) {
      writeFileSync(partial, JSON.stringify(shape));
      expect(readLockfile(partial)).toBeNull();
    }
  });
});

describe("pid classification", () => {
  /** Spawns a real bun process in the daemon's spawn shape (`bun run <entry>`), writing a stay-alive script at `entry` first. */
  function spawnEntryCarrier(entry: string) {
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, "setTimeout(() => {}, 60_000);\n");
    return spawn(process.execPath, ["run", entry], { stdio: "ignore" });
  }

  test("processUid reads this process's own uid", () => {
    expect(processUid(process.pid)).toBe(process.getuid?.() ?? null);
  });

  test("processUid reads the uid of a foreign process", () => {
    expect(processUid(foreign.pid ?? -1)).toBe(process.getuid?.() ?? null);
  });
  test("isPidAlive separates a live process from a reaped one", async () => {
    expect(isPidAlive(foreign.pid ?? -1)).toBe(true);
    // A killed child stays a zombie (and therefore "alive" to `kill(pid, 0)`) until reaped, so
    // the exit is awaited before the dead-side assertion: no timing luck.
    await new Promise((resolve) => {
      if (dying.exitCode !== null || dying.signalCode !== null) resolve(undefined);
      else dying.once("exit", () => resolve(undefined));
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(isPidAlive(deadPid)).toBe(false);
  });

  test("a live pid running a foreign binary is not a reviewzy process", () => {
    expect(isReviewzyProcess(foreign.pid ?? -1)).toBe(false);
  });

  test("a live pid whose argv merely mentions reviewzy is still foreign", async () => {
    // The reviewer-measured exploit class: any process mentioning the name used to pass the
    // substring check. The entry path is the identity, not the name.
    const mentioner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)", "reviewzy"], {
      stdio: "ignore",
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(isReviewzyProcess(mentioner.pid ?? -1)).toBe(false);
    } finally {
      mentioner.kill();
      await new Promise((resolve) => mentioner.once("exit", () => resolve(undefined)));
    }
  });

  test("a bun process carrying the daemon entry in argv counts as reviewzy", async () => {
    // `bun test`'s own argv carries no reviewzy path (the repo is only its cwd), so the positive
    // case is pinned on a process shaped like the daemon: the entry path in argv.
    const carrier = spawn(process.execPath, [
      "-e",
      "setTimeout(() => {}, 60_000)",
      fileURLToPath(new URL("../../src/daemon/main.ts", import.meta.url)),
    ], { stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(isReviewzyProcess(carrier.pid ?? -1)).toBe(true);
    } finally {
      carrier.kill();
      await new Promise((resolve) => carrier.once("exit", resolve));
    }
  });

  test("a bun process carrying the daemon entry in a checkout dir not named reviewzy counts as reviewzy", async () => {
    // The identity is the entry, not the dir it lives in: the dir here is deliberately free of
    // "reviewzy", so only an entry-path match that ignores the checkout dir's name reads this as
    // ours. The tempdir entry is the same shape a renamed checkout spawns the daemon from.
    const dir = mkdtempSync(join(tmpdir(), "zqxw-checkout-"));
    const entry = join(dir, "src", "daemon", "main.ts");
    const carrier = spawnEntryCarrier(entry);
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(isPidAlive(carrier.pid ?? -1)).toBe(true);
      expect(isReviewzyProcess(carrier.pid ?? -1)).toBe(true);
    } finally {
      carrier.kill();
      await new Promise((resolve) => carrier.once("exit", () => resolve(undefined)));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the npm-layout entry (node_modules/reviewzy/src/daemon/main.ts) counts as reviewzy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zqxw-npm-"));
    const entry = join(dir, "node_modules", "reviewzy", "src", "daemon", "main.ts");
    const carrier = spawnEntryCarrier(entry);
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(isPidAlive(carrier.pid ?? -1)).toBe(true);
      expect(isReviewzyProcess(carrier.pid ?? -1)).toBe(true);
    } finally {
      carrier.kill();
      await new Promise((resolve) => carrier.once("exit", () => resolve(undefined)));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the claim file", () => {
  // The claim API is addressed by the LOCK path and derives `${lock}.claim` itself.
  const held = join(dataHome, "held.lock");
  const claimOf = (lockPath: string) => `${lockPath}.claim`;

  test("is exclusively acquirable and releasable", () => {
    expect(acquireClaim(held)).toBe(true);
    expect(acquireClaim(held)).toBe(false);
    expect(existsSync(claimOf(held))).toBe(true);
    releaseClaim(held);
    expect(existsSync(claimOf(held))).toBe(false);
    expect(acquireClaim(held)).toBe(true);
    releaseClaim(held);
  });

  test("releasing an absent claim is a no-op", () => {
    expect(() => releaseClaim(join(dataHome, "never-held.lock"))).not.toThrow();
  });

  test("a claim held by a dead shim reads as dead", async () => {
    const dead = join(dataHome, "dead-holder.lock");
    expect(acquireClaim(dead)).toBe(true);
    // The holder pid written into the claim is THIS process, so fake a dead holder by hand.
    writeFileSync(claimOf(dead), "999999999");
    expect(claimHolderIsDead(dead)).toBe(true);
    releaseClaim(dead);
    expect(claimHolderIsDead(dead)).toBe(false);
  });

  test("a claim whose holder died mid-write (empty or partial) reads as dead, never as held", () => {
    // The exact crash the sweep exists for: SIGKILL between the O_EXCL create and the pid write.
    const empty = join(dataHome, "empty-holder.lock");
    // "" and "garbage" parse to NaN (the mid-write crash), "999999999" is a pid that cannot exist;
    // nothing here depends on which pids the host happens to be running.
    for (const content of ["", "garbage", "999999999"]) {
      writeFileSync(claimOf(empty), content);
      expect(claimHolderIsDead(empty)).toBe(true);
    }
    rmSync(claimOf(empty), { force: true });
  });

  test("a claim held by a live process reads as live", () => {
    const live = join(dataHome, "live-holder.lock");
    expect(acquireClaim(live)).toBe(true); // holds this (live) test process's pid
    expect(claimHolderIsDead(live)).toBe(false);
    releaseClaim(live);
  });
});

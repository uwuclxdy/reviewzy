#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { liveDaemon } from "../src/shim/daemon.ts";
import { lockfilePath } from "../src/shim/lockfile.ts";

const GUIDE_FETCH_TIMEOUT_MS = 2_000;

/** The one field the hook reads from the SessionStart payload; everything else is ignored. */
type HookInput = { cwd: string };

/**
 * Reads the harness payload. Null on anything that is not a payload naming a cwd: no cwd means no
 * slug can be derived, and an unparsable stdin is a session that must start clean either way.
 */
function readHookInput(): HookInput | null {
  let raw: string;
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const cwd = (parsed as Record<string, unknown>).cwd;
    if (typeof cwd !== "string" || cwd === "") return null;
    return { cwd };
  } catch {
    return null;
  }
}

/**
 * The merged guide for the project the repo directory names, or null whenever this session carries
 * nothing: a missing lockfile, no daemon the shim itself would adopt, a refused or empty read.
 * Discovery is the shim's own liveDaemon — pid liveness, the daemon entry path and uid in the
 * lockfile pid's cmdline, and the `/health` name/pid/nonce match — so the bearer token is built
 * only for a port a live, same-uid reviewzy boot is really serving, the same bar the shim applies
 * before any token-bearing request. A stale lockfile whose port an impostor answers fails there,
 * and the session starts clean.
 */
async function fetchGuide(slug: string): Promise<string | null> {
  const live = await liveDaemon(lockfilePath(process.env));
  if (live === null) return null;

  const headers: Record<string, string> = {};
  const token = process.env.REVIEWZY_TOKEN;
  if (token !== undefined && token !== "") headers.authorization = `Bearer ${token}`;

  try {
    const response = await fetch(
      `http://127.0.0.1:${live.lock.port}/style-guide.md?project=${encodeURIComponent(slug)}`,
      { headers, signal: AbortSignal.timeout(GUIDE_FETCH_TIMEOUT_MS) },
    );
    if (response.status !== 200) return null;
    const markdown = await response.text();
    return markdown === "" ? null : markdown;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const input = readHookInput();
  if (input === null) return;
  const slug = basename(input.cwd);
  const guide = await fetchGuide(slug);
  if (guide === null) return;
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `reviewzy style guide for ${slug}:\n\n${guide}`,
      },
    }),
  );
}

// Every failure path is silence and exit 0: the harness adds nothing to a session whose repo has
// no guide, and any stderr here only becomes hook-error noise in the transcript.
main().catch(() => {});

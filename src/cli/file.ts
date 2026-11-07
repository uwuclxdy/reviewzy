import { appendFileSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { loadConfig, type Config } from "../config.ts";
import { forwardLine } from "../shim/main.ts";
import { ensureDaemon, TransportAuthError, TRANSPORT_AUTH, type DaemonHandle } from "../shim/daemon.ts";
import { lockfilePath } from "../shim/lockfile.ts";
import { NAME, VERSION } from "../version.ts";

/**
 * The `reviewzy file <entries.json>` verb: a bulk-audit script's client for the queue. It reads
 * each entry's file from disk under its repo and resolves each repo's filing text to its git
 * remote url — the provenance steps the daemon can never do, because the server never reads a
 * repo — and hands everything else to the daemon's own `file_entries` over `/mcp`, so anchor
 * verification, the re-file table, and the notifier stay server-side. The CLI opens no database
 * and holds no write path of its own.
 */

const USAGE = "usage: reviewzy file <entries.json>";
const REVISION = "2026-07-28";
const TOOL = "file_entries";

/** A bulk script runs unattended: a daemon that accepts the call and never answers must not hang it. */
const CALL_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MESSAGE = `reviewzy: the daemon did not answer the filing call within ${CALL_TIMEOUT_MS}ms`;

/** The keys an entry may carry; `file_content` and `file_hash` are deliberately absent. */
const ENTRY_KEYS = new Set([
  "repo",
  "file",
  "title",
  "tag",
  "anchor_text",
  "anchor_before",
  "anchor_after",
  "agent_draft",
  "context",
  "constraints",
  "images",
]);

const TOP_LEVEL_KEYS = new Set(["project", "filed_by", "entries"]);

/** The fields the verb's own work depends on (repo and file name a disk read); the server owns every other rule. */
const REQUIRED_ENTRY_KEYS = ["repo", "file", "anchor_text"] as const;

const PROVENANCE_KEYS = ["file_content", "file_hash"] as const;

/** The `_meta` envelope the stateless leg requires, carrying the same client identity the shim's frames do. */
const META = {
  "io.modelcontextprotocol/protocolVersion": REVISION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: NAME, version: VERSION },
};

type Entry = Record<string, unknown>;
type InputFile = { project: string; filedBy: string | undefined; entries: Entry[] };
type Provenance = { file: string; file_content: string };

type ReplyFrame = {
  result?: { isError?: boolean; structuredContent?: unknown; content?: { text?: string }[] };
  error?: { message?: string; data?: { transport?: string } };
};

function refuse(where: string, problem: string, fix: string): never {
  throw new Error(`reviewzy file refused: ${where}: ${problem}. fix: ${fix}`);
}

export async function runFileCommand(argv: string[]): Promise<void> {
  // A vanished stdout reader must not turn the JSON write into an uncaught EPIPE crash.
  process.stdout.on("error", () => {});

  if (argv.length !== 1) {
    console.error(USAGE);
    process.exit(2);
  }

  try {
    const args = buildArguments(readInput(argv[0]!));
    const output = await fileThroughDaemon(loadConfig(), args);
    console.log(JSON.stringify(output));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      error instanceof TransportAuthError
        ? `${message}. fix: set REVIEWZY_TOKEN in this process's environment to the daemon's token, or unset it on both sides`
        : message,
    );
    process.exit(1);
  }
}

/**
 * Establishes the singleton daemon exactly as the stdio shim does, then files the call through the
 * shim's own forwarder, so header derivation, the sse legs, and the bearer token have no second
 * implementation to drift from. Resolves with the tool's structured content; any refusal or
 * transport failure throws.
 */
async function fileThroughDaemon(config: Config, args: Record<string, unknown>): Promise<unknown> {
  const handle = await ensureDaemonQuietly(config);

  const frame = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: TOOL, arguments: args, _meta: META },
  };
  const reply = await raceCallDeadline(forwardLine(JSON.stringify(frame), handle.port, config.REVIEWZY_TOKEN));
  if (reply === null) {
    throw new Error("reviewzy: the daemon answered a request with no frame");
  }
  const parsed = JSON.parse(reply) as ReplyFrame;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("reviewzy: the daemon answered with a frame that is not an object");
  }
  if (parsed.error !== undefined) {
    const message = `reviewzy: ${parsed.error.message ?? "the daemon refused the call"}`;
    // The shim marks a 401 on the error frame (see transportError); the marker rides as data, so
    // the auth signal is matched by type here, never by message text.
    if (parsed.error.data?.transport === TRANSPORT_AUTH) throw new TransportAuthError(message);
    throw new Error(message);
  }

  const result = parsed.result;
  if (result === undefined) {
    throw new Error("reviewzy: the daemon answered without a result");
  }
  // The server's refusals name the entry and the fix; relayed verbatim, since that wording is the
  // same contract mcp clients already see.
  if (result.isError === true) {
    throw new Error(result.content?.map((part) => part.text ?? "").join("\n") || JSON.stringify(result));
  }
  if (result.structuredContent === undefined) {
    throw new Error("reviewzy: the daemon answered without structured content");
  }
  return result.structuredContent;
}

/**
 * Awaits the filing call under the deadline: the shared forwarder carries no timeout of its own,
 * so the CLI races the call against a timer — losing throws, and the process exit abandons the
 * socket either way.
 */
async function raceCallDeadline(call: Promise<string | null>): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(CALL_TIMEOUT_MESSAGE)), CALL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `ensureDaemon` narrates the spawn on stderr — the stdio shim's log channel. The file verb's
 * stderr is part of its output contract (empty on success, the refusal on failure), so the
 * narration is collected around the call and lands in daemon.log beside the lockfile, where the
 * daemon's own output already goes; when ensureDaemon itself fails, its narration rides above the
 * error message instead.
 */
async function ensureDaemonQuietly(config: Config): Promise<DaemonHandle> {
  const lockfile = lockfilePath(process.env);
  const notes: string[] = [];
  const narrate = console.error;
  const capture = (...parts: unknown[]) => {
    notes.push(parts.map(String).join(" "));
  };
  console.error = capture;
  let handle: DaemonHandle;
  try {
    handle = await ensureDaemon({
      lockfile,
      port: config.REVIEWZY_PORT,
      shimVersion: VERSION,
      token: config.REVIEWZY_TOKEN,
      dev: config.REVIEWZY_DEV === "1",
      env: process.env,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const narration = notes.length > 0 ? [...notes, message].join("\n") : message;
    // The rewrap must not erase the auth signal: runFileCommand matches the class, never message
    // text, so a relayed refusal quoting a transport phrase can never read as a token mismatch.
    if (error instanceof TransportAuthError) throw new TransportAuthError(narration);
    throw new Error(narration);
  } finally {
    // Guarded, not blind: a nested capture may already have replaced the patch, and a blind restore
    // would then clobber it with ours.
    if (console.error === capture) console.error = narrate;
  }

  if (notes.length > 0) {
    try {
      appendFileSync(join(dirname(lockfile), "daemon.log"), `${notes.join("\n")}\n`);
    } catch {
      // The narration is a record, not a result: an unwritable log must not fail a filed batch.
    }
  }
  return handle;
}

/** The `file_entries` arguments: one provenance row per distinct file, entries forwarded as read. */
function buildArguments(input: InputFile): Record<string, unknown> {
  const args: Record<string, unknown> = {
    project: input.project,
    files: readProvenance(input.entries),
    entries: input.entries,
  };
  if (input.filedBy !== undefined) args.filed_by = input.filedBy;
  return args;
}

/**
 * Reads every distinct file once, as utf8 text, unmodified, and rewrites every entry's `repo` to
 * its resolved filing text, resolved once per distinct raw input (see resolveRepoText): the
 * server's identity key carries the repo text as filed, so a local path where mcp filings carry
 * the remote url would split one repo's dedupe history in two. The cross-repo guard compares the
 * resolved texts, so two spellings of one directory collapse instead of refusing. A row's key is
 * the entry's `file` alone — the server matches provenance to entries by path — so one call
 * cannot carry the same path under two repos: a single row would silently back one repo's
 * anchors with the other's bytes.
 */
function readProvenance(entries: readonly Entry[]): Provenance[] {
  const rows = new Map<string, Provenance>();
  const readFrom = new Map<string, { repo: string; index: number }>();
  const resolvedRepos = new Map<string, { text: string; root: string }>();
  for (const [index, entry] of entries.entries()) {
    const where = entryWhere(entry, index);
    const repoPath = entry.repo as string;
    const file = entry.file as string;

    let resolvedRepo = resolvedRepos.get(repoPath);
    if (resolvedRepo === undefined) {
      // The root is the containment check's trusted side, real-pathed so a repo reached through its
      // own symlink contains its files; a repo that vanishes between the two syscalls refuses like
      // any other missing directory.
      const text = resolveRepoText(repoPath, where);
      let root: string;
      try {
        root = realpathSync(repoPath);
      } catch (error) {
        refuse(
          where,
          `repo "${repoPath}" is not an existing local directory (${(error as NodeJS.ErrnoException).code})`,
          "set repo to an existing local checkout directory",
        );
      }
      resolvedRepo = { text, root };
      resolvedRepos.set(repoPath, resolvedRepo);
    }
    entry.repo = resolvedRepo.text;

    const seen = readFrom.get(file);
    if (seen !== undefined) {
      if (seen.repo !== resolvedRepo.text) {
        refuse(
          where,
          `file "${file}" was already read from repo "${seen.repo}" (entries[${seen.index}])`,
          "file provenance is shared per path within one call: file each repo from its own json",
        );
      }
      continue;
    }

    const realFile = containedFilePath(repoPath, file, resolvedRepo.root, where);
    let content: string;
    try {
      content = readFileSync(realFile, "utf8");
    } catch (error) {
      refuse(
        where,
        `repo file "${file}" cannot be read (${(error as NodeJS.ErrnoException).code})`,
        "set file to a path that exists relative to the repo root",
      );
    }
    readFrom.set(file, { repo: resolvedRepo.text, index });
    rows.set(file, { file, file_content: content });
  }
  return [...rows.values()];
}

/**
 * Resolves one entry's file to its real path inside the repo: both sides go through realpath, so a
 * `..` segment and a symlink out of the repo refuse the same way, while a repo reached through its
 * own symlink still contains its files. The root itself counts as inside — the caller's read then
 * fails on the directory as it always has.
 */
function containedFilePath(repoPath: string, file: string, repoRoot: string, where: string): string {
  let realFile: string;
  try {
    realFile = realpathSync(resolve(repoPath, file));
  } catch (error) {
    refuse(
      where,
      `repo file "${file}" cannot be read (${(error as NodeJS.ErrnoException).code})`,
      "set file to a path that exists relative to the repo root",
    );
  }
  if (realFile !== repoRoot && !realFile.startsWith(`${repoRoot}${sep}`)) {
    refuse(where, `file "${file}" escapes the repo root`, "set file to a path that resolves inside the repo root");
  }
  return realFile;
}

/**
 * The repo text the queue stores for a local directory: the git remote url when it has one — the
 * contract's preferred shape, and the text mcp filings already carry, so cli filings dedupe
 * against them — else the directory's absolute path. Refuses a repo that is not an existing local
 * directory, naming the first entry that carries it.
 */
function resolveRepoText(repoPath: string, where: string): string {
  let repoStat: Stats;
  try {
    repoStat = statSync(repoPath);
  } catch (error) {
    refuse(
      where,
      `repo "${repoPath}" is not an existing local directory (${(error as NodeJS.ErrnoException).code})`,
      "set repo to an existing local checkout directory",
    );
  }
  if (!repoStat.isDirectory()) {
    refuse(where, `repo "${repoPath}" is not an existing local directory`, "set repo to an existing local checkout directory");
  }

  const originUrl = gitRemoteUrl(repoPath, "origin");
  if (originUrl !== null) return originUrl;

  const remotes = gitStdout(repoPath, ["remote"]) ?? "";
  const firstRemote = remotes.split("\n")[0]?.trim() ?? "";
  if (firstRemote !== "") {
    const remoteUrl = gitRemoteUrl(repoPath, firstRemote);
    if (remoteUrl !== null) return remoteUrl;
  }

  try {
    return realpathSync(repoPath);
  } catch (error) {
    refuse(
      where,
      `repo "${repoPath}" is not an existing local directory (${(error as NodeJS.ErrnoException).code})`,
      "set repo to an existing local checkout directory",
    );
  }
}

/** The url git holds for one remote, or null when git refuses (not a repo, no such remote, no git). */
function gitRemoteUrl(repoPath: string, remote: string): string | null {
  // `remote get-url` answers an empty configured url with the remote's NAME; `config --get` answers
  // with the raw stored value, so a remote added from an unset variable resolves to null and falls
  // through to the path, never to a nonsense identity text.
  const url = gitStdout(repoPath, ["config", "--get", `remote.${remote}.url`])?.trim() ?? null;
  return url === "" ? null : url;
}

/** One git query inside the repo: its stdout, or null when git refuses. */
function gitStdout(repoPath: string, args: string[]): string | null {
  // git's stderr is discarded: the verb's stderr is part of its output contract, and a repo that
  // merely has no remote must resolve silently to its path.
  try {
    const query = Bun.spawnSync(["git", "-C", repoPath, ...args], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    return query.exitCode === 0 ? query.stdout.toString() : null;
  } catch {
    // No git on the box: the absolute path is the contract's fallback text.
    return null;
  }
}

/**
 * Parses and shapes the input file. The split with the server: the verb refuses locally what only
 * it can judge — the input file's structure, the hand-supplied provenance keys, the paths it must
 * read from disk — and leaves every contract rule (slug shape, anchor ambiguity, constraint
 * limits) to the server's own validation, which it relays by name.
 */
function readInput(path: string): InputFile {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    refuse(`input "${path}"`, `cannot be read (${(error as NodeJS.ErrnoException).code})`, "pass the path of the audit's json file");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    refuse(`input "${path}"`, `is not valid json: ${(error as Error).message}`, "fix the json syntax error in the file");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    refuse(`input "${path}"`, "the json must be an object", 'shape it as {"project": "...", "entries": [...]}');
  }
  const body = parsed as Record<string, unknown>;

  const unknownTop = Object.keys(body).filter((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknownTop.length > 0) {
    refuse(
      `input "${path}"`,
      `unrecognized key(s) ${unknownTop.map((key) => JSON.stringify(key)).join(", ")}`,
      unknownTop.includes("files")
        ? unknownTop.length > 1
          ? "files is the mcp tool's provenance key, which this verb does not take: it derives provenance from disk; drop it and the other unrecognized keys"
          : "files is the mcp tool's provenance key, which this verb does not take: it derives provenance from disk, so drop it"
        : "the file takes only project, filed_by, and entries; drop the extra key or spell it snake_case",
    );
  }
  if (typeof body.project !== "string" || body.project === "") {
    refuse(`input "${path}"`, "project is missing or empty", 'set project to the dashboard slug, e.g. "my-app"');
  }
  const entries = body.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    refuse(`input "${path}"`, "entries is missing or empty", "list at least one entry object");
  }
  if (body.filed_by !== undefined && typeof body.filed_by !== "string") {
    refuse(`input "${path}"`, "filed_by must be a string", 'set filed_by to a label such as "bulk-audit", or omit it');
  }

  for (const [index, entry] of entries.entries()) {
    validateEntryShape(entry, index);
  }
  return {
    project: body.project as string,
    filedBy: typeof body.filed_by === "string" ? body.filed_by : undefined,
    entries: entries as Entry[],
  };
}

function validateEntryShape(value: unknown, index: number): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    refuse(`entries[${index}]`, "must be an object", "shape each entry as {repo, file, anchor_text, ...}");
  }
  const entry = value as Entry;
  const where = entryWhere(entry, index);

  // Named ahead of the generic key check: hand-deriving a hash in the json is the exact work this
  // verb exists to take over, so the refusal names that instead of an unrecognized key.
  const banned = PROVENANCE_KEYS.filter((key) => key in entry);
  if (banned.length > 0) {
    const named = banned.map((key) => JSON.stringify(key)).join(" and ");
    refuse(
      where,
      `${named} ${banned.length === 1 ? "is" : "are"} not accepted: the file verb derives provenance from disk under each entry's repo`,
      `drop ${named}`,
    );
  }

  const unknown = Object.keys(entry).filter((key) => !ENTRY_KEYS.has(key));
  if (unknown.length > 0) {
    // Derived from the set, never a second list: two hand-held lists are how an allowed key goes
    // missing from this message.
    const allowed = [...ENTRY_KEYS].map((key, i, all) => (i === all.length - 1 ? `and ${key}` : key)).join(", ");
    refuse(
      where,
      `unrecognized key(s) ${unknown.map((key) => JSON.stringify(key)).join(", ")}`,
      `entries take only ${allowed}; drop the extra key or spell it snake_case`,
    );
  }

  for (const key of REQUIRED_ENTRY_KEYS) {
    if (typeof entry[key] !== "string" || entry[key] === "") {
      refuse(where, `"${key}" is missing or empty`, `set "${key}" to a non-empty string`);
    }
  }
}

function entryWhere(entry: Entry, index: number): string {
  const file = typeof entry.file === "string" ? entry.file : "(no file)";
  return `entries[${index}] (${file})`;
}

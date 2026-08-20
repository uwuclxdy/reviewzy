import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { fileEntries, type NewEntry } from "../db/queries.ts";
import type { Store } from "../db/store.ts";
import type { Notifier } from "../notify.ts";

/**
 * A project slug is 1-63 chars of lowercase letters, digits, and inner hyphens. Lowercase-only is
 * the load-bearing half: slugs name resource URIs (`reviewzy://projects/{slug}/style-guide`) and
 * dashboard paths, and a case pair would fold into one path on a case-insensitive mount while
 * sqlite holds two projects.
 */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** sha256 as 64 lowercase hex chars: the shape of `anchor_hash` and of a caller-supplied `file_hash`. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** `context` is free-form notes for the human; the only shape it must have is "a json object". */
const ContextJson = z.record(z.string(), z.json());

/**
 * The contract's constraint fields, strict so a misspelling (`maxLen`) is refused by name instead
 * of silently dropping the constraint it was meant to carry.
 */
const ConstraintsJson = z.strictObject({
  max_len: z.number().int().positive().optional(),
  placeholders: z
    .array(z.string().min(1))
    .refine((items) => new Set(items).size === items.length, "placeholder names must be unique")
    .optional(),
  tone: z.string().optional(),
  notes: z.string().optional(),
});

/**
 * Held loose on purpose. The SDK's own schema check would refuse a malformed constraints with an
 * isError tool result naming the tool and the field path ("entries.0.constraints"). The handler's
 * refusal adds what that cannot: the entry (file and anchor) and the fix. So `context` and
 * `constraints` stay untyped here and are validated below.
 */
const FileEntryArgs = z.object({
  repo: z.string().min(1),
  file: z.string().min(1),
  title: z.string().min(1).optional(),
  anchor_text: z.string().min(1),
  anchor_before: z.string().optional(),
  anchor_after: z.string().optional(),
  agent_draft: z.string().optional(),
  file_content: z.string().optional(),
  file_hash: z.string().optional(),
  context: z.unknown().optional(),
  constraints: z.unknown().optional(),
});

const FiledOutput = z.object({
  batch_id: z.string(),
  results: z.array(
    z.object({
      id: z.string(),
      status: z.enum(["draft", "approved", "applied", "rejected"]),
      deduped: z.boolean(),
      updated: z.boolean(),
    }),
  ),
  dashboard_url: z.string(),
});

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The `where` of a refusal: the entry's place in the call plus enough of it to spot it in a repo. */
function entryName(index: number, file: string, anchorText: string): string {
  return `entries[${index}] (${file}, anchor "${anchorText.slice(0, 40)}")`;
}

/** A refusal is an ordinary thrown Error: the SDK answers it as a tool result with `isError: true`, never as a json-rpc protocol error. */
function refuse(where: string, problem: string, fix: string): never {
  throw new Error(`file_entries refused: ${where}: ${problem}. fix: ${fix}`);
}

const CONSTRAINT_FIX: Record<string, string> = {
  max_len: "send constraints.max_len as an integer greater than 0",
  placeholders: "send constraints.placeholders as an array of unique non-empty strings",
  tone: "send constraints.tone as a string",
  notes: "send constraints.notes as a string",
};

/** Turns zod's issues into the named-field refusal the contract's error row promises. */
function refuseConstraints(index: number, file: string, anchorText: string, issues: readonly z.ZodIssue[]): never {
  const where = entryName(index, file, anchorText);
  const problem = issues
    .map((issue) => `constraints.${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  const firstField = String(issues[0]?.path[0] ?? "");
  const unrecognized = issues.some((issue) => issue.code === "unrecognized_keys");
  const fix = unrecognized
    ? "constraints takes only max_len, placeholders, tone, and notes; drop the extra key or spell it snake_case"
    : (CONSTRAINT_FIX[firstField] ?? "send constraints as an object of max_len, placeholders, tone, and notes");
  return refuse(where, problem, fix);
}

/**
 * One entry from wire shape to store shape: json validated at this boundary, `anchor_hash` always
 * computed here, and file provenance taken from exactly one of `file_content` (the server hashes
 * it) or `file_hash` (the caller already did). The server never reads a repo, so it can never
 * invent this value: an entry carrying neither is refused rather than filed with a fake hash.
 */
function validateEntry(index: number, raw: z.output<typeof FileEntryArgs>): NewEntry {
  const where = entryName(index, raw.file, raw.anchor_text);

  const context = ContextJson.safeParse(raw.context ?? {});
  if (!context.success) {
    refuse(
      where,
      `context must be a json object of free-form notes for the human (where the string renders, surrounding code), got ${JSON.stringify(
        raw.context,
      )?.slice(0, 60)}`,
      'send an object such as {"where": "hero button"}, or omit context entirely',
    );
  }

  const constraints = ConstraintsJson.safeParse(raw.constraints ?? {});
  if (!constraints.success) {
    refuseConstraints(index, raw.file, raw.anchor_text, constraints.error.issues);
  }

  let fileHash: string;
  if (raw.file_content !== undefined && raw.file_hash !== undefined) {
    refuse(
      where,
      "file_content and file_hash both sent, so the server cannot tell which is authoritative",
      "send file_content alone (preferred: the server hashes it) and drop file_hash",
    );
  } else if (raw.file_content !== undefined) {
    fileHash = sha256(raw.file_content);
  } else if (raw.file_hash !== undefined) {
    if (!SHA256_HEX.test(raw.file_hash)) {
      refuse(
        where,
        `file_hash must be sha256 as 64 lowercase hex characters, got "${raw.file_hash.slice(0, 20)}"`,
        "send the sha256 hex of the whole file, or send file_content and let the server hash it",
      );
    }
    fileHash = raw.file_hash;
  } else {
    refuse(
      where,
      "no file provenance: the server never reads repos, so it cannot know what the file looked like",
      "send file_content (the whole file at filing time) or file_hash (its sha256), exactly one",
    );
  }

  return {
    repo: raw.repo,
    file: raw.file,
    title: raw.title ?? null,
    anchorText: raw.anchor_text,
    anchorBefore: raw.anchor_before ?? "",
    anchorAfter: raw.anchor_after ?? "",
    anchorHash: sha256(raw.anchor_text),
    fileHash,
    agentDraft: raw.agent_draft ?? null,
    // null (absent or explicit null) means "the newer call does not carry this field": a draft
    // re-file then keeps the stored value, per the COALESCE in src/db/queries.ts.
    contextJson: raw.context == null ? null : JSON.stringify(context.data),
    constraintsJson: raw.constraints == null ? null : JSON.stringify(constraints.data),
  };
}

/**
 * Registers the contract's one writing tool. Every entry in one call shares the minted batch id,
 * and each resolves against the identity key per the frozen re-file table: a known `draft` is
 * overwritten in place, anything past `draft` comes back untouched — which is what silences a
 * re-file against a rejected anchor.
 */
export function registerFileEntriesTool(server: McpServer, baseUrl: string, store: Store, notifier: Notifier): void {
  server.registerTool(
    "file_entries",
    {
      title: "File entries for review",
      description:
        "File draft entries for a human to author or approve. Each entry names one exact string to replace: repo (git remote url preferred), file path, an optional title (a human-readable label the dashboard shows in place of the file path), anchor_text, and anchor_before/anchor_after context lines. Identity is (project, repo, file, sha256(anchor_text)): re-filing a known draft overwrites the agent draft, context, and constraints in place; an entry already approved, applied, or rejected is returned untouched with its own status, and a rejected anchor stays rejected — stop proposing a turned-down line. file provenance: send exactly one of file_content (the whole file at filing time; the server hashes it) or file_hash (its sha256 hex). constraints: {max_len?, placeholders?: string[], tone?, notes?} — a save breaking max_len or dropping a placeholder is refused later, so declare what the copy must keep. Keys the schema does not list are ignored.",
      inputSchema: z.object({
        project: z.string().min(1),
        entries: z.array(FileEntryArgs).min(1),
        filed_by: z.string().min(1).optional(),
      }),
      outputSchema: FiledOutput,
    },
    async (args) => {
      if (!SLUG.test(args.project)) {
        refuse(
          `project "${args.project}"`,
          "a project slug is 1-63 chars of lowercase letters, digits, and inner hyphens",
          'lower-case the name and separate words with hyphens, e.g. "my-app"',
        );
      }

      const entries = args.entries.map((raw, index) => validateEntry(index, raw));
      const batch = fileEntries(store, args.project, args.filed_by ?? null, entries);

      // The ping announces work for the human, so only a batch that changed the store fires: an
      // all-dedupe no-op re-file (the agent loop re-proposing known lines) stays silent, and a
      // refused call throws before reaching this line.
      const changed = batch.results.filter((r) => !r.deduped || r.updated).length;
      if (changed > 0) notifier.notifyBatch(args.project, batch.batchId, changed);

      const output = {
        batch_id: batch.batchId,
        results: batch.results,
        // The project-filtered list view: `/projects/{slug}` never existed as a route, so the old
        // link 404ed (flagged by the task-13 browser pass).
        dashboard_url: `${baseUrl}/?project=${encodeURIComponent(args.project)}`,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}

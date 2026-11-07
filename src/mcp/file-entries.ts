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
export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

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
 * The wire schema is loose on purpose: a plain z.object lets the sdk strip an unrecognized
 * top-level key before the handler sees it, so a misspelled anchor_text would file an entry with
 * no anchor and a misspelled agent_draft one with no draft. The handler re-parses each entry
 * against StrictEntryArgs and refuses the key by name, with the entry and the fix. `context` and
 * `constraints` stay untyped for the same reason: the sdk's refusal can name only the tool and the
 * field path ("entries.0.constraints"), never the entry (file and anchor) and the fix.
 */
const EntryShape = {
  repo: z.string().min(1).describe("Which repo the entry is about: the git remote url preferred, the absolute path when the repo has no remote."),
  file: z.string().min(1).describe("The path relative to the repo root."),
  title: z.string().min(1).optional().describe("Optional human-readable label the dashboard shows in place of the file path."),
  tag: z.string().min(1).optional().describe("Optional free-form label naming what this entry is a sample of, so a bulk audit's entries group by it; shown and filterable on the dashboard and through list_entries. On a re-file of a known draft, a new tag overwrites the stored one and an omitted tag keeps it."),
  anchor_text: z.string().min(1).describe("The exact current text to replace: one line or many, the whole passage being replaced."),
  anchor_before: z.string().optional().describe("3 lines of context above the anchor, disambiguating a repeated string. Send it (or anchor_after) when anchor_text appears more than once in the file; the server refuses an ambiguous anchor unless sent context matches its placement."),
  anchor_after: z.string().optional().describe("3 lines of context below the anchor, disambiguating a repeated string (same rule as anchor_before)."),
  agent_draft: z.string().optional().describe("The proposed replacement text; inert until a human touches it."),
  file_content: z.string().optional().describe("The whole file at filing time; the server hashes it. Preferred: it lets the server verify your anchors against the file."),
  file_hash: z.string().optional().describe("The sha256 of the whole file as 64 lowercase hex chars."),
  context: z.unknown().optional().describe("A json object of free-form notes for the human: where the string renders, surrounding code."),
  constraints: z.unknown().optional().describe("What the copy must keep: max_len (a length cap), placeholders (strings the text must contain), tone, notes — all optional."),
  images: z.unknown().optional().describe("Screenshots and links for the human, shown on the dashboard, never returned by an mcp tool."),
};
const FileEntryArgs = z.looseObject(EntryShape);

/** Strict twin of the wire shape: the handler re-parses against it to refuse an unrecognized top-level key by name. */
const StrictEntryArgs = z.strictObject(EntryShape);

/**
 * A files[] row carries one file's content once per call. Loose at the wire for the same reason as
 * an entry: the sdk's refusal can name only a field path ("files.0.fileContent"), never the row's
 * file and the fix, so the handler re-parses each row strictly and refuses by file.
 */
const FileProvenanceShape = {
  file: z.string().optional().describe("The path relative to the repo root, matching an entry's file."),
  file_content: z.string().optional().describe("The whole file at filing time; the server hashes it and verifies anchors against it."),
};
const FileProvenanceWire = z.looseObject(FileProvenanceShape);
const StrictFileProvenance = z.strictObject({
  file: z.string().min(1),
  file_content: z.string().min(1),
});

/**
 * The tool's own arguments get the same loose-wire/strict-handler pair as their parts: a plain
 * z.object would strip a misspelled top-level key (`Files`) before the handler saw it, and the
 * entries would then be refused for missing provenance with no mention of the key that was meant
 * to carry it.
 */
const FileEntriesArgs = {
  project: z.string().min(1).describe("The project slug: 1-63 chars of lowercase letters, digits, and inner hyphens. An unknown slug auto-creates the project on first file."),
  files: z
    .array(FileProvenanceWire)
    .optional()
    .describe("Provenance sent once for entries filed from the same file: each item is {file, file_content}; an entry without its own file_content or file_hash picks up the row matching its file. Every row must match an entry."),
  entries: z.array(FileEntryArgs).min(1).describe("The entries to file. One edit per entry."),
  filed_by: z.string().min(1).optional().describe("A free-form label for the filing agent, shown on the dashboard."),
};
const StrictFileEntriesArgs = z.strictObject(FileEntriesArgs);

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

/** Every starting position counts: overlapping matches are distinct places, so a self-overlapping anchor still reads as ambiguous. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + 1);
  }
  return count;
}

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

/** The caps `docs/mcp-contract.md` pins for `images`: at most 8 per entry, each at most 5 MiB. */
const MAX_IMAGES_PER_ENTRY = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

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

/** Turns zod's unrecognized_keys issues into the named-key refusal: the key, the entry, the fix. */
function refuseEntryKeys(index: number, file: string, anchorText: string, issues: readonly z.ZodIssue[]): never {
  const where = entryName(index, file, anchorText);
  const keys = issues.flatMap((issue) => (issue.code === "unrecognized_keys" ? issue.keys : []));
  return refuse(
    where,
    `unrecognized key(s) ${keys.map((k) => JSON.stringify(k).slice(0, 60)).join(", ")}`,
    "entries take only repo, file, title, tag, anchor_text, anchor_before, anchor_after, agent_draft, file_content, file_hash, context, constraints, and images; drop the extra key or spell it snake_case",
  );
}

/**
 * Every files[] row is checked before any entry: a row the handler cannot use must be refused, not
 * dropped, since the entry it was meant to cover would otherwise be refused for missing provenance.
 * Returns the resolved content by file path for entries that carry none of their own.
 */
function validateFiles(
  rows: z.output<typeof FileProvenanceWire>[],
  entries: readonly { file: string }[],
): Map<string, string> {
  const parsed: { where: string; file: string; content: string }[] = [];
  rows.forEach((raw, index) => {
    const path = typeof raw.file === "string" ? raw.file : "";
    const where = `files[${index}] ("${path}")`;
    const strict = StrictFileProvenance.safeParse(raw);
    if (!strict.success) {
      const keys = strict.error.issues.flatMap((issue) => (issue.code === "unrecognized_keys" ? issue.keys : []));
      if (keys.length > 0) {
        refuse(
          where,
          `unrecognized key(s) ${keys.map((k) => JSON.stringify(k).slice(0, 60)).join(", ")}`,
          "files[] items take only file and file_content; spell them snake_case",
        );
      }
      const lacking = [...new Set(strict.error.issues.map((issue) => String(issue.path[0] ?? "")))].filter(Boolean);
      refuse(where, `${lacking.join(" and ")} is missing or empty`, "send the row's file path and the file's full content");
    }
    parsed.push({ where, file: strict.data.file, content: strict.data.file_content });
  });

  const seen = new Set<string>();
  for (const row of parsed) {
    if (seen.has(row.file)) {
      refuse(row.where, "files[] names this file twice", "send each file once; entries pick it up by path");
    }
    seen.add(row.file);
  }

  const entryFiles = new Set(entries.map((raw) => raw.file));
  const byFile = new Map<string, string>();
  for (const row of parsed) {
    if (!entryFiles.has(row.file)) {
      refuse(
        row.where,
        "no entry names this file",
        "every files[] path must match an entry's file; drop the row or fix the path",
      );
    }
    byFile.set(row.file, row.content);
  }
  return byFile;
}

/**
 * One entry from wire shape to store shape: json validated at this boundary, `anchor_hash` always
 * computed here, and file provenance taken from exactly one of `file_content` (the server hashes
 * it), `file_hash` (the caller already did), or the files[] row whose file matches. The server
 * never reads a repo, so it can never invent this value: an entry carrying none is refused rather
 * than filed with a fake hash. An anchor is verified against content only when the caller sent it.
 */
function validateEntry(
  index: number,
  raw: z.output<typeof FileEntryArgs>,
  files: ReadonlyMap<string, string>,
): NewEntry {
  const where = entryName(index, raw.file, raw.anchor_text);

  // Unknown keys first: a wire-shape mistake outranks every field-level check below.
  const strict = StrictEntryArgs.safeParse(raw);
  if (!strict.success) {
    refuseEntryKeys(index, raw.file, raw.anchor_text, strict.error.issues);
  }

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

  // Held loose like context and constraints, so the refusal names the entry and the fix instead
  // of stopping at the sdk's field-path error. Absent (or explicit null) means "the newer call
  // does not carry this field": a draft re-file then keeps the stored images.
  let imagesJson: string | null;
  if (raw.images == null) {
    imagesJson = null;
  } else {
    if (!Array.isArray(raw.images)) {
      refuse(
        where,
        "images must be an array of image urls or data urls",
        'send an array such as ["https://example.com/screenshot.png"], or omit images',
      );
    }
    if (raw.images.length > MAX_IMAGES_PER_ENTRY) {
      refuse(
        where,
        `images has ${raw.images.length} items; the limit is ${MAX_IMAGES_PER_ENTRY}`,
        `send at most ${MAX_IMAGES_PER_ENTRY} images per entry`,
      );
    }
    raw.images.forEach((item, imageIndex) => {
      if (typeof item !== "string") {
        refuse(where, `images[${imageIndex}] must be a string`, "send each image as a string url or data url");
      }
      if (!item.startsWith("data:image/") && !/^https?:\/\//.test(item)) {
        refuse(
          where,
          `images[${imageIndex}] must start with "data:image/" or an http(s) url, got "${item.slice(0, 40)}"`,
          "send a data:image/ data url or an http(s) url",
        );
      }
      const bytes = Buffer.byteLength(item, "utf8");
      if (bytes > MAX_IMAGE_BYTES) {
        refuse(
          where,
          `images[${imageIndex}] is ${bytes} bytes; the limit is ${MAX_IMAGE_BYTES} bytes (5 MiB)`,
          "send a smaller image, or link an http(s) url instead",
        );
      }
    });
    imagesJson = JSON.stringify(raw.images);
  }

  let fileHash: string;
  // The content an anchor can be checked against: present only when the caller sent one, on the
  // entry or in the files[] row its file matches. A hash-only entry has none, and verification
  // would be a guess: the server never reads a repo.
  let content: string | null;
  if (raw.file_content !== undefined && raw.file_hash !== undefined) {
    refuse(
      where,
      "file_content and file_hash both sent, so the server cannot tell which is authoritative",
      "send file_content alone (preferred: the server hashes it) and drop file_hash",
    );
  } else if (raw.file_content !== undefined) {
    fileHash = sha256(raw.file_content);
    content = raw.file_content;
  } else if (raw.file_hash !== undefined) {
    if (!SHA256_HEX.test(raw.file_hash)) {
      refuse(
        where,
        `file_hash must be sha256 as 64 lowercase hex characters, got "${raw.file_hash.slice(0, 20)}"`,
        "send the sha256 hex of the whole file, or send file_content and let the server hash it",
      );
    }
    fileHash = raw.file_hash;
    content = null;
  } else {
    const shared = files.get(raw.file);
    if (shared === undefined) {
      refuse(
        where,
        "no file provenance: the server never reads repos, so it cannot know what the file looked like",
        "send file_content, file_hash, or a files[] row whose file matches this entry's file",
      );
    }
    fileHash = sha256(shared);
    content = shared;
  }

  if (content !== null) {
    const matches = countOccurrences(content, raw.anchor_text);
    if (matches === 0) {
      refuse(
        where,
        "anchor_text not found in the file content",
        "read the file and copy anchor_text exactly as it is now, or send the current file_content",
      );
    }
    // Context that matches no placement disambiguates nothing: only a context adjoining an actual
    // occurrence of the anchor counts, and absent context counts as no match on its side.
    if (matches > 1) {
      const beforeMatches = raw.anchor_before ? countOccurrences(content, `${raw.anchor_before}${raw.anchor_text}`) : 0;
      const afterMatches = raw.anchor_after ? countOccurrences(content, `${raw.anchor_text}${raw.anchor_after}`) : 0;
      if (beforeMatches === 0 && afterMatches === 0) {
        refuse(
          where,
          `anchor_text appears ${matches} times in the file content and nothing sent disambiguates it`,
          "send anchor_before or anchor_after (copied byte-exact from the file around the anchor), or a longer anchor_text",
        );
      }
    }
  }

  return {
    repo: raw.repo,
    file: raw.file,
    title: raw.title ?? null,
    // Stored raw like title: the schema's min(1) is the whole normalization, and a null
    // here means the re-file COALESCE keeps whatever the stored draft carries.
    tag: raw.tag ?? null,
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
    imagesJson,
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
        "File the text you want changed as draft entries for a human to author, approve or reject on the dashboard. One entry is one edit: a multi-line block is ONE entry, not one entry per line. anchor_text is verified against the file content you send. Re-filing a known anchor is safe: a draft updates in place; an approved, applied or rejected entry comes back untouched when the content you send still contains its anchor. The dashboard groups entries by project.",
      inputSchema: z.looseObject(FileEntriesArgs),
      outputSchema: FiledOutput,
    },
    async (args) => {
      const strictArgs = StrictFileEntriesArgs.safeParse(args);
      if (!strictArgs.success) {
        const keys = strictArgs.error.issues.flatMap((issue) => (issue.code === "unrecognized_keys" ? issue.keys : []));
        refuse(
          "arguments",
          `unrecognized key(s) ${keys.map((k) => JSON.stringify(k).slice(0, 60)).join(", ")}`,
          "file_entries takes only project, files, entries, and filed_by; drop the extra key or spell it snake_case",
        );
      }

      if (!SLUG.test(args.project)) {
        refuse(
          `project "${args.project}"`,
          "a project slug is 1-63 chars of lowercase letters, digits, and inner hyphens",
          'lower-case the name and separate words with hyphens, e.g. "my-app"',
        );
      }

      const files = validateFiles(args.files ?? [], args.entries);
      const entries = args.entries.map((raw, index) => validateEntry(index, raw, files));
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

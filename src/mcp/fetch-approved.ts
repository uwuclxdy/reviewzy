import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { approvedEntries, projectIdBySlug, type ApprovedEntryRow } from "../db/queries.ts";
import { mergedStyleGuide } from "../db/style-guide.ts";
import type { Store } from "../db/store.ts";

/**
 * The contract's three params, `project` required: there is no cross-project fetch — the merged
 * style guide is per-project, and the applying agent needs the voice of the project it writes into.
 */
const FetchApprovedArgs = z.object({
  project: z.string().min(1).describe("The project slug to fetch from."),
  ids: z.array(z.string().min(1)).min(1).optional().describe("Only these exact entry ids. Combines with since: both filters apply."),
  since: z.string().min(1).optional().describe("Resume a walk: pass the previous page's next_since to get the rows after it."),
});

/**
 * The read-side constraints shape: the same four fields the write boundary refuses to misspell,
 * but tolerated loosely — a row storing anything else (a hand-edited or foreign row, since no
 * writer of this server produced it) renders `{}` instead of failing an apply-back.
 */
const ParsedConstraints = z.strictObject({
  max_len: z.number().int().positive().optional(),
  placeholders: z.array(z.string()).optional(),
  tone: z.string().optional(),
  notes: z.string().optional(),
});

/** The wire entry the contract's parenthetical names: text + anchor + constraints, no status (everything here is approved) and no context. */
export const ApprovedEntry = z.object({
  id: z.string(),
  repo: z.string(),
  file: z.string(),
  anchor_text: z.string(),
  anchor_before: z.string(),
  anchor_after: z.string(),
  anchor_hash: z.string(),
  file_hash: z.string(),
  text: z.string().nullable(),
  constraints: ParsedConstraints,
});

const FetchApprovedOutput = z.object({
  entries: z.array(ApprovedEntry),
  style_guide: z.string().optional(),
  next_since: z.string().optional(),
});

/** A refusal is an ordinary thrown Error: the SDK answers it as a tool result with `isError: true`, never as a json-rpc protocol error. */
function refuse(where: string, problem: string, fix: string): never {
  throw new Error(`fetch_approved refused: ${where}: ${problem}. fix: ${fix}`);
}

/**
 * The stored constraints json, or the empty object when it does not parse into the typed shape —
 * the same tolerance class as the style-guide reads: an unparseable value is a foreign or
 * hand-edited row, never a reason to fail the fetch.
 */
function parseConstraints(json: string): z.infer<typeof ParsedConstraints> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const result = ParsedConstraints.safeParse(parsed);
      if (result.success) return result.data;
    }
  } catch {
    // fall through to the empty object
  }
  return {};
}

/**
 * The one mapping from approved store rows to the wire shape; fetch_approved and await_approved
 * share it, so the two tools' entries arrays cannot drift.
 */
export function approvedRowsToWire(rows: readonly ApprovedEntryRow[]): z.infer<typeof ApprovedEntry>[] {
  return rows.map((row) => ({
    id: row.id,
    repo: row.repo,
    file: row.file,
    anchor_text: row.anchor_text,
    anchor_before: row.anchor_before,
    anchor_after: row.anchor_after,
    anchor_hash: row.anchor_hash,
    file_hash: row.file_hash,
    text: row.human_text,
    constraints: parseConstraints(row.constraints),
  }));
}

/**
 * Registers the contract's apply-back tool: approved prose, anchors, and constraints, with the
 * merged style guide embedded so a bulk rewrite shares one voice. The project lookup and the
 * refusal sit here, not in the query: reads never auto-create a project, so an unknown slug must
 * surface as a business refusal naming the slug and the fix before any query runs.
 */
export function registerFetchApprovedTool(server: McpServer, store: Store): void {
  server.registerTool(
    "fetch_approved",
    {
      title: "Fetch approved entries to apply",
      description:
        "Fetch a project's approved entries, ready to apply: the human-signed text, the anchor to locate and replace it by, and the constraints the replacement must keep. Only approved entries are returned: an id naming a draft, applied or rejected entry contributes nothing. At most 50 per page, ordered by ascending id; when next_since comes back, pass it back as since to continue. The merged style guide rides the first page of a walk (neither ids nor since) so bulk rewrites pay it once.",
      inputSchema: FetchApprovedArgs,
      outputSchema: FetchApprovedOutput,
    },
    async (args) => {
      const projectId = projectIdBySlug(store, args.project);
      if (projectId === null) {
        refuse(
          `project "${args.project}"`,
          "no such project, and a read tool never creates one",
          "file an entry into it with file_entries first, then fetch again",
        );
      }

      const { rows, nextSince } = approvedEntries(store, projectId, { ids: args.ids, since: args.since });

      const output = {
        entries: approvedRowsToWire(rows),
        // The guide rides a walk's first page only — a call carrying neither ids nor since.
        // Continuation pages and targeted id fetches omit it: the same text is the style-guide
        // resource, so a bulk rewrite pays it once per walk.
        ...(args.ids === undefined && args.since === undefined
          ? { style_guide: mergedStyleGuide(store, args.project) }
          : {}),
        // An exhausted walk carries no `next_since` key at all: absent is the signal to stop, so an
        // empty page must never smuggle one in.
        ...(nextSince === null ? {} : { next_since: nextSince }),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}

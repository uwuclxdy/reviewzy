import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { listEntries, listProjects, projectIdBySlug } from "../db/queries.ts";
import type { EntryRow } from "../db/queries.ts";
import type { Store } from "../db/store.ts";

/**
 * Every filter optional, `limit` bounded at the boundary rather than clamped: a caller asking for
 * 201 rows gets a refusal naming the field, never a silently smaller page. The `ids` and `q`
 * minimums refuse the degenerate inputs (an empty list, an empty search) instead of guessing what
 * they meant.
 */
const ListEntriesArgs = z.object({
  project: z.string().min(1).optional().describe("Only entries of this project slug."),
  status: z.enum(["draft", "approved", "applied", "rejected"]).optional().describe("Only entries in this status: draft, approved, applied, or rejected. Unset = all statuses."),
  ids: z.array(z.string().min(1)).min(1).optional().describe("Only these exact entry ids."),
  q: z.string().min(1).optional().describe("Case-insensitive substring (ASCII-only case fold) over file, anchor_text, agent_draft, and human_text."),
  limit: z.number().int().min(1).max(200).default(50).describe("Rows per page (max: 200, default 50)."),
  cursor: z.string().min(1).optional().describe("Keyset pagination: pass the previous page's next_cursor to continue from after the last row returned."),
});

/**
 * Caller-supplied scalars are capped wire-side: a listed page's worst row is bounded even when a
 * caller filed a huge path or title. The store keeps the full value — the marker names what the
 * wire row dropped, and fetch_approved still returns the exact untruncated apply-back fields.
 */
const LEAN_CAP_CHARS = 200;

function ellipsize(value: string): string {
  // Code points, never UTF-16 units: an astral glyph straddling the boundary must not split.
  const glyphs = [...value];
  return glyphs.length <= LEAN_CAP_CHARS
    ? value
    : `${glyphs.slice(0, LEAN_CAP_CHARS).join("")}…+${glyphs.length - LEAN_CAP_CHARS} chars`;
}

/**
 * The one mapping from stored rows to the wire's lean index row: every kept field spelled out, so
 * a new store column reaches the wire only when someone adds it here deliberately — the default
 * for a new column is OFF the wire (`human_notes` must never reach it; anchors, drafts, texts,
 * context, constraints, hashes, and images stay fetch_approved/dashboard-side). The SDK passes
 * structuredContent through untouched, so this projection is the strip, not the schema.
 */
function toWireEntry(row: EntryRow, slugByProjectId: ReadonlyMap<string, string>): z.infer<typeof Entry> {
  return {
    id: row.id,
    project: slugByProjectId.get(row.project_id) ?? row.project_id,
    file: ellipsize(row.file),
    title: row.title === null ? null : ellipsize(row.title),
    status: row.status,
    updated_at: row.updated_at,
  };
}

/**
 * The contract's lean index row: short scalar fields only, no text payloads, no images — a listed
 * page of 200 rows must stay a page. The apply-back row is not reachable through this tool at all:
 * fetch_approved returns an approved entry's apply-back fields complete, and the dashboard reads
 * the store directly.
 */
const Entry = z.object({
  id: z.string(),
  project: z.string(),
  file: z.string(),
  title: z.string().nullable(),
  status: z.enum(["draft", "approved", "applied", "rejected"]),
  updated_at: z.number(),
});

const ListEntriesOutput = z.object({
  entries: z.array(Entry),
  next_cursor: z.string().optional(),
});

/** A refusal is an ordinary thrown Error: the SDK answers it as a tool result with `isError: true`, never as a json-rpc protocol error. */
function refuse(where: string, problem: string, fix: string): never {
  throw new Error(`list_entries refused: ${where}: ${problem}. fix: ${fix}`);
}

/**
 * Registers the contract's read tool. The project lookup and the refusal sit here, not in the
 * query: reads never auto-create a project, so an unknown slug must surface as a business refusal
 * naming the slug and the fix before any query runs.
 */
export function registerListEntriesTool(server: McpServer, store: Store): void {
  server.registerTool(
    "list_entries",
    {
      title: "List entries for review",
      description:
        "List the review queue's entries, ordered by ascending entry id. Every filter is optional and combines with AND. Walk pages via next_cursor; the walk is exhausted when it stops coming back. Each row is a lean index: id, project slug, file, title, status, updated_at. Apply-back fields (anchor, hashes, human text, constraints) come back through fetch_approved, and rejected or applied entries expose no agent-readable text anywhere — the dashboard owns authoring.",
      inputSchema: ListEntriesArgs,
      outputSchema: ListEntriesOutput,
    },
    async (args) => {
      let projectId: string | undefined;
      if (args.project !== undefined) {
        const id = projectIdBySlug(store, args.project);
        if (id === null) {
          refuse(
            `project "${args.project}"`,
            "no such project, and a read tool never creates one",
            "file an entry into it with file_entries first, then list again",
          );
        }
        projectId = id;
      }

      const { rows, nextCursor } = listEntries(store, {
        projectId,
        status: args.status,
        ids: args.ids,
        q: args.q,
        limit: args.limit,
        cursor: args.cursor,
      });

      // An exhausted walk carries no `next_cursor` key at all: absent is the signal to stop, so an
      // empty page must never smuggle one in. The slug map mirrors the dashboard's own
      // project_id → slug resolution (the store row carries the fk, never the slug).
      const slugByProjectId = new Map(listProjects(store).map((p) => [p.id, p.slug]));
      const output = {
        entries: rows.map((row) => toWireEntry(row, slugByProjectId)),
        ...(nextCursor === null ? {} : { next_cursor: nextCursor }),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}

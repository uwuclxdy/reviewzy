import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { listEntries, projectIdBySlug } from "../db/queries.ts";
import type { Store } from "../db/store.ts";

/**
 * Every filter optional, `limit` bounded at the boundary rather than clamped: a caller asking for
 * 201 rows gets a refusal naming the field, never a silently smaller page. The `ids` and `q`
 * minimums refuse the degenerate inputs (an empty list, an empty search) instead of guessing what
 * they meant.
 */
const ListEntriesArgs = z.object({
  project: z.string().min(1).optional(),
  status: z.enum(["draft", "approved", "applied", "rejected"]).optional(),
  ids: z.array(z.string().min(1)).min(1).optional(),
  q: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).optional(),
});

/** The wire row is the stored row, `context` and `constraints` kept as their stored JSON strings — no re-parse on the way out. */
const Entry = z.object({
  id: z.string(),
  project_id: z.string(),
  batch_id: z.string(),
  repo: z.string(),
  file: z.string(),
  anchor_text: z.string(),
  anchor_before: z.string(),
  anchor_after: z.string(),
  anchor_hash: z.string(),
  file_hash: z.string(),
  agent_draft: z.string().nullable(),
  human_text: z.string().nullable(),
  status: z.enum(["draft", "approved", "applied", "rejected"]),
  context: z.string(),
  constraints: z.string(),
  filed_by: z.string().nullable(),
  stale_note: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  applied_at: z.number().nullable(),
  archived_at: z.number().nullable(),
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
        "List entries in the review queue, ordered by ascending entry id (ulid, i.e. filing order) — the same order a cursor walk covers. Every filter is optional and they combine with AND: project (a slug with no project is refused: read tools never create one), status (draft, approved, applied, rejected), ids (exact entry ids), q (case-insensitive substring, ASCII-only case fold: a row matches when any of file, anchor_text, agent_draft, human_text contains it), limit (default 50, max 200 — a higher value is refused), cursor (keyset pagination: pass the previous page's next_cursor to continue from after the last entry returned). next_cursor is present only when the page returned exactly limit rows, meaning more may exist; absent means the walk is exhausted — stop paging then, never craft a cursor of your own. Each entry carries its stored fields as stored: id, project_id, batch_id, repo, file, anchor_text, anchor_before, anchor_after, anchor_hash, file_hash, agent_draft, human_text, status, context, constraints, filed_by, stale_note, created_at, updated_at, applied_at, archived_at — with context and constraints as their stored JSON strings, not parsed objects.",
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
      // empty page must never smuggle one in.
      const output = {
        entries: rows,
        ...(nextCursor === null ? {} : { next_cursor: nextCursor }),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}

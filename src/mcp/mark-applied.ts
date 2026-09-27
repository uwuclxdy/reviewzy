import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { markApplied, type EntryStatus } from "../db/queries.ts";
import type { Store } from "../db/store.ts";

/** sha256 as 64 lowercase hex chars: the same shape file_entries checks on a caller-supplied `file_hash`. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * The contract's four params. `applied_hash` and `found_text` are optional, and each is refused at
 * this boundary when malformed: the hash must be the sha256 hex shape, and an empty `found_text`
 * says nothing about what the anchor matched instead.
 */
const MarkAppliedArgs = z.object({
  id: z.string().min(1).describe("The entry id to report on."),
  result: z.enum(["applied", "anchor_stale"]).describe('`"applied"`: the approved text is in place; the entry moves to applied. `"anchor_stale"`: the anchor no longer matches the file; the entry returns to approved for re-anchoring on the dashboard.'),
  applied_hash: z.string().regex(SHA256_HEX).optional().describe("The sha256 of the text you applied, as 64 lowercase hex chars; the server does not read repos and records it unverified."),
  found_text: z.string().min(1).optional().describe("What the anchor matched instead, shown on the dashboard for re-anchoring."),
});

/** The loop-close answer: the id and the resulting status, nothing more. */
const MarkAppliedOutput = z.object({
  id: z.string(),
  status: z.enum(["applied", "approved"]),
});

/** A refusal is an ordinary thrown Error: the SDK answers it as a tool result with `isError: true`, never as a json-rpc protocol error. */
function refuse(where: string, problem: string, fix: string): never {
  throw new Error(`mark_applied refused: ${where}: ${problem}. fix: ${fix}`);
}

/**
 * Registers the contract's loop-close tool: the agent reports that it applied the approved text,
 * or that the anchor no longer matches. Wire shapes are validated here, the status machine lives
 * in `markApplied` (src/db/queries.ts), and this layer only formats the refusals the store returns
 * — naming the entry, its status, and the fix. The one rule that needs no store read, `applied_hash`
 * only ever being set by result "applied", is refused here naming the field.
 */
export function registerMarkAppliedTool(server: McpServer, store: Store): void {
  server.registerTool(
    "mark_applied",
    {
      title: "Report an applied entry or a stale anchor",
      description:
        "Report the outcome of applying one approved entry's text, closing the loop. Call it after applying the approved text in place, or when the anchor no longer matches the file.",
      inputSchema: MarkAppliedArgs,
      outputSchema: MarkAppliedOutput,
    },
    async (args) => {
      if (args.result === "anchor_stale" && args.applied_hash !== undefined) {
        refuse(
          `entry "${args.id}"`,
          'applied_hash is only ever set by result "applied", got result "anchor_stale"',
          'drop applied_hash, or report result "applied"',
        );
      }

      const outcome = markApplied(store, {
        id: args.id,
        result: args.result,
        appliedHash: args.applied_hash ?? null,
        foundText: args.found_text ?? null,
      });
      if (!outcome.ok) {
        if (outcome.refusal.kind === "unknown") {
          refuse(
            `entry "${args.id}"`,
            "no such entry",
            "file it with file_entries first, or list entries to see the ids that exist",
          );
        }
        const status: EntryStatus = outcome.refusal.status;
        if (status === "draft") {
          refuse(
            `entry "${args.id}"`,
            "status draft: a draft is inert until a human approves or rejects it, and an agent can never move it",
            "approve or reject it on the dashboard first, then report again",
          );
        }
        if (status === "rejected") {
          refuse(
            `entry "${args.id}"`,
            "status rejected: rejected is terminal and silences the agent",
            "file a new entry with a new anchor if the passage still needs changing",
          );
        }
        // The only pair left is an applied entry reported applied again: anchor_stale on an
        // applied entry is the third legal transition, so it never reaches this branch.
        refuse(
          `entry "${args.id}"`,
          "status applied: the entry is already applied",
          "nothing to do — re-file the entry only if the text changed and needs a fresh review",
        );
      }

      const output = { id: args.id, status: outcome.status };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}

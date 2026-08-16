import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { entriesByIds, type ApprovedEntryRow, type EntryStatus } from "../db/queries.ts";
import { STATUS_CHANGE_EVENT, type Store } from "../db/store.ts";
import { ApprovedEntry, approvedRowsToWire } from "./fetch-approved.ts";

/** The contract's wait ceiling: `timeout_ms` caps at 600000. */
export const AWAIT_TIMEOUT_MAX_MS = 600_000;

/** The contract's wait default: 60000ms. */
export const AWAIT_TIMEOUT_DEFAULT_MS = 60_000;

/** The sqlite poll cadence that backs the event bus: resolution comes from an event when one is available, a status read at this interval otherwise. */
const AWAIT_POLL_MS = 500;

/** The hint `docs/mcp-contract.md` pins for a timeout or a drain: retry after this long, never sooner. */
const AWAIT_POLL_AGAIN_MS = 5_000;

/**
 * The contract's clamp, pure so a unit test can pin it — a wire test cannot wait out 600 seconds.
 * The zod boundary already refuses anything below 1, so the floor here only guards direct calls.
 */
export function clampTimeoutMs(ms: number): number {
  return Math.min(Math.max(ms, 1), AWAIT_TIMEOUT_MAX_MS);
}

const AwaitApprovedArgs = z.object({
  ids: z.array(z.string().min(1)).min(1),
  timeout_ms: z.number().int().min(1).default(AWAIT_TIMEOUT_DEFAULT_MS),
});

const AwaitApprovedOutput = z.object({
  resolved: z.boolean(),
  statuses: z.record(z.string(), z.enum(["draft", "approved", "applied", "rejected"])),
  entries: z.array(ApprovedEntry).optional(),
  poll_again_after_ms: z.number().int().min(1).optional(),
});

type AwaitOutcome = {
  readonly resolved: boolean;
  readonly statuses: Record<string, EntryStatus>;
  readonly entries: z.infer<typeof ApprovedEntry>[];
};

/** A refusal is an ordinary thrown Error: the SDK answers it as a tool result with `isError: true`, never as a json-rpc protocol error. */
function refuse(where: string, problem: string, fix: string): never {
  throw new Error(`await_approved refused: ${where}: ${problem}. fix: ${fix}`);
}

/**
 * The one wait: every named id must be approved or rejected. The fast path is the store-scoped
 * event bus — any status change wakes a re-check, and the re-check is the decision — with a 500ms
 * sqlite poll as the backstop for a change that never dispatched, and the timeout as the ceiling.
 * Settles once: the first resolution wins, and every timer and listener is torn down so the
 * process exits cleanly. The drain path resolves the waiter through the store's waiter registry
 * with the same poll-again outcome as a timeout, whatever the statuses say at that moment.
 */
function waitForEntries(store: Store, ids: readonly string[], timeoutMs: number): Promise<AwaitOutcome> {
  return new Promise((resolve) => {
    let settled = false;

    function settle(outcome: AwaitOutcome): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      store.events.removeEventListener(STATUS_CHANGE_EVENT, recheck);
      unregister();
      resolve(outcome);
    }

    function evaluate(): AwaitOutcome {
      const rows = entriesByIds(store, ids);
      const statuses: Record<string, EntryStatus> = {};
      const approved: ApprovedEntryRow[] = [];
      for (const row of rows) {
        statuses[row.id] = row.status;
        if (row.status === "approved") approved.push(row);
      }
      // The status map's contract is one key per named id, so a row that vanished since the
      // up-front check (the planned retention sweep moves rows to the archive) must not resolve
      // the wait with the id silently missing: keep waiting, and the caller's next call surfaces
      // the missing id in the up-front refusal.
      const done =
        rows.length === ids.length &&
        rows.every((row) => row.status === "approved" || row.status === "rejected");
      return done
        ? { resolved: true, statuses, entries: approvedRowsToWire(approved) }
        : { resolved: false, statuses, entries: [] };
    }

    function recheck(): void {
      const outcome = evaluate();
      // The event and the poll settle only a resolved wait; the timeout settles with the current
      // state, and a drain with the current statuses forced into the poll-again shape.
      if (outcome.resolved) settle(outcome);
    }

    function settleDrain(): void {
      const outcome = evaluate();
      // The drain's pin: always the poll-again shape, because the daemon is leaving — a
      // resolved:true would hand the client a completed answer with no daemon behind it.
      settle({ ...outcome, resolved: false });
    }

    const timeout = setTimeout(() => settle(evaluate()), timeoutMs);
    const poll = setInterval(recheck, AWAIT_POLL_MS);
    store.events.addEventListener(STATUS_CHANGE_EVENT, recheck);
    const unregister = store.registerWaiter(settleDrain);

    // The rows may already be resolved when the wait starts: the answer then is immediate.
    recheck();
  });
}

/**
 * Registers the contract's blocking tool: a live session waits until every named id reaches
 * approved or rejected. The up-front existence check and the refusal sit here, not in the query:
 * reads never auto-create anything, so an unknown id must surface as a business refusal naming it
 * before any waiting begins.
 */
export function registerAwaitApprovedTool(server: McpServer, store: Store): void {
  server.registerTool(
    "await_approved",
    {
      title: "Wait for entries to be approved or rejected",
      description:
        "Block until every named entry reaches approved or rejected, holding the call open — the one long-poll on this server, for a live session that filed entries and wants to sleep until the human signs off instead of polling fetch_approved. ids: the exact entry ids to wait for; duplicates are deduped silently, and the status map carries one key per id. timeout_ms: how long to block, default 60000, capped at 600000 — a larger value is clamped, never refused. Resolves when every named id is approved or rejected: resolved true, statuses one per named id, and entries the approved rows only, each in fetch_approved's row shape (id, repo, file, anchor_text, anchor_before, anchor_after, anchor_hash, file_hash, text, constraints parsed) — a rejected id appears in statuses only, never in entries. On timeout: resolved false, the current per-id statuses, and poll_again_after_ms 5000 — never an error; call again with the same ids to keep waiting. Refused, naming the id and the fix: an id that does not exist at call time (a read tool never creates one). An entry in applied does not resolve the wait: only approved or rejected does.",
      inputSchema: AwaitApprovedArgs,
      outputSchema: AwaitApprovedOutput,
    },
    async (args) => {
      const ids = [...new Set(args.ids)];
      const timeoutMs = clampTimeoutMs(args.timeout_ms);

      const existing = new Set(entriesByIds(store, ids).map((row) => row.id));
      const missing = ids.filter((id) => !existing.has(id));
      if (missing.length > 0) {
        refuse(
          `entry "${missing[0]!}"${missing.length > 1 ? ` and ${missing.length - 1} more` : ""}`,
          "no such entry, and a read tool never creates one",
          "file it with file_entries first, or list entries to see the ids that exist",
        );
      }

      const outcome = await waitForEntries(store, ids, timeoutMs);
      const output = outcome.resolved
        ? { resolved: true, statuses: outcome.statuses, entries: outcome.entries }
        : { resolved: false, statuses: outcome.statuses, poll_again_after_ms: AWAIT_POLL_AGAIN_MS };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    },
  );
}

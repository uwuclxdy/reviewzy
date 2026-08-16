import { McpServer } from "@modelcontextprotocol/server";
import type { Config } from "../config.ts";
import type { Store } from "../db/store.ts";
import { registerAwaitApprovedTool } from "./await-approved.ts";
import { registerFetchApprovedTool } from "./fetch-approved.ts";
import { registerFileEntriesTool } from "./file-entries.ts";
import { registerListEntriesTool } from "./list-entries.ts";
import { registerMarkAppliedTool } from "./mark-applied.ts";
import { registerStyleGuideResource } from "./style-guide-resource.ts";
import type { Notifier } from "../notify.ts";
import { NAME, VERSION } from "../version.ts";

/**
 * Read by a client before it calls anything, so it states the rule an agent cannot discover from a
 * tool signature: prose belongs to the human, and filing a draft is not shipping it.
 */
const INSTRUCTIONS = `reviewzy is a review queue for user-facing text. Agents draft, a human signs off.

File the strings you want to change as draft entries against a project. A human authors or approves the wording on the dashboard, then you fetch those words back and apply them in place. You can create a draft, move an approved entry to applied, and report an anchor that no longer matches. You can never approve or reject an entry, and a rejected anchor stays rejected: re-filing it returns the existing entry instead of proposing the line again.`;

/**
 * A fresh server per request, since the 2026-07-28 revision is stateless and `createMcpHandler`
 * builds one instance per HTTP request. Every instance registers the tools over the same store the
 * daemon opened at boot, so the write path never opens a connection of its own; later queue tasks
 * register theirs the same way.
 */
export function createMcpServer(config: Config, store: Store, notifier: Notifier): McpServer {
  const server: McpServer = new McpServer(
    { name: NAME, version: VERSION },
    {
      // The keys do not gate handler registration: `registerTool` and `registerResource` install
      // the `tools/*` and `resources/*` handlers regardless, and merge a dropped key back in with
      // `listChanged` defaulted to `true` (measured on this SDK). The keys' real job is pinning
      // that `listChanged` to `false`: v1 has no notification stream to carry the change
      // notification, and an advertised `true` is what makes the SDK honor a client's
      // `toolsListChanged`/`resourcesListChanged` subscription request.
      capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
      instructions: INSTRUCTIONS,
      // The SDK's own default is `ttlMs: 0`, which tells a client the answer is already stale. Both
      // of these are fixed for a running daemon, so they are good for as long as the process lives.
      // `private` because the endpoint can be bearer-guarded, and a `public` result may be served to
      // any caller by a shared cache. `resources/templates/list` is pinned to 60s by the contract,
      // and `resources/read` carries the same values from the resource's own cacheHint.
      cacheHints: {
        "server/discover": { ttlMs: 3_600_000, cacheScope: "private" },
        "tools/list": { ttlMs: 3_600_000, cacheScope: "private" },
        "resources/templates/list": { ttlMs: 60_000, cacheScope: "private" },
      },
    },
  );

  registerFileEntriesTool(server, config.baseUrl, store, notifier);
  registerListEntriesTool(server, store);
  registerFetchApprovedTool(server, store);
  registerMarkAppliedTool(server, store);
  registerAwaitApprovedTool(server, store);
  registerStyleGuideResource(server, store);
  return server;
}

import { McpServer } from "@modelcontextprotocol/server";
import type { Config } from "../config.ts";
import type { Store } from "../db/store.ts";
import { registerFileEntriesTool } from "./file-entries.ts";
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
export function createMcpServer(config: Config, store: Store): McpServer {
  const server: McpServer = new McpServer(
    { name: NAME, version: VERSION },
    {
      // Without `tools`, `McpServer` never registers `tools/list` at all. `listChanged` is explicit
      // because the SDK fills it with `true`, and v1 has no notification stream to carry one: a
      // client would register a handler that never fires, and the same flag is what makes the SDK
      // accept a `toolsListChanged` subscription for a stream that does not exist.
      capabilities: { tools: { listChanged: false } },
      instructions: INSTRUCTIONS,
      // The SDK's own default is `ttlMs: 0`, which tells a client the answer is already stale. Both
      // of these are fixed for a running daemon, so they are good for as long as the process lives.
      // `private` because the endpoint can be bearer-guarded, and a `public` result may be served to
      // any caller by a shared cache.
      cacheHints: {
        "server/discover": { ttlMs: 3_600_000, cacheScope: "private" },
        "tools/list": { ttlMs: 3_600_000, cacheScope: "private" },
      },
    },
  );

  registerFileEntriesTool(server, config.baseUrl, store);
  return server;
}

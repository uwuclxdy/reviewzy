import { ResourceNotFoundError, ResourceTemplate } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { projectIdBySlug } from "../db/queries.ts";
import { mergedStyleGuide } from "../db/style-guide.ts";
import type { Store } from "../db/store.ts";

/** The pinned resource of `docs/mcp-contract.md`'s resource section; `{slug}` is the only variable. */
const STYLE_GUIDE_TEMPLATE = "reviewzy://projects/{slug}/style-guide";

/**
 * Registers the contract's one resource: the merged style guide, served to a drafting agent before
 * it writes a word. `list` stays undefined so the template is advertised through
 * `resources/templates/list` only — v1 has no notification stream, and a client enumerating
 * concrete `resources/list` entries would be fed a list it cannot subscribe to.
 */
export function registerStyleGuideResource(server: McpServer, store: Store): void {
  server.registerResource(
    "style-guide",
    new ResourceTemplate(STYLE_GUIDE_TEMPLATE, { list: undefined }),
    {
      title: "Style guide",
      description:
        "The merged style guide for a project: the global guide, then the project's own rules below it, then the union of banned words and the glossary (a term defined in both resolves to the project). Read this before drafting any entry.",
      mimeType: "text/markdown",
      // The read is a pure function of the store, so a 60s TTL is safe; `private` because the
      // endpoint can be bearer-guarded and a shared cache may not serve one tenant's copy to
      // another. The same values must appear on `resources/templates/list` via the server-level
      // cacheHints entry in src/mcp/server.ts.
      cacheHint: { ttlMs: 60_000, cacheScope: "private" },
    },
    (uri, variables) => {
      const slug = String(variables.slug);
      if (projectIdBySlug(store, slug) === null) {
        // The SDK's own miss shape: `-32602` with `data.uri`, never a business tool result.
        throw new ResourceNotFoundError(uri.href);
      }
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: mergedStyleGuide(store, slug) }] };
    },
  );
}

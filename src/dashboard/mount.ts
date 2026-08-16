import type { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { html } from "hono/html";
import type { Config } from "../config.ts";
import type { Store } from "../db/store.ts";
import { dashboardPage, entriesFragment } from "./views.tsx";
import type { ListParams } from "./views.tsx";

/** The directory the vendored assets live in, resolved from this module's own location, so the mount works from any cwd. */
const STATIC_ROOT = new URL("./static/", import.meta.url).pathname;

/**
 * Mounts the dashboard: the entry list at `/` and the vendored assets under `/static/`.
 * The Origin gate is app-wide in `createApp`, so no route here re-adds it; `config` is
 * reserved for `DASHBOARD_PASSWORD`, which task 14 gates the dashboard behind.
 */
export function mountDashboard(app: Hono, config: Config, store: Store): void {
  void config;

  app.get("/", (c) => {
    const params: ListParams = {
      q: c.req.query("q"),
      status: c.req.query("status"),
      project: c.req.query("project"),
    };
    // htmx marks its requests with HX-Request; those get the list region alone, swapped into
    // #entries-list. Everything else is a navigation and gets the full page.
    if (c.req.header("HX-Request") !== undefined) {
      return c.html(entriesFragment(store, params));
    }
    return c.html(html`<!doctype html>${dashboardPage(store, params)}`);
  });

  // serveStatic refuses traversal itself (the guard runs on the decoded request path, before the
  // rewrite, so `..` and `//` never reach STATIC_ROOT), and the mime map covers the vendored set:
  // css, js, woff2, txt. The rewrite drops the route's own prefix: serveStatic would otherwise join
  // the full request path (`/static/tokens.css`) onto the root and find nothing.
  app.get(
    "/static/*",
    serveStatic({ root: STATIC_ROOT, rewriteRequestPath: (path) => path.replace(/^\/static/, "") }),
  );
}

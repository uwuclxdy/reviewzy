import type { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { html } from "hono/html";
import type { Config } from "../config.ts";
import { saveHumanText } from "../db/human-save.ts";
import type { Store } from "../db/store.ts";
import {
  dashboardPage,
  editorFragment,
  editorPage,
  entriesFragment,
  entryGoneFragment,
  formatSaveRefusal,
  loadEditor,
  notFoundPage,
} from "./views.tsx";
import type { EditorState, ListParams } from "./views.tsx";

/** The directory the vendored assets live in, resolved from this module's own location, so the mount works from any cwd. */
const STATIC_ROOT = new URL("./static/", import.meta.url).pathname;

/**
 * Mounts the dashboard: the entry list at `/`, the entry editor at `/entries/:id`, its save at
 * `/entries/:id/save`, and the vendored assets under `/static/`. The Origin gate is app-wide in
 * `createApp`, so no route here re-adds it; `config` is reserved for `DASHBOARD_PASSWORD`, which
 * task 14 gates the dashboard behind.
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

  // The editor page; an unknown id is a true 404 page with the way onward.
  app.get("/entries/:id", (c) => {
    const vm = loadEditor(store, c.req.param("id"));
    if (vm === null) return c.html(html`<!doctype html>${notFoundPage()}`, 404);
    return c.html(html`<!doctype html>${editorPage(vm)}`);
  });

  // The one save path. The store layer owns every decision (refusals, the single revision write,
  // the draft→approved transition); this route only formats the outcome. htmx requests get the
  // editor region swapped in; a plain navigation gets the Post/Redirect/Get redirect on success
  // and the full page with the refusal callout otherwise.
  app.post("/entries/:id/save", async (c) => {
    const id = c.req.param("id");
    const form = await c.req.formData();
    // The store owns every semantic (empty refusal, no-op equality, max_len) on the authored
    // bytes; this route only formats the outcome, so the text is passed raw. Trimming here would
    // store bytes the author never saw and desync the client's char counter from the length the
    // server refuses on. A non-string part (a crafted multipart file) is treated as missing.
    const raw = form.get("text");
    const text = typeof raw === "string" ? raw : "";
    const outcome = saveHumanText(store, { id, text });

    if (!outcome.ok && outcome.refusal.kind === "unknown") {
      // htmx will not swap a 4xx, so the save response on a vanished id is a 200 fragment with the
      // way onward inside the editor region itself; the GET above stays a true 404.
      return c.html(entryGoneFragment());
    }
    const vm = loadEditor(store, id);
    if (vm === null) return c.html(entryGoneFragment());
    const state: EditorState = {
      submittedText: text,
      // The unknown case returned above, so this re-check is what narrows the refusal for the
      // formatter: `outcome.ok` alone would leave `unknown` reachable in TS's view.
      refusal: !outcome.ok && outcome.refusal.kind !== "unknown" ? formatSaveRefusal(outcome.refusal) : undefined,
    };
    if (c.req.header("HX-Request") === undefined) {
      if (outcome.ok) return c.redirect(`/entries/${id}`, 303);
      return c.html(html`<!doctype html>${editorPage(vm, state)}`);
    }
    return c.html(editorFragment(vm, state));
  });
}

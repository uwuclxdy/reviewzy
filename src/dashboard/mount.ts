import type { Context, Hono } from "hono";
import { serveStatic } from "hono/bun";
import { html } from "hono/html";
import type { Config } from "../config.ts";
import { approveEntry, batchApproveEntries, rejectEntry, saveHumanText } from "../db/human-save.ts";
import type { ApproveOutcome, BatchApproveResult, RejectOutcome, TransitionRefusal } from "../db/human-save.ts";
import { projectIdBySlug } from "../db/queries.ts";
import { parseStyleGuideForm, upsertStyleGuide } from "../db/style-guide.ts";
import type { StyleGuideForm } from "../db/style-guide.ts";
import type { Store } from "../db/store.ts";
import {
  dashboardPage,
  editorFragment,
  editorPage,
  editorViewFragment,
  editorViewGoneFragment,
  entriesFragment,
  entryGoneFragment,
  formatSaveRefusal,
  formatStyleGuideRefusal,
  formatTransitionRefusal,
  getEntry,
  loadEditor,
  loadStyleGuide,
  loginPage,
  notFoundPage,
  styleGuidePage,
  styleGuideRegionFragment,
} from "./views.tsx";
import type { EditorState, ListNotice, ListParams, StyleGuideEditorState } from "./views.tsx";
import { createSessionAuth, safeNext } from "./auth.ts";

/** The directory the vendored assets live in, resolved from this module's own location, so the mount works from any cwd. */
const STATIC_ROOT = new URL("./static/", import.meta.url).pathname;

/**
 * Mounts the dashboard: the entry list at `/`, the entry editor at `/entries/:id`, its save at
 * `/entries/:id/save`, the approve and reject transitions, the batch approve, the style guide
 * editor at `/style-guide` with its save at `/style-guide/save`, and the vendored assets under
 * `/static/`. The Origin gate is app-wide in `createApp`, so no route here re-adds it. A set
 * `DASHBOARD_PASSWORD` gates every dashboard route behind a signed session cookie and mounts the
 * login surface; unset, the dashboard stays open and the auth surface does not exist.
 */
export function mountDashboard(app: Hono, config: Config, store: Store): void {
  const auth = createSessionAuth(config.DASHBOARD_PASSWORD);

  if (auth.enabled) {
    // The gate, registered before every dashboard route so nothing below it answers unsigned.
    // Exempt: the auth surface itself (both spellings of each path), the vendored assets
    // (css/js/fonts, never data), and the mcp/health/drain surface this app mounts ahead of the
    // dashboard, which owns its own gates. Everything else fails closed. htmx requests answer 401
    // with HX-Redirect so the browser follows the login instead of swapping it into the target
    // region (a 303 would swap the login page into the list); a plain GET redirects with the path
    // as `next` so the login lands back; a plain POST goes to the login without one.
    app.use("*", async (c, next) => {
      const path = c.req.path;
      if (
        path === "/login" ||
        path === "/login/" ||
        path === "/logout" ||
        path === "/logout/" ||
        path === "/mcp" ||
        path === "/health" ||
        path === "/drain" ||
        path.startsWith("/static/")
      ) {
        return next();
      }
      if (await auth.accept(c.req.header("Cookie"))) return next();
      if (c.req.header("HX-Request") !== undefined) {
        return new Response(null, { status: 401, headers: { "HX-Redirect": "/login" } });
      }
      if (c.req.method === "GET") {
        const url = new URL(c.req.url);
        return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, 303);
      }
      return c.redirect("/login", 303);
    });

    // The login surface. GET /login renders the form (a signed-in visitor goes straight through,
    // honoring a safe `next`); POST /login is the one credential check, a timing-safe compare,
    // and sets the session cookie on success; the failure re-renders the form with one message
    // and the field cleared. POST /logout clears the cookie; it is exempt from the gate so it is
    // idempotent when already signed out. Each route also answers its trailing-slash spelling:
    // hono matches paths exactly, so a visitor who typed the slash would otherwise be bounced into
    // a dead end after authenticating, and a signed-in /logout/ would never clear the session.
    const loginPageHandler = async (c: Context): Promise<Response> => {
      const next = safeNext(c.req.query("next"));
      if (await auth.accept(c.req.header("Cookie"))) {
        // A signed-in visitor goes to their destination; a `next` that points back at the login
        // page itself would redirect forever, so it means the list.
        const destination =
          next === undefined || next === "/login" || next.startsWith("/login?") || next.startsWith("/login/") ? "/" : next;
        return c.redirect(destination, 303);
      }
      return c.html(html`<!doctype html>${loginPage(next)}`);
    };
    app.get("/login", loginPageHandler);
    app.get("/login/", loginPageHandler);

    app.post("/login", async (c) => {
      // A uniform floor on every attempt, before anything else is parsed or compared: without it,
      // a failure would answer faster than a success and the credential check would leak through
      // timing to the same local attacker the delay is meant to slow. Constant and stateless, so
      // the no-lockout, no-rate-limiting surface is unchanged.
      await new Promise((resolve) => setTimeout(resolve, 250));
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        // A malformed body (a JSON request, a broken boundary) is a failed attempt like any other,
        // never a 500 at the credential boundary; the `next` it carried is unreadable.
        return c.html(html`<!doctype html>${loginPage(undefined, "Wrong password. Try again.")}`);
      }
      const next = safeNext(form.get("next"));
      const presented = form.get("password");
      if (typeof presented === "string" && (await auth.acceptPassword(presented))) {
        c.header("set-cookie", auth.setCookieHeader(await auth.sign()));
        return c.redirect(next ?? "/", 303);
      }
      return c.html(html`<!doctype html>${loginPage(next, "Wrong password. Try again.")}`);
    });

    const logoutHandler = (c: Context): Response => {
      c.header("set-cookie", auth.clearCookieHeader());
      return c.redirect("/login", 303);
    };
    app.post("/logout", logoutHandler);
    app.post("/logout/", logoutHandler);
  }

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
    return c.html(html`<!doctype html>${dashboardPage(store, params, undefined, auth.enabled)}`);
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
    if (vm === null) return c.html(html`<!doctype html>${notFoundPage(auth.enabled)}`, 404);
    return c.html(html`<!doctype html>${editorPage(vm, undefined, auth.enabled)}`);
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
      // way onward inside the editor view itself; the GET above stays a true 404.
      return c.html(editorViewGoneFragment());
    }
    const vm = loadEditor(store, id);
    if (vm === null) return c.html(editorViewGoneFragment());
    const state: EditorState = {
      submittedText: text,
      // The unknown case returned above, so this re-check is what narrows the refusal for the
      // formatter: `outcome.ok` alone would leave `unknown` reachable in TS's view.
      refusal:
        !outcome.ok && outcome.refusal.kind !== "unknown"
          ? { title: "Text not saved", body: formatSaveRefusal(outcome.refusal) }
          : undefined,
    };
    if (c.req.header("HX-Request") === undefined) {
      if (outcome.ok) return c.redirect(`/entries/${id}`, 303);
      return c.html(html`<!doctype html>${editorPage(vm, state, auth.enabled)}`);
    }
    // The save swap targets the whole editor view, so the diff's after-side re-renders with the
    // authored text; the transitions below answer with the region fragment only.
    return c.html(editorViewFragment(vm, state));
  });

  // The two transitions. One route answers both the editor and the list: the buttons in the editor
  // form carry a `view=editor` marker (htmx includes the closest form's inputs), the list's buttons
  // carry the batch form's filters. Everything the store refuses is formatted here; the store's
  // transition functions did the writing or not at all.
  app.post("/entries/:id/approve", async (c) => {
    const id = c.req.param("id");
    const outcome = approveEntry(store, id);
    const form = await c.req.formData();
    if (form.get("view") === "editor") return transitionEditorReply(c, store, id, outcome, "approve", auth.enabled);
    const notice = outcome.ok ? undefined : transitionNotice(store, "approve", id, outcome);
    return listReply(c, store, form, notice, outcome.ok, auth.enabled);
  });

  app.post("/entries/:id/reject", async (c) => {
    const id = c.req.param("id");
    const outcome = rejectEntry(store, id);
    const form = await c.req.formData();
    if (form.get("view") === "editor") return transitionEditorReply(c, store, id, outcome, "reject", auth.enabled);
    const notice = outcome.ok ? undefined : transitionNotice(store, "reject", id, outcome);
    return listReply(c, store, form, notice, outcome.ok, auth.enabled);
  });

  // The batch approve: every selected id goes through the store's own approve independently, so one
  // refusal never blocks another's approval. An empty selection is refused with a message, never a
  // silent no-op.
  app.post("/batch-approve", async (c) => {
    const form = await c.req.formData();
    const ids = form.getAll("id").filter((value): value is string => typeof value === "string");
    const results = batchApproveEntries(store, ids);
    const notice = batchNotice(store, results);
    return listReply(c, store, form, notice, false, auth.enabled);
  });

  // The style guide editor: one section per page, the global guide at `/style-guide` and a
  // project's at `?project=<slug>`. The selector is a list of links; a slug that resolves to
  // nothing renders the editor with a notice, never a 500 and never a row (the store never mints a
  // project). The guard above covers both routes like every other dashboard route.
  app.get("/style-guide", (c) => {
    const vm = loadStyleGuide(store, c.req.query("project"));
    return c.html(html`<!doctype html>${styleGuidePage(vm, undefined, auth.enabled)}`);
  });

  app.post("/style-guide/save", async (c) => {
    const form = await c.req.formData();
    const projectValue = form.get("project");
    // `project` empty or missing means the global section, exactly as the hidden input renders it.
    const projectSlug = typeof projectValue === "string" && projectValue !== "" ? projectValue : null;
    // The boundary parse types the three fields. A non-string part (a crafted multipart file) is
    // treated as missing, and markdown stays raw: the merge trims at render, and trimming here
    // would store bytes the author never saw.
    const field = (key: string) => {
      const value = form.get(key);
      return typeof value === "string" ? value : "";
    };
    const raw: StyleGuideForm = {
      markdown: field("markdown"),
      bannedWordsCsv: field("banned_words"),
      glossaryText: field("glossary"),
    };

    // The store owns the write; this route owns the two refusals the parse cannot name: the
    // malformed glossary line (nothing written) and the vanished project (the store's upsert would
    // throw, and the editor never mints one).
    const parsed = parseStyleGuideForm(raw);
    let notice: StyleGuideEditorState["notice"];
    if (!parsed.ok) {
      const formatted = formatStyleGuideRefusal(parsed.refusal);
      notice = { kind: "refusal", title: formatted.title, body: formatted.body };
    } else if (projectSlug !== null && projectIdBySlug(store, projectSlug) === null) {
      notice = { kind: "unknown_project" };
    } else {
      upsertStyleGuide(store, projectSlug, parsed.input);
      notice = { kind: "saved" };
    }

    const vm = loadStyleGuide(store, projectSlug ?? undefined);
    const state: StyleGuideEditorState = { submitted: raw, notice };
    if (c.req.header("HX-Request") === undefined) {
      if (notice.kind === "saved") {
        return c.redirect(projectSlug === null ? "/style-guide" : `/style-guide?project=${encodeURIComponent(projectSlug)}`, 303);
      }
      return c.html(html`<!doctype html>${styleGuidePage(vm, state, auth.enabled)}`);
    }
    return c.html(styleGuideRegionFragment(vm, state));
  });
}

/** The three filters straight off an action's POST body, kept alive across a re-render. */
async function listParamsFrom(form: FormData): Promise<ListParams> {
  const get = (key: string) => {
    const value = form.get(key);
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  return { q: get("q"), status: get("status"), project: get("project") };
}

/** An action round's settled notice: the full page for a plain navigation, the list region for htmx. */
async function listReply(
  c: Context,
  store: Store,
  form: FormData,
  notice: ListNotice | undefined,
  ok: boolean,
  signedIn: boolean,
) {
  const params = await listParamsFrom(form);
  if (c.req.header("HX-Request") === undefined) {
    if (ok) return c.redirect("/", 303);
    return c.html(html`<!doctype html>${dashboardPage(store, params, notice, signedIn)}`);
  }
  return c.html(entriesFragment(store, params, notice));
}

/** A transition's refusal as the list region's notice: unknown ids and vanished rows get their own. */
function transitionNotice(
  store: Store,
  action: "approve" | "reject",
  id: string,
  outcome: { readonly ok: false; readonly refusal: TransitionRefusal },
): ListNotice {
  const title = action === "approve" ? "Entry not approved" : "Entry not rejected";
  if (outcome.refusal.kind === "unknown") {
    return { kind: "refusal", title: "This entry no longer exists", message: "It's no longer in the store. The list below shows the current entries." };
  }
  const entry = getEntry(store, id);
  if (entry === undefined) {
    return { kind: "refusal", title, message: "The entry is no longer in the store." };
  }
  return { kind: "refusal", title, message: formatTransitionRefusal(action, outcome.refusal, entry.file) };
}

/** The batch report: how many moved, each refusal named; an empty selection is its own refusal. */
function batchNotice(store: Store, results: readonly BatchApproveResult[]): ListNotice {
  if (results.length === 0) {
    return { kind: "refusal", title: "Nothing to approve", message: "Select at least one entry, then approve again." };
  }
  const approved = results.filter((r) => r.ok).length;
  const refused = results.filter((r) => !r.ok).map((r) => {
    if (r.refusal.kind === "unknown") return "The entry is no longer in the store.";
    const entry = getEntry(store, r.id);
    return formatTransitionRefusal("approve", r.refusal, entry?.file ?? r.id);
  });
  return { kind: "batch", approved, total: results.length, refused };
}

/** A transition's answer to the editor: the region swapped in place, with any refusal on top. */
function transitionEditorReply(
  c: Context,
  store: Store,
  id: string,
  outcome: ApproveOutcome | RejectOutcome,
  action: "approve" | "reject",
  signedIn: boolean,
) {
  if (!outcome.ok && outcome.refusal.kind === "unknown") return c.html(entryGoneFragment());
  const vm = loadEditor(store, id);
  if (vm === null) return c.html(entryGoneFragment());
  const state: EditorState = {
    submittedText: vm.entry.human_text ?? vm.entry.agent_draft ?? "",
    // The unknown case returned above, so this re-check is what narrows the refusal for the
    // formatter: `outcome.ok` alone would leave `unknown` reachable in TS's view.
    refusal:
      !outcome.ok && outcome.refusal.kind !== "unknown"
        ? { title: action === "approve" ? "Entry not approved" : "Entry not rejected", body: formatTransitionRefusal(action, outcome.refusal, vm.entry.file) }
        : undefined,
  };
  if (c.req.header("HX-Request") === undefined) {
    if (outcome.ok) return c.redirect(`/entries/${id}`, 303);
    return c.html(html`<!doctype html>${editorPage(vm, state, signedIn)}`);
  }
  return c.html(editorFragment(vm, state));
}

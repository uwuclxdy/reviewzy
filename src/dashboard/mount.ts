import type { Context, Hono } from "hono";
import { serveStatic } from "hono/bun";
import { html } from "hono/html";
import type { Config } from "../config.ts";
import { approveEntry, batchApproveEntries, rejectEntry, saveHumanText } from "../db/human-save.ts";
import type { ApproveOutcome, BatchApproveResult, RejectOutcome, TransitionRefusal } from "../db/human-save.ts";
import type { Store } from "../db/store.ts";
import {
  dashboardPage,
  editorFragment,
  editorPage,
  entriesFragment,
  entryGoneFragment,
  formatSaveRefusal,
  formatTransitionRefusal,
  getEntry,
  loadEditor,
  notFoundPage,
} from "./views.tsx";
import type { EditorState, ListNotice, ListParams } from "./views.tsx";

/** The directory the vendored assets live in, resolved from this module's own location, so the mount works from any cwd. */
const STATIC_ROOT = new URL("./static/", import.meta.url).pathname;

/**
 * Mounts the dashboard: the entry list at `/`, the entry editor at `/entries/:id`, its save at
 * `/entries/:id/save`, the approve and reject transitions, the batch approve, and the vendored
 * assets under `/static/`. The Origin gate is app-wide in `createApp`, so no route here re-adds
 * it; `config` is reserved for `DASHBOARD_PASSWORD`, which task 14 gates the dashboard behind.
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
      refusal:
        !outcome.ok && outcome.refusal.kind !== "unknown"
          ? { title: "Text not saved", body: formatSaveRefusal(outcome.refusal) }
          : undefined,
    };
    if (c.req.header("HX-Request") === undefined) {
      if (outcome.ok) return c.redirect(`/entries/${id}`, 303);
      return c.html(html`<!doctype html>${editorPage(vm, state)}`);
    }
    return c.html(editorFragment(vm, state));
  });

  // The two transitions. One route answers both the editor and the list: the buttons in the editor
  // form carry a `view=editor` marker (htmx includes the closest form's inputs), the list's buttons
  // carry the batch form's filters. Everything the store refuses is formatted here; the store's
  // transition functions did the writing or not at all.
  app.post("/entries/:id/approve", async (c) => {
    const id = c.req.param("id");
    const outcome = approveEntry(store, id);
    const form = await c.req.formData();
    if (form.get("view") === "editor") return transitionEditorReply(c, store, id, outcome, "approve");
    const notice = outcome.ok ? undefined : transitionNotice(store, "approve", id, outcome);
    return listReply(c, store, form, notice, outcome.ok);
  });

  app.post("/entries/:id/reject", async (c) => {
    const id = c.req.param("id");
    const outcome = rejectEntry(store, id);
    const form = await c.req.formData();
    if (form.get("view") === "editor") return transitionEditorReply(c, store, id, outcome, "reject");
    const notice = outcome.ok ? undefined : transitionNotice(store, "reject", id, outcome);
    return listReply(c, store, form, notice, outcome.ok);
  });

  // The batch approve: every selected id goes through the store's own approve independently, so one
  // refusal never blocks another's approval. An empty selection is refused with a message, never a
  // silent no-op.
  app.post("/batch-approve", async (c) => {
    const form = await c.req.formData();
    const ids = form.getAll("id").filter((value): value is string => typeof value === "string");
    const results = batchApproveEntries(store, ids);
    const notice = batchNotice(store, results);
    return listReply(c, store, form, notice, false);
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
async function listReply(c: Context, store: Store, form: FormData, notice: ListNotice | undefined, ok: boolean) {
  const params = await listParamsFrom(form);
  if (c.req.header("HX-Request") === undefined) {
    if (ok) return c.redirect("/", 303);
    return c.html(html`<!doctype html>${dashboardPage(store, params, notice)}`);
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
    return c.html(html`<!doctype html>${editorPage(vm, state)}`);
  }
  return c.html(editorFragment(vm, state));
}

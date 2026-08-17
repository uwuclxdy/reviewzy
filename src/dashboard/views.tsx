/** @jsxImportSource hono/jsx */
import type { JSX } from "hono/jsx/jsx-runtime";
import { listRevisions, parseConstraints } from "../db/human-save.ts";
import type { Constraints, HumanSaveRefusal, RevisionRow, TransitionRefusal } from "../db/human-save.ts";
import {
  countEntries,
  listEntries,
  listProjects,
  projectIdBySlug,
} from "../db/queries.ts";
import type { EntryRow, EntryStatus } from "../db/queries.ts";
import { readStyleGuideSection } from "../db/style-guide.ts";
import type { StyleGuideForm, StyleGuideFormRefusal, StyleGuideInput } from "../db/style-guide.ts";
import type { Store } from "../db/store.ts";
import { NAME, VERSION } from "../version.ts";

/**
 * The three dashboard filters, straight off the query string. `status` and `project` are the raw
 * values: an unrecognized one is a filter that cannot match and renders the no-match state rather
 * than being silently dropped, so the page never contradicts the URL it was asked for.
 */
export type ListParams = {
  readonly q: string | undefined;
  readonly status: string | undefined;
  readonly project: string | undefined;
};

/** The list entries are walked in pages of this many rows; the dashboard has no pagination UI, so the walk always runs to exhaustion. */
const PAGE_SIZE = 200;

const STATUSES: readonly EntryStatus[] = ["draft", "approved", "applied", "rejected"];

function isEntryStatus(value: string): value is EntryStatus {
  return (STATUSES as readonly string[]).includes(value);
}

/** The status tag class and label; the four statuses map one-to-one onto the four tag semantics. */
const STATUS_TAG: Record<EntryStatus, string> = {
  draft: "tag-warning",
  approved: "tag-success",
  applied: "tag-info",
  rejected: "tag-danger",
};
const STATUS_LABEL: Record<EntryStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  applied: "Applied",
  rejected: "Rejected",
};

type ProjectGroup = { slug: string; batches: { id: string; entries: EntryRow[] }[] };

export type ListViewModel = {
  readonly total: number;
  readonly shown: number;
  readonly groups: readonly ProjectGroup[];
  readonly projects: readonly { id: string; slug: string }[];
  /** The raw filter values, so the form keeps what the URL asked for. */
  readonly q: string;
  readonly status: string;
  readonly project: string;
  readonly filtersActive: boolean;
};

/** Runs the keyset walk to exhaustion: the mcp tool's own list query, page size 200, no pagination UI. */
function allEntries(
  store: Store,
  filter: { q: string | undefined; status: EntryStatus | undefined; projectId: string | undefined },
): EntryRow[] {
  const rows: EntryRow[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = listEntries(store, {
      projectId: filter.projectId,
      status: filter.status,
      ids: undefined,
      q: filter.q,
      cursor,
      limit: PAGE_SIZE,
    });
    rows.push(...page.rows);
    if (page.nextCursor === null) return rows;
    cursor = page.nextCursor;
  }
}

/**
 * Groups the filtered rows by project (slug order) then batch (batch_id order); within a batch the
 * rows keep the list query's ascending id order. The group order is deliberate: slugs and ulids
 * sort deterministically, so the same filter always renders the same page.
 */
function groupRows(rows: readonly EntryRow[], slugOf: Map<string, string>): ProjectGroup[] {
  const byProject = new Map<string, EntryRow[]>();
  for (const row of rows) {
    byProject.set(row.project_id, [...(byProject.get(row.project_id) ?? []), row]);
  }
  const projectIds = [...byProject.keys()].sort((a, b) => (slugOf.get(a) ?? a).localeCompare(slugOf.get(b) ?? b));
  return projectIds.map((projectId) => {
    const projectRows = byProject.get(projectId)!;
    const byBatch = new Map<string, EntryRow[]>();
    for (const row of projectRows) {
      byBatch.set(row.batch_id, [...(byBatch.get(row.batch_id) ?? []), row]);
    }
    const batches = [...byBatch.keys()].sort().map((batchId) => ({ id: batchId, entries: byBatch.get(batchId)! }));
    return { slug: slugOf.get(projectId) ?? projectId, batches };
  });
}

function loadList(store: Store, params: ListParams): ListViewModel {
  const q = params.q;
  const qActive = q !== undefined && q.trim() !== "";
  const statusRaw = params.status;
  const statusActive = statusRaw !== undefined && statusRaw !== "";
  const status = statusActive && isEntryStatus(statusRaw) ? statusRaw : undefined;
  const projectRaw = params.project;
  const projectActive = projectRaw !== undefined && projectRaw !== "";
  const projectId = projectActive ? (projectIdBySlug(store, projectRaw) ?? undefined) : undefined;

  // A status or project value no filter can match is a settled no-match, not a page error.
  const impossible = (statusActive && status === undefined) || (projectActive && projectId === undefined);
  const rows = impossible ? [] : allEntries(store, { q: qActive ? q : undefined, status, projectId });

  const projects = listProjects(store);
  const slugOf = new Map(projects.map((project) => [project.id, project.slug]));
  return {
    total: countEntries(store),
    shown: rows.length,
    groups: groupRows(rows, slugOf),
    projects,
    q: q ?? "",
    status: statusRaw ?? "",
    project: projectRaw ?? "",
    filtersActive: qActive || statusActive || projectActive,
  };
}

/** The basename of a repo file path (the segment after the last slash), the dim per-row prefix. */
function fileBasename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** The batch ulid shortened to head+tail for the header; the full id stays available in the title. */
function shortUlid(id: string): string {
  return `${id.slice(0, 6)}…${id.slice(-6)}`;
}

/**
 * Whether a stored constraints JSON carries at least one enforced constraint (`max_len`, or a
 * non-empty `placeholders`). The tolerant parse mirrors `parseConstraints`: foreign rows may hold
 * malformed JSON, and unparseable means no constraint, never an error.
 */
function entryHasConstraints(constraints: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(constraints);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const raw = parsed as Record<string, unknown>;
  return typeof raw.max_len === "number" || (Array.isArray(raw.placeholders) && raw.placeholders.length > 0);
}

/** The section the current page belongs to, marking the matching navbar link. */
type NavSection = "entries" | "style-guide" | "none";

function Navbar({ signedIn, active }: { signedIn: boolean; active: NavSection }) {
  return (
    <nav class="navbar">
      <div class="navbar-brand">
        <div class="logo-name">{NAME}</div>
        <div class="logo-version">v{VERSION}</div>
      </div>
      <div class="navbar-nav" id="navbar-nav">
        <a class={`navbar-link${active === "entries" ? " active" : ""}`} href="/">Entries</a>
        <a class={`navbar-link${active === "style-guide" ? " active" : ""}`} href="/style-guide">Style guide</a>
        <div class="navbar-ink" id="navbar-ink"></div>
      </div>
      {signedIn ? (
        <form method="post" action="/logout" class="navbar-actions">
          <button class="btn btn-ghost btn-sm" type="submit">Sign out</button>
        </form>
      ) : null}
    </nav>
  );
}

function PageHeader() {
  return (
    <header class="page-header">
      <div class="label page-eyebrow">Review queue</div>
      <h1 class="page-title">Entries</h1>
      <p class="page-lede">Agent drafts waiting for your approval.</p>
    </header>
  );
}

function FilterForm({ vm }: { vm: ListViewModel }) {
  return (
    <form
      id="filters"
      method="get"
      action="/"
      hx-get="/"
      hx-target="#entries-list"
      hx-swap="innerHTML"
      hx-indicator="#entries-loading"
      class="filters"
    >
      <div class="field">
        <label class="field-label" for="q">Search</label>
        <input
          class="input"
          id="q"
          name="q"
          type="search"
          placeholder="Search file, anchor, or text"
          value={vm.q}
        />
      </div>
      <div class="field">
        <label class="field-label" for="status">Status</label>
        <select class="input" id="status" name="status">
          <option value="">All statuses</option>
          <option value="draft" selected={vm.status === "draft"}>Draft</option>
          <option value="approved" selected={vm.status === "approved"}>Approved</option>
          <option value="applied" selected={vm.status === "applied"}>Applied</option>
          <option value="rejected" selected={vm.status === "rejected"}>Rejected</option>
        </select>
      </div>
      <div class="field">
        <label class="field-label" for="project">Project</label>
        <select class="input" id="project" name="project">
          <option value="">All projects</option>
          {vm.projects.map((project) => (
            <option value={project.slug} selected={vm.project === project.slug}>
              {project.slug}
            </option>
          ))}
        </select>
      </div>
      <button class="btn btn-primary" type="submit">Apply filters</button>
    </form>
  );
}

/**
 * What an action round settles into, rendered above the list region: a single refusal (one entry
 * could not move, why, and the fix) or the batch report (how many moved, each refusal named).
 * The route layer builds these from the store's outcomes; the view owns the shapes.
 */
export type ListNotice =
  | { readonly kind: "refusal"; readonly title: string; readonly message: string }
  | { readonly kind: "batch"; readonly approved: number; readonly total: number; readonly refused: readonly string[] };

/** The settled rendering of a notice: a success panel when a batch fully moved, an alert otherwise. */
function NoticeCallout({ notice }: { notice: ListNotice }) {
  if (notice.kind === "refusal") {
    return <DangerCallout title={notice.title} body={notice.message} />;
  }
  if (notice.refused.length === 0) {
    return (
      <div class="callout callout-success" role="status">
        <div class="callout-icon" style="color: var(--success)">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="8" cy="8" r="6.5" />
            <path d="M5 8l2 2 4-4" />
          </svg>
        </div>
        <div class="callout-content">
          <div class="callout-title">
            Approved {notice.approved} {notice.approved === 1 ? "entry" : "entries"}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div class="callout callout-danger" role="alert">
      <div class="callout-icon" style="color: var(--danger)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="8" cy="8" r="6.5" />
          <path d="M10 6L6 10M6 6l4 4" />
        </svg>
      </div>
      <div class="callout-content">
        <div class="callout-title">
          Approved {notice.approved} of {notice.total} entries
        </div>
        <ul class="notice-list">
          {notice.refused.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** The settled list region: success, empty, or partial, with an action round's notice on top. The loading and error states are client-side. */
function ListRegion({ vm, notice }: { vm: ListViewModel; notice: ListNotice | undefined }) {
  if (vm.shown === 0) {
    // Zero entries at all is "no entries yet" even under a filter: nothing exists to filter, and
    // the empty state explains how entries get here. Only a store with entries can have matches.
    return (
      <>
        {notice !== undefined ? <NoticeCallout notice={notice} /> : null}
        {vm.total === 0 ? <EmptyAll /> : <EmptyMatch />}
      </>
    );
  }
  return (
    <>
      {notice !== undefined ? <NoticeCallout notice={notice} /> : null}
      {vm.filtersActive && vm.shown < vm.total ? <PartialHeader shown={vm.shown} total={vm.total} /> : null}
      <BatchForm vm={vm} />
    </>
  );
}

function PartialHeader({ shown, total }: { shown: number; total: number }) {
  return (
    <div class="partial-header">
      <span class="partial-count">
        Showing {shown} of {total} entries
      </span>
      <a href="/" class="btn btn-secondary btn-sm">Clear filters</a>
    </div>
  );
}

function EmptyAll() {
  return (
    <div class="card empty-state">
      <div class="empty-icon" aria-hidden="true">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="1.5" y="2.5" width="13" height="11" />
          <path d="M1.5 9.5h3.5l1 2h4l1-2h3.5" />
        </svg>
      </div>
      <h3>No entries yet</h3>
      <p>Agents file text through the reviewzy mcp endpoint. Filed entries appear here.</p>
    </div>
  );
}

function EmptyMatch() {
  return (
    <div class="card empty-state">
      <div class="empty-icon" aria-hidden="true">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="6.5" cy="6.5" r="4.5" />
          <path d="M11 11l3 3" />
        </svg>
      </div>
      <h3>No entries match</h3>
      <p>Try different search terms, or clear the filters.</p>
      <a href="/" class="btn btn-secondary btn-sm">Clear filters</a>
    </div>
  );
}

/**
 * The batch approve form wrapping the whole list region: the checkboxes post as `id`, the hidden
 * inputs carry the active filters so an action round re-renders the region under the same filter
 * (htmx includes the closest form's inputs for the row buttons too), and the native action keeps
 * no-JS batch approve working. One form per page, never nested: the filters form lives outside the
 * swap region.
 */
function BatchForm({ vm }: { vm: ListViewModel }) {
  return (
    <form
      id="batch-form"
      method="post"
      action="/batch-approve"
      hx-post="/batch-approve"
      hx-target="#entries-list"
      hx-swap="innerHTML"
      hx-indicator="#entries-loading"
    >
      <input type="hidden" name="q" value={vm.q} />
      <input type="hidden" name="status" value={vm.status} />
      <input type="hidden" name="project" value={vm.project} />
      <div class="batch-bar">
        <button class="btn btn-primary btn-sm" type="submit" hx-disabled-elt="this">
          Approve selected
        </button>
      </div>
      {vm.groups.map((group) => (
        <ProjectGroupView key={group.slug} group={group} />
      ))}
    </form>
  );
}

function ProjectGroupView({ group }: { group: ProjectGroup }) {
  const count = group.batches.reduce((n, batch) => n + batch.entries.length, 0);
  return (
    <section class="project-group">
      <header class="project-header">
        <h2 class="project-name">{group.slug}</h2>
        <span class="tag tag-data">
          {count} {count === 1 ? "entry" : "entries"}
        </span>
      </header>
      {group.batches.map((batch) => {
        // A batch names its filer only when every entry agrees; mixed filers show a count here and
        // each row names its own inline, so the per-row flag is computed alongside the header value.
        const filers = [...new Set(batch.entries.map((entry) => entry.filed_by).filter((filer): filer is string => filer !== null))];
        const singleFiler = filers.length === 1 ? filers[0]! : null;
        const mixedFilers = filers.length >= 2;
        const constraintsCount = batch.entries.filter((entry) => entryHasConstraints(entry.constraints)).length;
        return (
          <div class="batch" key={batch.id}>
            <div class="batch-header">
              {/* Select-all toggles only this batch's draft rows. No `name`, so it never submits as
                  an entry id; dashboard.js derives checked/indeterminate from the draft checkboxes. */}
              <input type="checkbox" class="select-all" aria-label={`Select all drafts in batch ${shortUlid(batch.id)}`} />
              <span class="label">Batch</span>
              {singleFiler !== null ? <span class="batch-meta">{singleFiler}</span> : null}
              {mixedFilers ? <span class="batch-meta">{filers.length} filers</span> : null}
              <span class="batch-id" title={batch.id}>{shortUlid(batch.id)}</span>
              {constraintsCount > 0 ? <span class="batch-meta">{constraintsCount} with constraints</span> : null}
            </div>
            <div class="table-wrap">
              <table>
                <colgroup>
                  <col class="col-select" />
                  <col />
                  <col class="col-status" />
                  <col class="col-actions" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Select</th>
                    <th>Text</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {batch.entries.map((entry) => (
                    <EntryRowView key={entry.id} entry={entry} filerInline={mixedFilers} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </section>
  );
}

/**
 * One row. The checkbox names the entry for the batch form; it exists only on drafts, because an
 * approve on any other status always refuses and a checkbox that can only refuse is noise (races
 * are still reported per entry). The action buttons carry the row's own approve and reject,
 * targeting the list region; their requests include the batch form's hidden filters, so an action
 * round re-renders the region under the same filter. Applied and rejected rows are terminal from
 * the dashboard side and offer only the editor. When the batch holds mixed filers, the row also
 * names its own filer beside the basename.
 */
function EntryRowView({ entry, filerInline }: { entry: EntryRow; filerInline: boolean }) {
  const text = entry.human_text ?? entry.agent_draft;
  const approve = entry.status === "draft";
  const reject = entry.status === "draft" || entry.status === "approved";
  return (
    <tr>
      <td class="cell-select">
        {approve ? (
          <input type="checkbox" name="id" value={entry.id} aria-label={`Select ${entry.file}`} />
        ) : null}
      </td>
      <td class="cell-text" title={`${entry.file} — ${entry.anchor_text}`}>
        <span class="entry-file">
          {fileBasename(entry.file)}
          {filerInline && entry.filed_by !== null ? <span class="entry-filer"> · {entry.filed_by}</span> : null}
        </span>
        <span class="entry-text" title={text ?? ""}>{text}</span>
      </td>
      <td>
        <span class={`tag ${STATUS_TAG[entry.status]}`}>
          <span class="tag-dot"></span>
          {STATUS_LABEL[entry.status]}
        </span>
      </td>
      <td class="cell-actions">
        {approve ? (
          <button
            type="button"
            class="btn btn-primary btn-sm"
            hx-post={`/entries/${entry.id}/approve`}
            hx-target="#entries-list"
            hx-swap="innerHTML"
            hx-indicator="#entries-loading"
            hx-disabled-elt="this"
          >
            Approve
          </button>
        ) : entry.status === "approved" ? (
          // The approve slot stays occupied for approved rows: a double-click's second click lands
          // where Approve was, and the disabled button (pointer-events none) swallows it before it
          // can hit the Reject button that shifted into the slot.
          <button type="button" class="btn btn-primary btn-sm" disabled>
            Approve
          </button>
        ) : null}
        {reject ? (
          <button
            type="button"
            class="btn btn-danger btn-sm"
            hx-post={`/entries/${entry.id}/reject`}
            hx-target="#entries-list"
            hx-swap="innerHTML"
            hx-indicator="#entries-loading"
            hx-disabled-elt="this"
          >
            Reject
          </button>
        ) : null}
        <a class="btn btn-secondary btn-sm" href={`/entries/${entry.id}`}>Edit</a>
      </td>
    </tr>
  );
}

/** The error box htmx failures clone into the list region; the retry button re-submits the form. */
function ErrorBoxTemplate() {
  return (
    <template id="error-box">
      <div class="callout callout-danger" role="alert">
        <div class="callout-icon" style="color: var(--danger)">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="8" cy="8" r="6.5" />
            <path d="M10 6L6 10M6 6l4 4" />
          </svg>
        </div>
        <div class="callout-content">
          <div class="callout-title">The list could not be loaded</div>
          <div class="callout-body">The filter request failed. Try it again.</div>
          <div class="callout-actions">
            <button class="btn btn-secondary btn-sm" type="button" data-retry>Retry</button>
          </div>
        </div>
      </div>
    </template>
  );
}

/** The full page for a plain navigation; the mount wraps it in the doctype. `signedIn` is whether the navbar offers sign-out. */
export function dashboardPage(
  store: Store,
  params: ListParams,
  notice: ListNotice | undefined = undefined,
  signedIn = false,
): JSX.Element {
  const vm = loadList(store, params);
  return (
    <html lang="en" data-theme="dark">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* The empty data: URL kills the browser's /favicon.ico probe, which would 404 under /static. */}
        <link rel="icon" href="data:," />
        <title>Entries · {NAME}</title>
        <link rel="stylesheet" href="/static/tokens.css" />
        <link rel="stylesheet" href="/static/components.css" />
        <link rel="stylesheet" href="/static/dashboard.css" />
        <script src="/static/htmx.min.js"></script>
        <script src="/static/dashboard.js" defer></script>
      </head>
      <body>
        <div class="app-shell">
          <Navbar signedIn={signedIn} active="entries" />
          <main class="main">
            <PageHeader />
            <FilterForm vm={vm} />
            <div id="entries">
              <div id="entries-loading" class="htmx-indicator" role="status">
                <span class="spinner" aria-hidden="true"></span>
                Loading entries
              </div>
              <div id="entries-list">
                <ListRegion vm={vm} notice={notice} />
              </div>
            </div>
            <ErrorBoxTemplate />
          </main>
        </div>
      </body>
    </html>
  );
}

/**
 * The login page: the navbar shell, the page-header triplet, and one centered card holding the
 * password field. `error` is the single failure message, shown as an alert callout; the field
 * itself is always cleared, and `next` rides along as a hidden input so a successful retry still
 * lands where the visitor was going.
 */
export function loginPage(next: string | undefined, error: string | undefined = undefined): JSX.Element {
  return (
    <html lang="en" data-theme="dark">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* The empty data: URL kills the browser's /favicon.ico probe, which would 404 under /static. */}
        <link rel="icon" href="data:," />
        <title>Sign in · {NAME}</title>
        <link rel="stylesheet" href="/static/tokens.css" />
        <link rel="stylesheet" href="/static/components.css" />
        <link rel="stylesheet" href="/static/dashboard.css" />
        <script src="/static/htmx.min.js"></script>
        <script src="/static/dashboard.js" defer></script>
      </head>
      <body>
        <div class="app-shell">
          <Navbar signedIn={false} active="none" />
          <main class="main login-main">
            <header class="page-header">
              <div class="label page-eyebrow">Dashboard</div>
              <h1 class="page-title">Sign in</h1>
              <p class="page-lede">The dashboard is password protected. Enter the password to continue.</p>
            </header>
            {error !== undefined ? <DangerCallout title={error} /> : null}
            <form method="post" action="/login" class="card login-card">
              {next !== undefined ? <input type="hidden" name="next" value={next} /> : null}
              <div class="card-content">
                <div class="field">
                  <label class="field-label" for="password">Password</label>
                  <input
                    class="input"
                    id="password"
                    name="password"
                    type="password"
                    autocomplete="current-password"
                  />
                </div>
                <div class="login-actions">
                  <button class="btn btn-primary" type="submit">Sign in</button>
                </div>
              </div>
            </form>
          </main>
        </div>
      </body>
    </html>
  );
}

/** The list region only, for htmx requests; the loading strip and the error template stay in the page. */
export function entriesFragment(store: Store, params: ListParams, notice: ListNotice | undefined = undefined): JSX.Element {
  return <ListRegion vm={loadList(store, params)} notice={notice} />;
}

// ---- Entry editor ----

export type EditorViewModel = {
  readonly entry: EntryRow;
  readonly revisions: readonly RevisionRow[];
  readonly constraints: Constraints;
};

/**
 * What the last save or transition round rendered the editor with. `submittedText` is the text the
 * user submitted (a refusal must keep it in the textarea), and `refusal` is the formatted title and
 * message when the last round was refused (a save, an approve, or a reject each name their own
 * failure). Both are present so a swap never has to guess which one exists.
 */
export type EditorState = {
  readonly submittedText: string;
  readonly refusal: { readonly title: string; readonly body: string } | undefined;
};

/** The one entry the editor edits, by the same keyset query the list uses; `undefined` when the id is unknown. */
export function getEntry(store: Store, id: string): EntryRow | undefined {
  return listEntries(store, { projectId: undefined, status: undefined, ids: [id], q: undefined, limit: 1, cursor: undefined })
    .rows[0];
}

export function loadEditor(store: Store, id: string): EditorViewModel | null {
  const entry = getEntry(store, id);
  if (entry === undefined) return null;
  return { entry, revisions: listRevisions(store, id), constraints: parseConstraints(entry.constraints) };
}

/** The tolerant parse for `entries.context`, mirroring `parseConstraints`: foreign rows may hold malformed JSON, and unparseable means no context rows, never a 500. */
function parseContext(json: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

/**
 * The user-facing refusal messages, in the dashboard's own voice: name what failed, then the fix.
 * The store's refusal carries the values; only this function turns them into prose.
 */
export function formatSaveRefusal(refusal: Exclude<HumanSaveRefusal, { kind: "unknown" }>): string {
  switch (refusal.kind) {
    case "max_len":
      return `This text is ${refusal.length} characters; the length limit is ${refusal.maxLen}. Shorten it to ${refusal.maxLen} characters or fewer.`;
    case "placeholder":
      return `The text is missing the placeholder {${refusal.placeholder}}. Add {${refusal.placeholder}} to the text and save again.`;
    case "empty":
      return "Nothing to save. Enter text, or reject the entry.";
    case "status":
      return refusal.status === "applied"
        ? "This entry is already applied, so its text can't be changed here. If the anchor goes stale, the entry returns to approved and can be edited."
        : "This entry was rejected, so its text can't be changed. A rejected entry stays rejected; file a new entry if the line still needs changing.";
  }
}

/**
 * The user-facing refusal messages for the approve and reject transitions, in the dashboard's own
 * voice: name the entry and what failed, then the fix. Both transitions share the refusal kinds;
 * the message spells the verb each one refused.
 */
export function formatTransitionRefusal(
  action: "approve" | "reject",
  refusal: Exclude<TransitionRefusal, { kind: "unknown" }>,
  entryFile: string,
): string {
  switch (refusal.kind) {
    case "no_draft":
      return `Entry ${entryFile} has no draft to approve. Open the editor to write the text.`;
    case "status":
      switch (refusal.status) {
        case "approved":
          return `Entry ${entryFile} is already approved, so there's nothing to accept. Open the editor to revise its text.`;
        case "applied":
          return action === "approve"
            ? `Entry ${entryFile} is already applied, so it can't be approved. If the anchor goes stale, the entry returns to approved.`
            : `Entry ${entryFile} is already applied, so it can't be rejected. If the anchor goes stale, it returns to approved and can be rejected then.`;
        case "rejected":
          return `Entry ${entryFile} was rejected, and a rejected entry stays rejected. File a new entry if the line still needs changing.`;
      }
  }
}

function DangerCallout({ title, body }: { title: string; body?: string }) {
  return (
    <div class="callout callout-danger" role="alert">
      <div class="callout-icon" style="color: var(--danger)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="8" cy="8" r="6.5" />
          <path d="M10 6L6 10M6 6l4 4" />
        </svg>
      </div>
      <div class="callout-content">
        <div class="callout-title">{title}</div>
        {body !== undefined ? <div class="callout-body">{body}</div> : null}
      </div>
    </div>
  );
}

/**
 * The editor region, swapped wholesale by a save or a transition (form + status tag + history +
 * any refusal). The textarea carries `hx-preserve`, so a swap keeps the user's focus and typing
 * while the server-rendered value stays what the last save left: the submitted text on a refusal.
 * The `view` marker tells the approve and reject routes which region to answer with: this region,
 * or the list's. The buttons carry htmx only; the save button keeps the native submit.
 */
function EditorRegion({ vm, state }: { vm: EditorViewModel; state: EditorState | undefined }) {
  const text = state?.submittedText ?? vm.entry.human_text ?? vm.entry.agent_draft ?? "";
  const approve = vm.entry.status === "draft";
  const reject = vm.entry.status === "draft" || vm.entry.status === "approved";
  return (
    <div id="editor-region">
      {state?.refusal !== undefined ? (
        <DangerCallout title={state.refusal.title} body={state.refusal.body} />
      ) : null}
      <form
        id="editor-form"
        class="card"
        method="post"
        action={`/entries/${vm.entry.id}/save`}
        hx-post={`/entries/${vm.entry.id}/save`}
        hx-target="#editor-view"
        hx-swap="outerHTML"
      >
        <input type="hidden" name="view" value="editor" />
        <div class="card-header">
          <div class="card-title">Text</div>
          <span class={`tag ${STATUS_TAG[vm.entry.status]}`}>
            <span class="tag-dot"></span>
            {STATUS_LABEL[vm.entry.status]}
          </span>
        </div>
        <div class="card-content">
          <textarea id="editor-text" class="input" name="text" rows={10} aria-label="Entry text" hx-preserve="true">
            {text}
          </textarea>
          <div class="editor-actions">
            <button class="btn btn-primary" type="submit">Save text</button>
            {approve ? (
              <button
                type="button"
                class="btn btn-secondary"
                hx-post={`/entries/${vm.entry.id}/approve`}
                hx-target="#editor-region"
                hx-swap="outerHTML"
                hx-indicator="#editor-action-loading"
                hx-disabled-elt="this"
              >
                Approve draft
              </button>
            ) : vm.entry.status === "approved" ? (
              // Same slot-occupancy guard as the list row: the second click of a double-click on
              // the just-approving button would otherwise land on the Reject button that shifts
              // into this slot in the swapped region.
              <button type="button" class="btn btn-secondary" disabled>
                Approve draft
              </button>
            ) : null}
            {reject ? (
              <button
                type="button"
                class="btn btn-danger"
                hx-post={`/entries/${vm.entry.id}/reject`}
                hx-target="#editor-region"
                hx-swap="outerHTML"
                hx-indicator="#editor-action-loading"
                hx-disabled-elt="this"
              >
                Reject
              </button>
            ) : null}
            <span id="editor-action-loading" class="htmx-indicator" role="status">
              <span class="spinner" aria-hidden="true"></span>
              Updating entry
            </span>
          </div>
        </div>
      </form>
      <RevisionHistory revisions={vm.revisions} />
    </div>
  );
}

function RevisionHistory({ revisions }: { revisions: readonly RevisionRow[] }) {
  return (
    <div class="card">
      <div class="card-header">
        <div class="card-title">Revision history</div>
      </div>
      <div class="card-content">
        {revisions.length === 0 ? (
          <p class="history-empty">No saved revisions yet</p>
        ) : (
          <ul class="revision-list">
            {revisions.map((revision) => (
              <li class="revision" key={revision.id}>
                <div class="revision-head">
                  <span class={`tag tag-data ${STATUS_TAG[revision.status]}`}>{STATUS_LABEL[revision.status]}</span>
                  <time class="revision-time" datetime={new Date(revision.created_at).toISOString()}>
                    {new Date(revision.created_at).toLocaleString()}
                  </time>
                  <button class="btn btn-ghost btn-sm" type="button" data-use-revision title="Use this text">
                    Use
                  </button>
                </div>
                <div class="revision-text">{revision.human_text}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The constraint panel: what the entry's save enforces, plus the display-only tone and notes. */
function ConstraintsCard({ constraints, text }: { constraints: Constraints; text: string }) {
  const maxLen = constraints.maxLen;
  const placeholders = constraints.placeholders;
  const tone = constraints.tone;
  const notes = constraints.notes;
  const hasAny = maxLen !== undefined || placeholders.length > 0 || tone !== undefined || notes !== undefined;
  if (!hasAny) return null;
  return (
    <div class="card">
      <div class="card-header">
        <div class="card-title">Constraints</div>
      </div>
      <div class="card-content">
        {maxLen !== undefined ? (
          <div class="constraint-row">
            <div class="constraint-label">Length</div>
            <div class="constraint-value">
              <span id="char-count" class="num char-count" data-max-len={maxLen}>
                {text.length} / {maxLen}
              </span>
            </div>
          </div>
        ) : null}
        {placeholders.length > 0 ? (
          <div class="constraint-row">
            <div class="constraint-label">Placeholders</div>
            <ul class="placeholder-list">
              {placeholders.map((placeholder) => {
                const present = text.includes(placeholder);
                return (
                  <li class="placeholder-item" data-placeholder={placeholder} key={placeholder}>
                    <span class={`placeholder-state${present ? " is-present" : ""}`}>
                      {present ? "Present" : "Missing"}
                    </span>
                    <span class="placeholder-token">{"{" + placeholder + "}"}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        {tone !== undefined ? (
          <div class="constraint-row">
            <div class="constraint-label">Tone</div>
            <div class="constraint-value">{tone}</div>
          </div>
        ) : null}
        {notes !== undefined ? (
          <div class="constraint-row">
            <div class="constraint-label">Notes</div>
            <div class="constraint-value">{notes}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The entry's context JSON plus its anchor metadata, as an info-table readout. */
function ContextCard({ entry }: { entry: EntryRow }) {
  const context = parseContext(entry.context);
  return (
    <div class="card">
      <div class="card-header">
        <div class="card-title">Context</div>
      </div>
      <div class="card-content">
        <table class="info-table">
          {Object.entries(context).map(([key, value]) => (
            <tr key={key}>
              <td>{key}</td>
              <td>{typeof value === "string" ? value : JSON.stringify(value)}</td>
            </tr>
          ))}
          <tr>
            <td>Repo</td>
            <td>{entry.repo}</td>
          </tr>
          <tr>
            <td>File</td>
            <td>{entry.file}</td>
          </tr>
          <tr>
            <td>Anchor</td>
            <td>{entry.anchor_text}</td>
          </tr>
          <tr>
            <td>File hash</td>
            <td>{entry.file_hash}</td>
          </tr>
          {entry.filed_by !== null ? (
            <tr>
              <td>Filed by</td>
              <td>{entry.filed_by}</td>
            </tr>
          ) : null}
          {entry.stale_note !== null ? (
            <tr>
              <td>Stale note</td>
              <td>{entry.stale_note}</td>
            </tr>
          ) : null}
        </table>
      </div>
    </div>
  );
}

/**
 * The before-and-after of the entry's text, above the editor: what the anchored region reads now
 * (the anchor line visually distinct) and what the entry's text will replace it with. Both sides
 * escape through JSX; the text is the stored bytes, shown as-is.
 */
function DiffView({ entry }: { entry: EntryRow }) {
  const after = entry.human_text ?? entry.agent_draft;
  // No text at all means nothing to compare: a filed entry whose agent never drafted, or an
  // approved entry whose text was never set.
  if (after === null) return null;
  return (
    <div class="diff-grid">
      <div class="card">
        <div class="card-header">
          <div class="card-title">Before</div>
        </div>
        <pre class="diff-code">
          <span class="diff-line">{entry.anchor_before}</span>
          <span class="diff-line diff-anchor">{entry.anchor_text}</span>
          <span class="diff-line">{entry.anchor_after}</span>
        </pre>
      </div>
      <div class="card">
        <div class="card-header">
          <div class="card-title">After</div>
        </div>
        <pre class="diff-code">{after}</pre>
      </div>
    </div>
  );
}

/**
 * The editor view: the diff above the editor grid, one swap node. A save changes the diff's
 * after-side, so the save form targets this wrapper and its response re-renders the whole view;
 * the transitions target only the region inside (they never change what the diff shows).
 */
function EditorView({ vm, state }: { vm: EditorViewModel; state: EditorState | undefined }) {
  const text = state?.submittedText ?? vm.entry.human_text ?? vm.entry.agent_draft ?? "";
  return (
    <div id="editor-view">
      <DiffView entry={vm.entry} />
      <div class="editor-grid">
        <div class="editor-main">
          <EditorRegion vm={vm} state={state} />
        </div>
        <aside class="editor-rail">
          <ContextCard entry={vm.entry} />
          <ConstraintsCard constraints={vm.constraints} text={text} />
        </aside>
      </div>
    </div>
  );
}

/** The full editor page; the mount wraps it in the doctype. `signedIn` is whether the navbar offers sign-out. */
export function editorPage(vm: EditorViewModel, state: EditorState | undefined = undefined, signedIn = false): JSX.Element {
  return (
    <html lang="en" data-theme="dark">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* The empty data: URL kills the browser's /favicon.ico probe, which would 404 under /static. */}
        <link rel="icon" href="data:," />
        <title>Edit entry · {NAME}</title>
        <link rel="stylesheet" href="/static/tokens.css" />
        <link rel="stylesheet" href="/static/components.css" />
        <link rel="stylesheet" href="/static/dashboard.css" />
        <script src="/static/htmx.min.js"></script>
        <script src="/static/dashboard.js" defer></script>
      </head>
      <body>
        <div class="app-shell">
          <Navbar signedIn={signedIn} active="entries" />
          <main class="main">
            <header class="page-header">
              <div class="label page-eyebrow">Entry review</div>
              <h1 class="page-title">Edit entry</h1>
              <p class="page-lede">Saving the text approves the entry and releases it to agents.</p>
            </header>
            <EditorView vm={vm} state={state} />
            {/* The one live region: announcements on constraint-state flips only, so a screen reader
                is not flooded with a per-keystroke value. Lives outside the swap region. */}
            <span id="editor-live" class="visually-hidden" aria-live="polite"></span>
          </main>
        </div>
      </body>
    </html>
  );
}

/** The editor region only, for htmx transition responses; the page shell, diff, context, and constraints stay put. */
export function editorFragment(vm: EditorViewModel, state: EditorState | undefined = undefined): JSX.Element {
  return <EditorRegion vm={vm} state={state} />;
}

/** The whole editor view (diff + region + rail), for htmx save responses: a save changes the diff's after-side, so the swap must re-render it. */
export function editorViewFragment(vm: EditorViewModel, state: EditorState | undefined = undefined): JSX.Element {
  return <EditorView vm={vm} state={state} />;
}

/** The 404 page for an unknown entry id, with the way onward the page-not-found pattern demands. `signedIn` is whether the navbar offers sign-out. */
export function notFoundPage(signedIn = false): JSX.Element {
  return (
    <html lang="en" data-theme="dark">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* The empty data: URL kills the browser's /favicon.ico probe, which would 404 under /static. */}
        <link rel="icon" href="data:," />
        <title>Entry not found · {NAME}</title>
        <link rel="stylesheet" href="/static/tokens.css" />
        <link rel="stylesheet" href="/static/components.css" />
        <link rel="stylesheet" href="/static/dashboard.css" />
        <script src="/static/htmx.min.js"></script>
        <script src="/static/dashboard.js" defer></script>
      </head>
      <body>
        <div class="app-shell">
          <Navbar signedIn={signedIn} active="entries" />
          <main class="main">
            <header class="page-header">
              <div class="label page-eyebrow">Entry review</div>
              <h1 class="page-title">Entry not found</h1>
              <p class="page-lede">This entry doesn't exist. Return to the list to find it.</p>
              <a href="/" class="btn btn-secondary">Back to entries</a>
            </header>
          </main>
        </div>
      </body>
    </html>
  );
}

/** The htmx fragment for a save on an id that vanished mid-session: htmx will not swap a 4xx, so this is a 200 with the way onward in the editor region itself. */
export function entryGoneFragment(): JSX.Element {
  return (
    <div id="editor-region">
      <DangerCallout title="This entry no longer exists" body="Return to the list to find it." />
      <a href="/" class="btn btn-secondary">Back to entries</a>
    </div>
  );
}

/** The save swap targets the whole editor view, so a vanished id answers in that same wrapper shape. */
export function editorViewGoneFragment(): JSX.Element {
  return <div id="editor-view">{entryGoneFragment()}</div>;
}

// ---- Style guide editor ----

/** The page's settled read: which section is being edited, the selector's projects, and whether the section has a row. */
export type StyleGuideViewModel = {
  /** null is the global section; a slug its project section. */
  readonly projectSlug: string | null;
  readonly projects: readonly { id: string; slug: string }[];
  /** The slug resolved to nothing: the region renders the notice instead of a form, and no row is ever created. */
  readonly unknown: boolean;
  /** Whether a row exists for this section: the empty state (no row) differs from the partial one (a row with missing fields). */
  readonly hasRow: boolean;
  /** The stored section, or the empty defaults when there is no row yet. */
  readonly section: StyleGuideInput;
};

/** What the last save round settled into, rendered by the swap: the saved notice, the unknown-project notice, or the refusal with its message. The submitted form is kept so a refusal re-renders what the user typed. */
export type StyleGuideEditorState = {
  readonly submitted: StyleGuideForm;
  readonly notice:
    | { readonly kind: "saved" }
    | { readonly kind: "unknown_project" }
    | { readonly kind: "refusal"; readonly title: string; readonly body: string };
};

/** The global and project sections: `project` empty means global, and the slug is checked against the projects list, never minted. */
export function loadStyleGuide(store: Store, projectQuery: string | undefined): StyleGuideViewModel {
  const projectSlug = projectQuery !== undefined && projectQuery !== "" ? projectQuery : null;
  const projects = listProjects(store);
  const unknown = projectSlug !== null && !projects.some((project) => project.slug === projectSlug);
  const section = readStyleGuideSection(store, projectSlug);
  return {
    projectSlug,
    projects,
    unknown,
    hasRow: section !== null,
    section: section ?? { markdown: "", bannedWords: [], glossary: {} },
  };
}

/** The user-facing refusal message for a style guide save, in the dashboard's own voice: name the line and offer the fix. The unknown project is its own notice kind with its own region, so it never formats as a refusal. */
export function formatStyleGuideRefusal(refusal: StyleGuideFormRefusal): { title: string; body: string } {
  return {
    title: "Guide not saved",
    body:
      refusal.reason === "no_colon"
        ? `Glossary line ${refusal.lineNumber} ("${refusal.line}") has no colon. Write it as key: value.`
        : `Glossary line ${refusal.lineNumber} ("${refusal.line}") has no key. Write it as key: value.`,
  };
}

/** The stored section as the form's raw strings. A stored item can hold a line break (a foreign row), and the form would refuse that on re-save, so the display collapses the break the way the merge's render does. */
function sectionToForm(section: StyleGuideInput): StyleGuideForm {
  const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ");
  return {
    markdown: section.markdown,
    bannedWordsCsv: section.bannedWords.join(", "),
    glossaryText: Object.entries(section.glossary)
      .map(([key, value]) => `${oneLine(key)}: ${oneLine(value)}`)
      .join("\n"),
  };
}

function InfoCallout({ title, body }: { title: string; body?: string }) {
  return (
    <div class="callout callout-info">
      <div class="callout-icon" style="color: var(--info)">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="8" cy="8" r="6.5" />
          <path d="M8 7.5v3.5M8 5.5v.01" />
        </svg>
      </div>
      <div class="callout-content">
        <div class="callout-title">{title}</div>
        {body !== undefined ? <div class="callout-body">{body}</div> : null}
      </div>
    </div>
  );
}

/** The project selector: the global section plus every known project, as links, with the current one marked. A link list is the whole mechanism; the section never auto-creates a project. */
function StyleGuideProjects({ vm }: { vm: StyleGuideViewModel }) {
  const activeSlug = vm.unknown ? null : vm.projectSlug;
  return (
    <nav class="style-guide-projects" aria-label="Style guide sections">
      <ProjectSectionLink href="/style-guide" label="Global" active={activeSlug === null} />
      {vm.projects.map((project) => (
        <ProjectSectionLink
          key={project.slug}
          href={`/style-guide?project=${project.slug}`}
          label={project.slug}
          active={activeSlug === project.slug}
        />
      ))}
    </nav>
  );
}

function ProjectSectionLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <a
      class={`btn btn-sm ${active ? "btn-primary" : "btn-secondary"}`}
      href={href}
      aria-current={active ? "page" : undefined}
    >
      {label}
    </a>
  );
}

/** The unknown section: the notice and the way onward, no form. An unknown slug must never re-target the save at the global section by accident, so the editor form does not render at all. */
function StyleGuideUnknownRegion({ slug }: { slug: string }) {
  return (
    <div id="style-guide-region">
      <DangerCallout title={`Project ${slug} doesn't exist`} body="A project section appears once the project has entries." />
      <a href="/style-guide" class="btn btn-secondary">Edit the global guide</a>
    </div>
  );
}

/** The region htmx swaps: the settled notice on top, then the editor form. A save re-renders the stored values (normalized), a refusal keeps the submitted ones. */
function StyleGuideRegion({ vm, state }: { vm: StyleGuideViewModel; state: StyleGuideEditorState | undefined }) {
  if (vm.unknown || state?.notice.kind === "unknown_project") {
    return <StyleGuideUnknownRegion slug={vm.projectSlug ?? ""} />;
  }
  const formValues = state !== undefined && state.notice.kind === "refusal" ? state.submitted : sectionToForm(vm.section);
  return (
    <div id="style-guide-region">
      {state?.notice.kind === "saved" ? (
        <div class="callout callout-success" role="status">
          <div class="callout-icon" style="color: var(--success)">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="8" cy="8" r="6.5" />
              <path d="M5 8l2 2 4-4" />
            </svg>
          </div>
          <div class="callout-content">
            <div class="callout-title">Guide saved</div>
            <div class="callout-body">
              {vm.projectSlug === null
                ? "The global guide now applies to every project."
                : `The ${vm.projectSlug} section now applies below the global guide.`}
            </div>
          </div>
        </div>
      ) : null}
      {state?.notice.kind === "refusal" ? <DangerCallout title={state.notice.title} body={state.notice.body} /> : null}
      {!vm.hasRow ? (
        <InfoCallout
          title={vm.projectSlug === null ? "No guide yet" : "No guide for this project yet"}
          body="Your save creates it."
        />
      ) : null}
      <form
        id="style-guide-form"
        class="card style-guide-card"
        method="post"
        action="/style-guide/save"
        hx-post="/style-guide/save"
        hx-target="#style-guide-region"
        hx-swap="outerHTML"
        hx-indicator="#style-guide-loading"
      >
        <input type="hidden" name="project" value={vm.projectSlug ?? ""} />
        <div class="card-header">
          <div class="card-title">{vm.projectSlug === null ? "Global guide" : `${vm.projectSlug} guide`}</div>
        </div>
        <div class="card-content">
          <div class="field">
            <label class="field-label" for="style-guide-markdown">Markdown</label>
            <textarea class="input" id="style-guide-markdown" name="markdown" rows={10} aria-label="Guide markdown">
              {formValues.markdown}
            </textarea>
            {vm.hasRow && vm.section.markdown === "" ? <p class="field-hint">No markdown yet.</p> : null}
          </div>
          <div class="field">
            <label class="field-label" for="style-guide-banned">Banned words</label>
            <input class="input" id="style-guide-banned" name="banned_words" type="text" value={formValues.bannedWordsCsv} />
            <p class="field-hint">Comma-separated. Extra whitespace and duplicates are dropped.</p>
            {vm.hasRow && vm.section.bannedWords.length === 0 ? <p class="field-hint">No banned words yet.</p> : null}
          </div>
          <div class="field">
            <label class="field-label" for="style-guide-glossary">Glossary</label>
            <textarea class="input" id="style-guide-glossary" name="glossary" rows={6} aria-label="Glossary entries">
              {formValues.glossaryText}
            </textarea>
            <p class="field-hint">One key: value pair per line. A line without a colon is refused.</p>
            {vm.hasRow && Object.keys(vm.section.glossary).length === 0 ? (
              <p class="field-hint">No glossary entries yet.</p>
            ) : null}
          </div>
          <div class="editor-actions">
            <button class="btn btn-primary" type="submit" hx-disabled-elt="this">Save guide</button>
            <span id="style-guide-loading" class="htmx-indicator" role="status">
              <span class="spinner" aria-hidden="true"></span>
              Saving guide
            </span>
          </div>
        </div>
      </form>
    </div>
  );
}

/** The error box htmx failures clone into the style guide region; the retry button re-submits the save form. */
function StyleGuideErrorBoxTemplate() {
  return (
    <template id="style-guide-error-box">
      <div class="callout callout-danger" role="alert">
        <div class="callout-icon" style="color: var(--danger)">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="8" cy="8" r="6.5" />
            <path d="M10 6L6 10M6 6l4 4" />
          </svg>
        </div>
        <div class="callout-content">
          <div class="callout-title">The guide could not be saved</div>
          <div class="callout-body">The save request failed. Try it again.</div>
          <div class="callout-actions">
            <button class="btn btn-secondary btn-sm" type="button" data-retry>Retry</button>
          </div>
        </div>
      </div>
    </template>
  );
}

/** The full style guide page; the mount wraps it in the doctype. `signedIn` is whether the navbar offers sign-out. */
export function styleGuidePage(
  vm: StyleGuideViewModel,
  state: StyleGuideEditorState | undefined = undefined,
  signedIn = false,
): JSX.Element {
  return (
    <html lang="en" data-theme="dark">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* The empty data: URL kills the browser's /favicon.ico probe, which would 404 under /static. */}
        <link rel="icon" href="data:," />
        <title>Style guide · {NAME}</title>
        <link rel="stylesheet" href="/static/tokens.css" />
        <link rel="stylesheet" href="/static/components.css" />
        <link rel="stylesheet" href="/static/dashboard.css" />
        <script src="/static/htmx.min.js"></script>
        <script src="/static/dashboard.js" defer></script>
      </head>
      <body>
        <div class="app-shell">
          <Navbar signedIn={signedIn} active="style-guide" />
          <main class="main">
            <header class="page-header">
              <div class="label page-eyebrow">Voice</div>
              <h1 class="page-title">Style guide</h1>
              <p class="page-lede">The voice agents read before drafting, starting with the global guide and adding each project's own rules below.</p>
            </header>
            <StyleGuideProjects vm={vm} />
            <StyleGuideRegion vm={vm} state={state} />
            <StyleGuideErrorBoxTemplate />
          </main>
        </div>
      </body>
    </html>
  );
}

/** The style guide region only, for htmx responses; the selector, the page shell, and the error template stay put. */
export function styleGuideRegionFragment(vm: StyleGuideViewModel, state: StyleGuideEditorState | undefined = undefined): JSX.Element {
  return <StyleGuideRegion vm={vm} state={state} />;
}

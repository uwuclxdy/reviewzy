/** @jsxImportSource hono/jsx */
import { readFileSync } from "node:fs";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import type { JSX } from "hono/jsx/jsx-runtime";
import { listRevisions, parseConstraints, parseEntryImages } from "../db/human-save.ts";
import type { Constraints, HumanSaveRefusal, RevisionRow, TransitionRefusal } from "../db/human-save.ts";
import {
  adjacentEntryIds,
  countEntries,
  countEntriesByStatus,
  listEntries,
  listProjects,
  projectIdBySlug,
} from "../db/queries.ts";
import type { EntryRow, EntryStatus } from "../db/queries.ts";
import { readStyleGuideSection } from "../db/style-guide.ts";
import type { StyleGuideForm, StyleGuideFormRefusal, StyleGuideInput } from "../db/style-guide.ts";
import type { Store } from "../db/store.ts";
import { parseRepoLink, REPO_ICON } from "./repo-link.ts";
import { diffWords } from "./word-diff.ts";
import { NAME } from "../version.ts";

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

/** The default Active view: the two statuses that still need a human. */
const ACTIVE_STATUSES: readonly EntryStatus[] = ["draft", "approved"];

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

/** The timeline dot variant per revision status, matching the tag's own semantic. */
const STATUS_DOT: Record<EntryStatus, string> = {
  draft: "timeline-dot-warning",
  approved: "timeline-dot-success",
  applied: "timeline-dot-accent",
  rejected: "timeline-dot-danger",
};

/** The status dropdown's options: the value the form submits and the label the trigger shows. */
const STATUS_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "", label: "Active" },
  { value: "all", label: "All statuses" },
  ...STATUSES.map((status) => ({ value: status, label: STATUS_LABEL[status] })),
];

type ProjectGroup = { slug: string; entries: EntryRow[] };

export type ListViewModel = {
  readonly total: number;
  /** The whole store's counts per status; the four stat cards read these, never the filtered rows. */
  readonly counts: Record<EntryStatus, number>;
  readonly shown: number;
  readonly groups: readonly ProjectGroup[];
  readonly projects: readonly { id: string; slug: string }[];
  /** The raw filter values, so the form keeps what the URL asked for. */
  readonly q: string;
  readonly status: string;
  readonly project: string;
  readonly filtersActive: boolean;
  /** Whether the default Active view is what hides every match: a filter found rows, but all of them are applied or rejected. */
  readonly hiddenByActiveView: boolean;
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
 * Groups the filtered rows by project, projects in slug order. Within a project the rows keep
 * the list query's ascending id order: ulids sort chronologically, so the oldest filing leads.
 */
function groupRows(rows: readonly EntryRow[], slugOf: Map<string, string>): ProjectGroup[] {
  const byProject = new Map<string, EntryRow[]>();
  for (const row of rows) {
    byProject.set(row.project_id, [...(byProject.get(row.project_id) ?? []), row]);
  }
  const groups = [...byProject].map(([projectId, projectRows]) => ({
    slug: slugOf.get(projectId) ?? projectId,
    entries: projectRows,
  }));
  return groups.sort((a, b) => a.slug.localeCompare(b.slug));
}

function loadList(store: Store, params: ListParams): ListViewModel {
  const q = params.q;
  const qActive = q !== undefined && q.trim() !== "";
  const statusRaw = params.status;
  const statusActive = statusRaw !== undefined && statusRaw !== "";
  // `all` is the explicit "every status" filter value; the default (no status param, or an empty
  // one) is the Active view of draft + approved only, which is not a filter and never renders the
  // partial header. Both query every status; the Active view narrows the walked rows afterward.
  const allStatuses = statusActive && statusRaw === "all";
  const status = statusActive && !allStatuses && isEntryStatus(statusRaw) ? statusRaw : undefined;
  const projectRaw = params.project;
  const projectActive = projectRaw !== undefined && projectRaw !== "";
  const projectId = projectActive ? (projectIdBySlug(store, projectRaw) ?? undefined) : undefined;

  // A status or project value no filter can match is a settled no-match, not a page error.
  const impossible = (statusActive && !allStatuses && status === undefined) || (projectActive && projectId === undefined);
  const walked = impossible ? [] : allEntries(store, { q: qActive ? q : undefined, status, projectId });
  const rows = statusActive ? walked : walked.filter((row) => ACTIVE_STATUSES.includes(row.status));

  const projects = listProjects(store);
  const slugOf = new Map(projects.map((project) => [project.id, project.slug]));
  return {
    total: countEntries(store),
    counts: countEntriesByStatus(store),
    shown: rows.length,
    groups: groupRows(rows, slugOf),
    projects,
    q: q ?? "",
    status: statusRaw ?? "",
    project: projectRaw ?? "",
    filtersActive: qActive || statusActive || projectActive,
    hiddenByActiveView: !statusActive && walked.length > 0 && rows.length === 0,
  };
}

/** The basename of a repo file path (the segment after the last slash), the dim per-row prefix. */
function fileBasename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/**
 * The entry's display title: the agent-supplied `title` when it is non-empty, else the anchor text
 * (the string being changed), else the file basename for a foreign row carrying neither. The title
 * is what the list and the editor lead with in place of the file path.
 */
function entryTitle(entry: EntryRow): string {
  const title = entry.title?.trim();
  if (title !== undefined && title !== "") return title;
  const anchor = entry.anchor_text.trim();
  if (anchor !== "") return anchor;
  return fileBasename(entry.file);
}

/** Whether the displayed title is the agent-supplied one, so the anchor text it stands in for is otherwise unread in the list. */
function hasOwnTitle(entry: EntryRow): boolean {
  const title = entry.title?.trim();
  return title !== undefined && title !== "";
}

/** The section the current page belongs to, marking the matching nav link. */
type NavSection = "entries" | "style-guide";

/** The icon sprite, pasted into every full page's body as its first child, read off the vendored file so the two can never drift. */
const ICON_SPRITE = readFileSync(new URL("./static/icons.svg", import.meta.url), "utf8");

/** The theme toggle, once per shell: ui.js's initTheme wires it and owns the pressed state. */
function ThemeToggle() {
  return (
    <button class="btn btn-icon" data-theme-toggle aria-pressed="false" aria-label="Switch to light theme">
      <svg class="icon-sun" aria-hidden="true"><use href="#i-sun" /></svg>
      <svg class="icon-moon" aria-hidden="true"><use href="#i-moon" /></svg>
    </button>
  );
}

/**
 * The queue's draft count. The htmx list fragment re-renders it out of band, so an action round
 * that moves a draft cannot leave the sidebar stale.
 */
function DraftBadge({ count, oob = false }: { count: number; oob?: boolean }) {
  return (
    <span class="nav-badge" id="entries-badge" hx-swap-oob={oob ? "true" : undefined}>
      {count}
    </span>
  );
}

/**
 * The app shell every full page shares: the mobile topbar and overlay outside the grid, then the
 * sidebar and the page column. Under 768px the same `.sidebar` element is the drawer, which is
 * why there is no second navigation tree and why ui.js's drawer and rail controllers both act on
 * this one node.
 */
function Shell({
  signedIn,
  active,
  draftCount,
  children,
}: {
  signedIn: boolean;
  active: NavSection;
  draftCount: number;
  children: Child;
}) {
  return (
    <>
      <div class="mobile-topbar">
        <div class="logo-name">{NAME}</div>
        <button
          type="button"
          class="hamburger"
          id="hamburger-btn"
          aria-label="Open navigation"
          aria-expanded="false"
          aria-controls="sidebar"
        >
          <svg aria-hidden="true"><use href="#i-menu" /></svg>
        </button>
      </div>
      <div class="sidebar-overlay" id="sidebar-overlay"></div>
      <div class="layout">
        <nav class="sidebar" id="sidebar" aria-label="Dashboard">
          <div class="sidebar-logo">
            <div><div class="logo-name">{NAME}</div></div>
            <button
              class="sidebar-collapse"
              type="button"
              aria-controls="sidebar"
              aria-expanded="true"
              aria-label="Collapse sidebar"
            >
              <svg aria-hidden="true"><use href="#i-chevron-left" /></svg>
            </button>
          </div>
          <div class="sidebar-nav">
            <div class="nav-group">
              <div class="nav-group-label">Queue</div>
              <a
                class={`nav-item${active === "entries" ? " active" : ""}`}
                href="/"
                aria-current={active === "entries" ? "true" : undefined}
              >
                <span>Entries</span>
                <DraftBadge count={draftCount} />
              </a>
            </div>
            <div class="nav-group">
              <div class="nav-group-label">Content</div>
              <a
                class={`nav-item${active === "style-guide" ? " active" : ""}`}
                href="/style-guide"
                aria-current={active === "style-guide" ? "true" : undefined}
              >
                <span>Style guide</span>
              </a>
            </div>
          </div>
          <div class="sidebar-user">
            <ThemeToggle />
            {signedIn ? (
              <form method="post" action="/logout">
                <button class="btn btn-secondary btn-sm" type="submit">Sign out</button>
              </form>
            ) : null}
          </div>
        </nav>
        <main class="page">{children}</main>
      </div>
    </>
  );
}

function PageHeader({ total, projects }: { total: number; projects: number }) {
  return (
    <header class="page-header">
      <div class="page-header-body">
        <h1 class="page-title">Entries</h1>
        <div class="page-meta">
          <span class="page-meta-item num">{total} {total === 1 ? "entry" : "entries"}</span>
          <span class="page-meta-item num">{projects} {projects === 1 ? "project" : "projects"}</span>
        </div>
      </div>
    </header>
  );
}

/**
 * The four status totals off the store's one grouped read. In the htmx fragment it rides an
 * out-of-band swap: the list region is the only main target, and a card left outside it would
 * show the pre-action statuses until the next navigation.
 */
function StatsGrid({ counts, oob = false }: { counts: Record<EntryStatus, number>; oob?: boolean }) {
  return (
    <div class="stat-grid" id="page-stats" hx-swap-oob={oob ? "true" : undefined}>
      {STATUSES.map((status) => (
        <div class="stat-card" key={status}>
          <div class="stat-label">{STATUS_LABEL[status]}</div>
          <div class="stat-value num">{counts[status]}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * One dropdown filter as the system `.select`: the trigger shows the current label, the menu
 * carries one option per value, and a hidden input carries the submission. The hidden input ships
 * disabled with its name already on it, so a no-JS submit reads the `<noscript>` native selects
 * instead of a stale hidden value; dashboard.js enables the hidden ones once the widgets are live.
 */
function FilterSelect({
  id,
  label,
  field,
  current,
  options,
}: {
  id: string;
  label: string;
  field: string;
  current: string;
  options: readonly { value: string; label: string }[];
}) {
  const currentLabel = options.find((option) => option.value === current)?.label ?? options[0]!.label;
  return (
    <>
      <span class="sr-only" id={`${id}-label`}>{label}</span>
      <div class="select" data-filter={field}>
        <button
          type="button"
          class="input select-trigger"
          role="combobox"
          aria-expanded="false"
          aria-haspopup="listbox"
          aria-labelledby={`${id}-label`}
        >
          <span class="select-value">{currentLabel}</span>
          <svg class="select-caret" aria-hidden="true"><use href="#i-chevron-down" /></svg>
        </button>
        <div class="select-menu" role="listbox" aria-labelledby={`${id}-label`}>
          {options.map((option) => (
            <div
              class="menu-item"
              role="option"
              aria-selected={String(option.value === current)}
              data-value={option.value}
            >
              {option.label}
            </div>
          ))}
        </div>
      </div>
      <input type="hidden" name={field} value={current} data-filter-field={field} disabled />
    </>
  );
}

function FilterForm({ vm }: { vm: ListViewModel }) {
  const projectOptions = [
    { value: "", label: "All projects" },
    ...vm.projects.map((project) => ({ value: project.slug, label: project.slug })),
  ];
  return (
    <form
      id="filters"
      method="get"
      action="/"
      hx-get="/"
      hx-target="#entries-list"
      hx-swap="innerHTML"
      hx-indicator="#entries-loading"
      class="filter-bar"
    >
      <div class="input-wrap has-icon filter-search">
        <div class="input-icon">
          <svg aria-hidden="true"><use href="#i-search" /></svg>
        </div>
        <label class="sr-only" for="q">Search</label>
        <input
          class="input"
          id="q"
          name="q"
          type="search"
          placeholder="Search file, anchor, or text"
          value={vm.q}
        />
      </div>
      <FilterSelect id="filter-status" label="Status" field="status" current={vm.status} options={STATUS_OPTIONS} />
      <FilterSelect id="filter-project" label="Project" field="project" current={vm.project} options={projectOptions} />
      {/* The no-JS submit path: native selects carrying the names the hidden inputs hold, so the
          filters still work with scripting off. With JS on, this block is not in the DOM. */}
      <noscript>
        <label class="sr-only" for="status-native">Status</label>
        <select class="input" id="status-native" name="status">
          {STATUS_OPTIONS.map((option) => (
            <option value={option.value} selected={option.value === vm.status}>{option.label}</option>
          ))}
        </select>
        <label class="sr-only" for="project-native">Project</label>
        <select class="input" id="project-native" name="project">
          {projectOptions.map((option) => (
            <option value={option.value} selected={option.value === vm.project}>{option.label}</option>
          ))}
        </select>
        <button class="btn btn-primary" type="submit">Apply filters</button>
      </noscript>
    </form>
  );
}

/**
 * What an action round settles into, rendered as the page's one banner: a single refusal (one
 * entry could not move, why, and the fix) or the batch report (how many moved, each refusal
 * named). The route layer builds these from the store's outcomes; the view owns the shapes.
 */
export type ListNotice =
  | { readonly kind: "refusal"; readonly title: string; readonly message: string }
  | { readonly kind: "batch"; readonly approved: number; readonly total: number; readonly refused: readonly string[] };

/** The banner's one dismiss control; ui.js's initDismiss removes the banner it belongs to. */
function BannerDismiss() {
  return (
    <button type="button" class="close" aria-label="Dismiss">
      <svg aria-hidden="true"><use href="#i-x" /></svg>
    </button>
  );
}

/** An action round's settled outcome as the page's one banner: a success panel when a batch fully moved, an alert otherwise. */
function NoticeBanner({ notice }: { notice: ListNotice }) {
  if (notice.kind === "refusal") {
    return (
      <div class="banner banner-danger" role="alert">
        <span class="banner-icon"><svg aria-hidden="true"><use href="#i-error" /></svg></span>
        <div class="banner-body">
          <div class="banner-title">{notice.title}</div>
          <div class="banner-text">{notice.message}</div>
        </div>
        <BannerDismiss />
      </div>
    );
  }
  if (notice.refused.length === 0) {
    return (
      <div class="banner banner-success" role="status">
        <span class="banner-icon"><svg aria-hidden="true"><use href="#i-success" /></svg></span>
        <div class="banner-body">
          <div class="banner-title">
            Approved {notice.approved} {notice.approved === 1 ? "entry" : "entries"}
          </div>
        </div>
        <BannerDismiss />
      </div>
    );
  }
  return (
    <div class="banner banner-danger" role="alert">
      <span class="banner-icon"><svg aria-hidden="true"><use href="#i-error" /></svg></span>
      <div class="banner-body">
        <div class="banner-title">
          Approved {notice.approved} of {notice.total} entries
        </div>
        <ul class="notice-list">
          {notice.refused.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      </div>
      <BannerDismiss />
    </div>
  );
}

/** The page's one banner slot; the htmx fragment replaces it out of band so a round can set or clear it. */
function PageBanner({ notice, oob = false }: { notice: ListNotice | undefined; oob?: boolean }) {
  return (
    <div id="page-banner" hx-swap-oob={oob ? "true" : undefined}>
      {notice !== undefined ? <NoticeBanner notice={notice} /> : null}
    </div>
  );
}

/** The settled list region: the partial count and the tables, or one of the three empty states. The loading and error states are client-side. */
function ListRegion({ vm }: { vm: ListViewModel }) {
  if (vm.shown === 0) {
    // Zero entries at all is "no entries yet" even under a filter: nothing exists to filter, and
    // the empty state explains how entries get here. A store with entries but no matches is either
    // a filter miss or the default Active view over a store full of applied and rejected entries.
    return vm.total === 0 ? (
      <EmptyAll />
    ) : vm.filtersActive ? (
      <EmptyMatch
        revealAllHref={
          vm.hiddenByActiveView
            ? `/?q=${encodeURIComponent(vm.q)}&project=${encodeURIComponent(vm.project)}&status=all`
            : undefined
        }
      />
    ) : (
      <EmptyActive />
    );
  }
  return (
    <>
      {vm.filtersActive && vm.shown < vm.total ? <PartialHeader shown={vm.shown} total={vm.total} /> : null}
      <BatchForm vm={vm} />
    </>
  );
}

function PartialHeader({ shown, total }: { shown: number; total: number }) {
  return (
    <div class="toolbar partial-header">
      <span class="pagination-count">Showing {shown} of {total} entries</span>
      <div class="grow"></div>
      <a href="/" class="btn btn-secondary btn-sm">Clear filters</a>
    </div>
  );
}

function EmptyAll() {
  return (
    <div class="empty-state">
      <svg aria-hidden="true"><use href="#i-file" /></svg>
      <div class="empty-title">No entries yet</div>
      <div>Agents file text through the reviewzy mcp endpoint. Filed entries appear here.</div>
    </div>
  );
}

/**
 * The filter-miss state, with a way onward. When the default Active view is what hides the
 * matches (a search that only hits applied or rejected rows), the way onward is the all-statuses
 * view under the same filters — clearing the filters alone would land back on the Active view
 * and still show nothing.
 */
function EmptyMatch({ revealAllHref }: { revealAllHref: string | undefined }) {
  return (
    <div class="empty-state">
      <svg aria-hidden="true"><use href="#i-search" /></svg>
      <div class="empty-title">No entries match</div>
      <div>Try different search terms, or clear the filters.</div>
      {revealAllHref !== undefined ? <div>Applied and rejected entries are hidden from this view.</div> : null}
      <div class="empty-actions">
        <a href="/" class="btn btn-secondary btn-sm">Clear filters</a>
        {revealAllHref !== undefined ? (
          <a href={revealAllHref} class="btn btn-secondary btn-sm">Show all statuses</a>
        ) : null}
      </div>
    </div>
  );
}

/** The default Active view over a store whose entries are all applied or rejected: nothing to do, no filters to clear. */
function EmptyActive() {
  return (
    <div class="empty-state">
      <svg aria-hidden="true"><use href="#i-success" /></svg>
      <div class="empty-title">Nothing to review</div>
      <div>Every filed entry is applied or rejected. New drafts appear here as agents file them.</div>
    </div>
  );
}

/**
 * The batch approve form wrapping every project table: the checkboxes post as `id`, the hidden
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
      <div class="toolbar batch-bar">
        <button class="btn btn-fill btn-sm" type="submit" hx-disabled-elt="this">
          Approve selected
        </button>
      </div>
      {vm.groups.map((group) => (
        <ProjectTable key={group.slug} group={group} />
      ))}
    </form>
  );
}

/**
 * One project's entries as one dense table. The project is a heading, not a disclosure: batches
 * stay a data concept behind the row selection and the one approve action. The select-all sits in
 * the header and drives this table's drafts through ui.js's per-wrap state machine.
 */
function ProjectTable({ group }: { group: ProjectGroup }) {
  const count = group.entries.length;
  return (
    <section class="project-section">
      <div class="section-head project-head">
        <h2 class="section-title project-name">{group.slug}</h2>
        <span class="tag tag-data num">
          {count} {count === 1 ? "entry" : "entries"}
        </span>
      </div>
      <div class="table-wrap table-dense">
        <table>
          <colgroup>
            <col class="col-select" />
            <col />
            <col class="col-status" />
            <col class="col-file" />
            <col class="col-filed" />
            <col class="col-actions" />
          </colgroup>
          <thead>
            <tr>
              {/* The select-all lives in the checkbox column: ui.js's initTables owns the
                  checked and indeterminate state machine for the wrap. No `name`, so it never
                  submits as an entry id; only the draft checkboxes post as `id`. */}
              <th class="cell-select" scope="col">
                <span class="sr-only">Select</span>
                <label class="checkbox-label">
                  <input type="checkbox" data-select-all aria-label={`Select all drafts in ${group.slug}`} />
                </label>
              </th>
              <th scope="col">Title</th>
              <th scope="col">Status</th>
              <th scope="col">File</th>
              <th scope="col">Filed</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {group.entries.map((entry) => (
              <EntryRowView key={entry.id} entry={entry} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The filed time, absolute and short: UTC date plus minutes, so the stamp reads the same wherever the server runs. */
function filedStamp(createdAt: number): { iso: string; short: string } {
  const iso = new Date(createdAt).toISOString();
  return { iso, short: `${iso.slice(0, 10)} ${iso.slice(11, 16)}` };
}

/**
 * One row. The checkbox names the entry for the batch form (and `data-name` hands it to the
 * selection controller); it exists only on drafts, because an approve on any other status always
 * refuses and a checkbox that can only refuse is noise (races are still reported per entry). The
 * status chip sits in its own column; the three icon action slots always render, inapplicable ones
 * disabled, so a double-click's second click lands on the disabled slot rather than a shifted
 * action. Approve and reject target the list region and include the batch form's hidden filters,
 * so an action round re-renders the region under the same filter; the editor link is always
 * present.
 */
function EntryRowView({ entry }: { entry: EntryRow }) {
  const title = entryTitle(entry);
  const filed = filedStamp(entry.created_at);
  const approve = entry.status === "draft";
  const reject = entry.status === "draft" || entry.status === "approved";
  return (
    <tr>
      <td class="cell-select">
        {approve ? (
          <label class="checkbox-label">
            <input type="checkbox" name="id" value={entry.id} data-name={entry.id} aria-label={`Select ${entry.file}`} />
          </label>
        ) : null}
      </td>
      <td>
        <div class="entry-head">
          <span class="entry-title truncate">{title}</span>
        </div>
        {/* A titled entry displays the title in place of the anchor text, so the anchor the entry
            changes would otherwise reach no one but the editor. */}
        {hasOwnTitle(entry) ? <span class="sr-only">{entry.anchor_text}</span> : null}
      </td>
      <td>
        <span class={`tag ${STATUS_TAG[entry.status]}`}>
          <span class="tag-dot"></span>
          {STATUS_LABEL[entry.status]}
        </span>
      </td>
      <td class="cell-file truncate">{entry.file}</td>
      <td class="cell-time">
        <time class="num" datetime={filed.iso}>{filed.short}</time>
      </td>
      <td class="cell-actions">
        {approve ? (
          <button
            type="button"
            class="btn btn-icon"
            style="color: var(--success)"
            aria-label={`Approve ${entry.file}`}
            hx-post={`/entries/${entry.id}/approve`}
            hx-target="#entries-list"
            hx-swap="innerHTML"
            hx-indicator="#entries-loading"
            hx-disabled-elt="this"
          >
            <svg aria-hidden="true"><use href="#i-check" /></svg>
          </button>
        ) : (
          // The approve slot stays occupied on every non-draft row: a double-click's second click
          // lands on the disabled button (pointer-events none) rather than the next slot.
          <button type="button" class="btn btn-icon" style="color: var(--success)" aria-label={`Approve ${entry.file}`} disabled>
            <svg aria-hidden="true"><use href="#i-check" /></svg>
          </button>
        )}
        {reject ? (
          <button
            type="button"
            class="btn btn-icon"
            style="color: var(--danger)"
            aria-label={`Reject ${entry.file}`}
            hx-post={`/entries/${entry.id}/reject`}
            hx-target="#entries-list"
            hx-swap="innerHTML"
            hx-indicator="#entries-loading"
            hx-disabled-elt="this"
          >
            <svg aria-hidden="true"><use href="#i-x" /></svg>
          </button>
        ) : (
          // The reject slot stays occupied on applied and rejected rows for the same guard.
          <button type="button" class="btn btn-icon" style="color: var(--danger)" aria-label={`Reject ${entry.file}`} disabled>
            <svg aria-hidden="true"><use href="#i-x" /></svg>
          </button>
        )}
        <a class="btn btn-icon" href={`/entries/${entry.id}`} aria-label={`Edit ${entry.file}`}>
          <svg aria-hidden="true"><use href="#i-edit" /></svg>
        </a>
      </td>
    </tr>
  );
}

/** The saved theme, restored before the stylesheet, or a light-theme visitor sees a dark flash. */
const THEME_RESTORE = raw(
  'const saved = localStorage.getItem("cloudy-theme"); if (saved) document.documentElement.dataset.theme = saved;',
);

/** The head shared by every full page: the three stylesheets in order, then htmx and the dashboard module. */
function PageHead({ title }: { title: string }) {
  return (
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      {/* The empty data: URL kills the browser's /favicon.ico probe, which would 404 under /static. */}
      <link rel="icon" href="data:," />
      <title>{title}</title>
      <script>{THEME_RESTORE}</script>
      <link rel="stylesheet" href="/static/tokens.css" />
      <link rel="stylesheet" href="/static/components.css" />
      <link rel="stylesheet" href="/static/cursor.css" />
      <link rel="stylesheet" href="/static/dashboard.css" />
      <script src="/static/htmx.min.js"></script>
      <script type="module" src="/static/dashboard.js"></script>
    </head>
  );
}

/** The sprite as the body's first child; cursor.js creates its own canvas and nothing else may enter that slot. */
function IconSprite() {
  return <>{raw(ICON_SPRITE)}</>;
}

/** The two controller modules, at the end of the body, exactly as the wiring prescribes. */
function PageModules() {
  return (
    <>
      <script type="module" src="/static/cursor.js"></script>
      <script type="module" src="/static/ui.js"></script>
    </>
  );
}

/** The full page for a plain navigation; the mount wraps it in the doctype. `signedIn` is whether the sidebar offers sign-out. */
export function dashboardPage(
  store: Store,
  params: ListParams,
  notice: ListNotice | undefined = undefined,
  signedIn = false,
): JSX.Element {
  const vm = loadList(store, params);
  return (
    <html lang="en" data-theme="dark">
      <PageHead title={`Entries · ${NAME}`} />
      <body>
        <IconSprite />
        <Shell signedIn={signedIn} active="entries" draftCount={vm.counts.draft}>
          <PageHeader total={vm.total} projects={vm.projects.length} />
          <PageBanner notice={notice} />
          <StatsGrid counts={vm.counts} />
          <section>
            {/* The eyebrow alone names the section: the page title already reads "Entries",
                and a second one of the same word stacks two display lines. */}
            <div class="section-head">
              <div class="label">Queue</div>
            </div>
            <FilterForm vm={vm} />
            <div id="entries">
              <div id="entries-loading" class="htmx-indicator" role="status">
                <span class="spinner" aria-hidden="true"></span>
                Loading entries
              </div>
              <div id="entries-list">
                <ListRegion vm={vm} />
              </div>
            </div>
          </section>
        </Shell>
        <div class="toast-stack" id="toast-stack"></div>
        <PageModules />
      </body>
    </html>
  );
}

/**
 * The login screen: a viewport-owning page-state with the sign-in card and no shell — the way out
 * is signing in. `error` is the single failure message, shown as an alert callout inside the
 * card's flow; the field itself is always cleared, and `next` rides along as a hidden input so a
 * successful retry still lands where the visitor was going.
 */
export function loginPage(next: string | undefined, error: string | undefined = undefined): JSX.Element {
  return (
    <html lang="en" data-theme="dark">
      <PageHead title={`Sign in · ${NAME}`} />
      <body>
        <IconSprite />
        <main class="page-state">
          <div class="page-state-card">
            <div class="page-state-brand">
              <div class="logo-name">{NAME}</div>
            </div>
            <form method="post" action="/login" class="card">
              {next !== undefined ? <input type="hidden" name="next" value={next} /> : null}
              <div class="card-header">
                <div>
                  <div class="card-title">Sign in</div>
                  <div class="card-subtitle">The dashboard is password protected. Enter the password to continue.</div>
                </div>
              </div>
              <div class="card-content login-content">
                {error !== undefined ? <DangerCallout title={error} /> : null}
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
                  <button class="btn btn-fill" type="submit">Sign in</button>
                </div>
              </div>
            </form>
          </div>
        </main>
        <PageModules />
      </body>
    </html>
  );
}

/**
 * The list region only, for htmx requests. The stat cards, the sidebar badge and the banner sit
 * outside the main swap target, so they ride out-of-band swaps instead of going stale after an
 * action round.
 */
export function entriesFragment(store: Store, params: ListParams, notice: ListNotice | undefined = undefined): JSX.Element {
  const vm = loadList(store, params);
  return (
    <>
      <DraftBadge count={vm.counts.draft} oob />
      <PageBanner notice={notice} oob />
      <StatsGrid counts={vm.counts} oob />
      <ListRegion vm={vm} />
    </>
  );
}

// ---- Entry editor ----

export type EditorViewModel = {
  readonly entry: EntryRow;
  readonly revisions: readonly RevisionRow[];
  readonly constraints: Constraints;
  /** The entry immediately before/after in the list's ascending-id walk, or null at the boundary. */
  readonly prevId: string | null;
  readonly nextId: string | null;
  /** The sidebar's queue badge, read once with the editor's own query. */
  readonly draftCount: number;
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
  const { prevId, nextId } = adjacentEntryIds(store, id);
  return {
    entry,
    revisions: listRevisions(store, id),
    constraints: parseConstraints(entry.constraints),
    prevId,
    nextId,
    draftCount: countEntriesByStatus(store).draft,
  };
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
        : "This entry was rejected, so its text can't be changed. A rejected entry stays rejected; file a new entry if the passage still needs changing.";
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
          return `Entry ${entryFile} was rejected, and a rejected entry stays rejected. File a new entry if the passage still needs changing.`;
      }
  }
}

function DangerCallout({ title, body }: { title: string; body?: string }) {
  return (
    <div class="callout callout-danger" role="alert">
      <div class="callout-icon">
        <svg aria-hidden="true"><use href="#i-error" /></svg>
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
          <div class="card-title editor-title">{entryTitle(vm.entry)}</div>
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
            <button class="btn btn-fill" type="submit">Save text</button>
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

/** The audit log of saved revisions: the shipped timeline, one dot per entry. */
function RevisionHistory({ revisions }: { revisions: readonly RevisionRow[] }) {
  return (
    <div class="card">
      <div class="card-header">
        <div class="card-title">Revision history</div>
      </div>
      <div class="card-content">
        {revisions.length === 0 ? (
          <div class="empty-state">
            <div class="empty-title">No saved revisions yet</div>
          </div>
        ) : (
          <ol class="timeline">
            {revisions.map((revision) => (
              <li class="timeline-item" key={revision.id}>
                <span class={`timeline-dot ${STATUS_DOT[revision.status]}`} aria-hidden="true"></span>
                <div>
                  <div class="timeline-head">
                    <span class={`tag tag-data ${STATUS_TAG[revision.status]}`}>{STATUS_LABEL[revision.status]}</span>
                    <time class="timeline-time" datetime={new Date(revision.created_at).toISOString()}>
                      {new Date(revision.created_at).toLocaleString()}
                    </time>
                    <button class="btn btn-secondary btn-sm" type="button" data-use-revision>
                      Use
                    </button>
                  </div>
                  <div class="timeline-body clamp-2">{revision.human_text}</div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/** The constraint panel as the system's key-value readout: live count and placeholder checklist stay wired. */
function ConstraintsCard({ constraints, text }: { constraints: Constraints; text: string }) {
  const maxLen = constraints.maxLen;
  const placeholders = constraints.placeholders;
  const tone = constraints.tone;
  const hasAny = maxLen !== undefined || placeholders.length > 0 || tone !== undefined;
  if (!hasAny) return null;
  return (
    <div class="card">
      <div class="card-header">
        <div class="card-title">Constraints</div>
      </div>
      <div class="card-content">
        <table class="info-table">
          {maxLen !== undefined ? (
            <tr key="max-len">
              <td>Length</td>
              <td>
                <span id="char-count" class="num char-count" data-max-len={maxLen}>
                  {text.length} / {maxLen}
                </span>
              </td>
            </tr>
          ) : null}
          {placeholders.length > 0 ? (
            <tr key="placeholders">
              <td>Placeholders</td>
              <td>
                <ul class="placeholder-list">
                  {placeholders.map((placeholder) => {
                    const present = text.includes(placeholder);
                    return (
                      <li class="placeholder-item" data-placeholder={placeholder} key={placeholder}>
                        <span class={`placeholder-state${present ? " is-present" : ""}`}>
                          {present ? "Present" : "Missing"}
                        </span>
                        <span class="tag tag-data">{"{" + placeholder + "}"}</span>
                      </li>
                    );
                  })}
                </ul>
              </td>
            </tr>
          ) : null}
          {tone !== undefined ? (
            <tr key="tone">
              <td>Tone</td>
              <td>{tone}</td>
            </tr>
          ) : null}
        </table>
      </div>
    </div>
  );
}

/**
 * The notes card: the agent's notes (from `constraints.notes`, read-only) above the human's own
 * notes as an editable textarea with its own save. The textarea carries `hx-preserve`, so any swap
 * (a text save, an image add) keeps the human's in-progress note; the save targets the whole
 * editor view like the save form, so the saved value re-renders in place. The card always renders:
 * the human's notes need a home even before the agent sent any.
 */
function NotesCard({ vm }: { vm: EditorViewModel }) {
  return (
    <div class="card">
      <div class="card-header">
        <div class="card-title">Notes</div>
      </div>
      <div class="card-content">
        <table class="info-table">
          <tr>
            <td>Agent's notes</td>
            <td>{vm.constraints.notes ?? "None."}</td>
          </tr>
        </table>
        <form
          id="notes-form"
          method="post"
          action={`/entries/${vm.entry.id}/notes`}
          hx-post={`/entries/${vm.entry.id}/notes`}
          hx-target="#editor-view"
          hx-swap="outerHTML"
        >
          <div class="field notes-field">
            <label class="field-label" for="editor-notes">Your notes</label>
            <textarea
              id="editor-notes"
              class="input"
              name="notes"
              rows={4}
              aria-label="Your notes"
              hx-preserve="true"
            >
              {vm.entry.human_notes ?? ""}
            </textarea>
          </div>
          <div class="notes-actions">
            <button class="btn btn-secondary btn-sm" type="submit">Save notes</button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** An image item renders only when it still matches the prefixes the wire validated; a foreign row can hold anything, so a non-matching item shows a note instead, never raw. */
function isRenderableImage(item: string): boolean {
  return item.startsWith("data:image/") || /^https?:\/\//.test(item);
}

/**
 * The images attached to an entry, one card in the rail: each valid item as a real `img` (sized by
 * css), an invalid one as a "not shown" note, a remove form per image, and the one-file upload as
 * the system dropzone. A card of its own, not a strip in the context card: upload and remove need a
 * stable home, and the context card stays lean for what the human authors against. Both forms
 * target the whole editor view like the save form, so a change re-renders the card in place.
 */
function ImagesCard({ entry }: { entry: EntryRow }) {
  const images = parseEntryImages(entry.images);
  return (
    <div class="card">
      <div class="card-header">
        <div class="card-title">Images</div>
      </div>
      <div class="card-content">
        <div class="dropzone">
          {/* The native input is the picker and its accessible name; the zone is its paint.
              It is associated to the submit form by id rather than nested in it, so the zone
              keeps the direct-child shape the dropzone's own state rules select on. */}
          <label class="dropzone-target">
            <svg class="icon" aria-hidden="true"><use href="#i-upload" /></svg>
            <span class="dropzone-lede">Image file</span>
            <input
              class="dropzone-input"
              type="file"
              name="file"
              accept="image/*"
              aria-label="Image file"
              form="image-upload"
            />
          </label>
          {images.length === 0 ? (
            <p class="field-hint">No images yet.</p>
          ) : (
            <ul class="dropzone-list image-list">
              {images.map((item, index) =>
                isRenderableImage(item) ? (
                  <li key={index}>
                    <img class="entry-image" src={item} alt={`Image ${index + 1}`} loading="lazy" />
                    <form
                      class="image-remove"
                      method="post"
                      action={`/entries/${entry.id}/images/${index}/remove`}
                      hx-post={`/entries/${entry.id}/images/${index}/remove`}
                      hx-target="#editor-view"
                      hx-swap="outerHTML"
                    >
                      <button class="btn btn-secondary btn-sm" type="submit">Remove</button>
                    </form>
                  </li>
                ) : (
                  <li key={index}>
                    <p class="image-skip">Image {index + 1} not shown: unsupported source.</p>
                  </li>
                ),
              )}
            </ul>
          )}
          <form
            id="image-upload"
            class="image-upload"
            method="post"
            action={`/entries/${entry.id}/images`}
            enctype="multipart/form-data"
            hx-post={`/entries/${entry.id}/images`}
            hx-encoding="multipart/form-data"
            hx-target="#editor-view"
            hx-swap="outerHTML"
          >
            <button class="btn btn-secondary btn-sm" type="submit" hx-disabled-elt="this">Add image</button>
          </form>
        </div>
      </div>
    </div>
  );
}

/**
 * The repo row's value: a recognized remote renders as its brand icon beside the bare owner/repo
 * path, both linking out to the host; an unrecognized one renders as the raw string as filed. The
 * visible path is the short form, so the full remote rides along for assistive tech.
 */
function RepoValue({ repo }: { repo: string }) {
  const link = parseRepoLink(repo);
  if (link === null) return <>{repo}</>;
  return (
    <a class="repo-link" href={link.href} target="_blank" rel="noopener noreferrer">
      <svg class="repo-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d={REPO_ICON[link.provider]} />
      </svg>
      <span>{link.path}</span>
      <span class="sr-only">{repo}</span>
    </a>
  );
}

/**
 * The entry's context JSON plus its anchor metadata, as an info-table readout. The anchor and the
 * agent-supplied context rows lead — they are what the human authors against — then repo and file;
 * the provenance rows (hash, filer, stale note) are secondary and sit collapsed behind a summary.
 */
function ContextCard({ entry }: { entry: EntryRow }) {
  const context = parseContext(entry.context);
  return (
    <div class="card">
      <div class="card-header">
        <div class="card-title">Context</div>
      </div>
      <div class="card-content">
        <table class="info-table">
          <tr>
            <td>Anchor</td>
            <td>{entry.anchor_text}</td>
          </tr>
          {Object.entries(context).map(([key, value]) => (
            <tr key={key}>
              <td>{key}</td>
              <td>{typeof value === "string" ? value : JSON.stringify(value)}</td>
            </tr>
          ))}
          <tr>
            <td>Repo</td>
            <td><RepoValue repo={entry.repo} /></td>
          </tr>
          <tr>
            <td>File</td>
            <td>{entry.file}</td>
          </tr>
        </table>
        <details class="disclosure context-secondary">
          <summary>
            <svg aria-hidden="true"><use href="#i-chevron-right" /></svg>
            <span>More</span>
          </summary>
          <div class="disclosure-body">
            <table class="info-table">
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
        </details>
      </div>
    </div>
  );
}

/**
 * The before-and-after of the entry's text, above the editor: what the anchored region reads now
 * (the anchor marked as the annotation) and what the entry's text will replace it with. Both sides
 * escape through JSX; the text is the stored bytes, shown as-is. The word-level marks come from
 * the server-side walk: words only the anchor has render red in the before card, words only the proposal
 * has render green in the after card, everything shared stays plain, so an identical pair renders
 * no marks at all.
 */
function DiffView({ entry }: { entry: EntryRow }) {
  const after = entry.human_text ?? entry.agent_draft;
  // No text at all means nothing to compare: a filed entry whose agent never drafted, or an
  // approved entry whose text was never set.
  if (after === null) return null;
  const diff = diffWords(entry.anchor_text, after);
  return (
    <div class="diff-grid">
      <div class="card">
        <div class="card-header">
          <div class="card-title">Before</div>
        </div>
        <pre class="diff-code">
          <span class="diff-line">{entry.anchor_before}</span>
          <span class="diff-line diff-anchor annot-mark">
            {diff.before.map((token, index) =>
              token.kind === "removed" ? (
                <span class="diff-remove" key={index}>{token.text}</span>
              ) : (
                token.text
              ),
            )}
          </span>
          <span class="diff-line">{entry.anchor_after}</span>
        </pre>
      </div>
      <div class="card">
        <div class="card-header">
          <div class="card-title">After</div>
        </div>
        <pre class="diff-code">
          {diff.after.map((token, index) =>
            token.kind === "added" ? (
              <span class="diff-add" key={index}>{token.text}</span>
            ) : (
              token.text
            ),
          )}
        </pre>
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
          <NotesCard vm={vm} />
          <ImagesCard entry={vm.entry} />
        </aside>
      </div>
    </div>
  );
}

/** The editor's full-height prev/next rails: one fixed strip per side, a link when a neighbour exists. */
function EditorNav({ prevId, nextId }: { prevId: string | null; nextId: string | null }) {
  return (
    <nav class="editor-nav" aria-label="Entry navigation">
      <EditorNavButton side="prev" targetId={prevId} />
      <EditorNavButton side="next" targetId={nextId} />
    </nav>
  );
}

/** One rail: a chevron on a full-height strip, or an inert placeholder at the boundary. */
function EditorNavButton({ side, targetId }: { side: "prev" | "next"; targetId: string | null }) {
  const label = side === "prev" ? "Previous entry" : "Next entry";
  const cls = `editor-nav-btn editor-nav-${side}`;
  const icon = (
    <svg aria-hidden="true"><use href={side === "prev" ? "#i-chevron-left" : "#i-chevron-right"} /></svg>
  );
  if (targetId === null) {
    return (
      <span class={`${cls} is-disabled`} aria-hidden="true">
        {icon}
      </span>
    );
  }
  return (
    <a class={cls} href={`/entries/${targetId}`} aria-label={label}>
      {icon}
    </a>
  );
}

/** The full editor page; the mount wraps it in the doctype. `signedIn` is whether the sidebar offers sign-out. */
export function editorPage(vm: EditorViewModel, state: EditorState | undefined = undefined, signedIn = false): JSX.Element {
  return (
    <html lang="en" data-theme="dark">
      <PageHead title={`Edit entry · ${NAME}`} />
      <body>
        <IconSprite />
        <Shell signedIn={signedIn} active="entries" draftCount={vm.draftCount}>
          <header class="page-header">
            <div class="page-header-body">
              <div class="label">Entry review</div>
              <h1 class="page-title">Edit entry</h1>
              <p class="section-lede">Saving the text approves the entry and releases it to agents.</p>
            </div>
          </header>
          <EditorView vm={vm} state={state} />
          <EditorNav prevId={vm.prevId} nextId={vm.nextId} />
          {/* The one live region: announcements on constraint-state flips only, so a screen reader
              is not flooded with a per-keystroke value. Lives outside the swap region. */}
          <span id="editor-live" class="sr-only" aria-live="polite"></span>
        </Shell>
        <div class="toast-stack" id="toast-stack"></div>
        <PageModules />
      </body>
    </html>
  );
}

/** The editor region only, for htmx transition responses; the page shell, diff, context, and constraints stay put. The badge rides out of band because approving here moves the queue count. */
export function editorFragment(vm: EditorViewModel, state: EditorState | undefined = undefined): JSX.Element {
  return (
    <>
      <DraftBadge count={vm.draftCount} oob />
      <EditorRegion vm={vm} state={state} />
    </>
  );
}

/** The whole editor view (diff + region + rail), for htmx save responses: a save changes the diff's after-side and can approve the entry, so the swap re-renders it and moves the queue badge with it. */
export function editorViewFragment(vm: EditorViewModel, state: EditorState | undefined = undefined): JSX.Element {
  return (
    <>
      <DraftBadge count={vm.draftCount} oob />
      <EditorView vm={vm} state={state} />
    </>
  );
}

/** The viewport-owning error page for an unknown entry id or route, with the way onward the page-not-found pattern demands. */
export function notFoundPage(_signedIn = false): JSX.Element {
  return (
    <html lang="en" data-theme="dark">
      <PageHead title={`Entry not found · ${NAME}`} />
      <body>
        <IconSprite />
        <main class="page-state">
          <div class="page-state-gap">
            <div class="page-state-body">
              <p class="page-state-title">Entry not found</p>
              <p class="page-state-text">This entry doesn't exist. Return to the list to find it.</p>
              <div class="page-state-actions">
                <a href="/" class="btn btn-fill">Back to entries</a>
              </div>
            </div>
          </div>
        </main>
        <PageModules />
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
  /** The sidebar's queue badge, read with the page's own store access. */
  readonly draftCount: number;
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
    draftCount: countEntriesByStatus(store).draft,
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
      <div class="callout-icon">
        <svg aria-hidden="true"><use href="#i-info" /></svg>
      </div>
      <div class="callout-content">
        <div class="callout-title">{title}</div>
        {body !== undefined ? <div class="callout-body">{body}</div> : null}
      </div>
    </div>
  );
}

/** The project selector: the global section plus every known project, as underline tabs with the current one marked. A link list is the whole mechanism; the section never auto-creates a project. ui.js builds the sliding ink. */
function StyleGuideProjects({ vm }: { vm: StyleGuideViewModel }) {
  const activeSlug = vm.unknown ? null : vm.projectSlug;
  return (
    <nav class="tabs-wrap style-guide-projects" aria-label="Style guide sections">
      <div class="tabs">
        <ProjectSectionLink href="/style-guide" label="Global" active={activeSlug === null} />
        {vm.projects.map((project) => (
          <ProjectSectionLink
            key={project.slug}
            href={`/style-guide?project=${project.slug}`}
            label={project.slug}
            active={activeSlug === project.slug}
          />
        ))}
      </div>
    </nav>
  );
}

function ProjectSectionLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <a class={`tab${active ? " active" : ""}`} href={href} aria-current={active ? "page" : undefined}>
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
          <div class="callout-icon">
            <svg aria-hidden="true"><use href="#i-success" /></svg>
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
        <div class="card-content form-grid">
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
            <button class="btn btn-fill" type="submit" hx-disabled-elt="this">Save guide</button>
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

/** The full style guide page; the mount wraps it in the doctype. `signedIn` is whether the sidebar offers sign-out. */
export function styleGuidePage(
  vm: StyleGuideViewModel,
  state: StyleGuideEditorState | undefined = undefined,
  signedIn = false,
): JSX.Element {
  return (
    <html lang="en" data-theme="dark">
      <PageHead title={`Style guide · ${NAME}`} />
      <body>
        <IconSprite />
        <Shell signedIn={signedIn} active="style-guide" draftCount={vm.draftCount}>
          <header class="page-header">
            <div class="page-header-body">
              <div class="label">Voice</div>
              <h1 class="page-title">Style guide</h1>
              <p class="section-lede">The voice agents read before drafting, starting with the global guide and adding each project's own rules below.</p>
            </div>
          </header>
          <StyleGuideProjects vm={vm} />
          <StyleGuideRegion vm={vm} state={state} />
        </Shell>
        <div class="toast-stack" id="toast-stack"></div>
        <PageModules />
      </body>
    </html>
  );
}

/** The style guide region only, for htmx responses; the selector, the page shell, and the toast stack stay put. */
export function styleGuideRegionFragment(vm: StyleGuideViewModel, state: StyleGuideEditorState | undefined = undefined): JSX.Element {
  return <StyleGuideRegion vm={vm} state={state} />;
}

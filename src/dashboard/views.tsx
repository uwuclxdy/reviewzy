import type { JSX } from "hono/jsx/jsx-runtime";
import {
  countEntries,
  listEntries,
  listProjects,
  projectIdBySlug,
} from "../db/queries.ts";
import type { EntryRow, EntryStatus } from "../db/queries.ts";
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

/** The constraint summary cell: max_len and placeholders from the stored constraints JSON, mono, middot-joined. */
function constraintSummary(constraintsJson: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(constraintsJson);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const constraints = parsed as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof constraints.max_len === "number") parts.push(`max ${constraints.max_len}`);
  if (Array.isArray(constraints.placeholders)) {
    for (const placeholder of constraints.placeholders) {
      if (typeof placeholder === "string" && placeholder !== "") parts.push(`{${placeholder}}`);
    }
  }
  return parts;
}

function Navbar() {
  return (
    <nav class="navbar">
      <div class="navbar-brand">
        <div class="logo-name">{NAME}</div>
        <div class="logo-version">v{VERSION}</div>
      </div>
      <div class="navbar-nav" id="navbar-nav">
        <a class="navbar-link active" href="/">Entries</a>
        <div class="navbar-ink" id="navbar-ink"></div>
      </div>
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

/** The settled list region: success, empty, or partial. The loading and error states are client-side. */
function ListRegion({ vm }: { vm: ListViewModel }) {
  if (vm.shown === 0) {
    // Zero entries at all is "no entries yet" even under a filter: nothing exists to filter, and
    // the empty state explains how entries get here. Only a store with entries can have matches.
    return vm.total === 0 ? <EmptyAll /> : <EmptyMatch />;
  }
  return (
    <>
      {vm.filtersActive && vm.shown < vm.total ? <PartialHeader shown={vm.shown} total={vm.total} /> : null}
      {vm.groups.map((group) => (
        <ProjectGroupView key={group.slug} group={group} />
      ))}
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
      {group.batches.map((batch) => (
        <div class="batch" key={batch.id}>
          <div class="batch-header">
            <span class="label">Batch</span>
            <span class="batch-id">{batch.id}</span>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Anchor</th>
                  <th>Text</th>
                  <th>Status</th>
                  <th>Filed by</th>
                  <th>Constraints</th>
                </tr>
              </thead>
              <tbody>
                {batch.entries.map((entry) => (
                  <EntryRowView key={entry.id} entry={entry} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
}

function EntryRowView({ entry }: { entry: EntryRow }) {
  const text = entry.human_text ?? entry.agent_draft;
  const constraints = constraintSummary(entry.constraints);
  return (
    <tr>
      <td class="cell-file">
        <span class="file-path" title={entry.file}>{entry.file}</span>
      </td>
      <td class="cell-anchor">
        <span class="anchor-text" title={entry.anchor_text}>{entry.anchor_text}</span>
      </td>
      <td class="cell-text">
        <span class="entry-text" title={text ?? ""}>{text}</span>
      </td>
      <td>
        <span class={`tag ${STATUS_TAG[entry.status]}`}>
          <span class="tag-dot"></span>
          {STATUS_LABEL[entry.status]}
        </span>
      </td>
      <td class="cell-filedby">{entry.filed_by ?? ""}</td>
      <td class="cell-constraints">
        {constraints.length > 0 ? <span class="constraint-summary">{constraints.join(" · ")}</span> : null}
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

/** The full page for a plain navigation; the mount wraps it in the doctype. */
export function dashboardPage(store: Store, params: ListParams): JSX.Element {
  const vm = loadList(store, params);
  return (
    <html lang="en" data-theme="dark">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Entries · {NAME}</title>
        <link rel="stylesheet" href="/static/tokens.css" />
        <link rel="stylesheet" href="/static/components.css" />
        <link rel="stylesheet" href="/static/dashboard.css" />
        <script src="/static/htmx.min.js"></script>
        <script src="/static/dashboard.js" defer></script>
      </head>
      <body>
        <div class="app-shell">
          <Navbar />
          <main class="main">
            <PageHeader />
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
            <ErrorBoxTemplate />
          </main>
        </div>
      </body>
    </html>
  );
}

/** The list region only, for htmx requests; the loading strip and the error template stay in the page. */
export function entriesFragment(store: Store, params: ListParams): JSX.Element {
  return <ListRegion vm={loadList(store, params)} />;
}

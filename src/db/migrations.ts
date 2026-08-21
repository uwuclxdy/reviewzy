export type Migration = {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
};

const STATUS_VALUES = "'draft', 'approved', 'applied', 'rejected'";
const STATUS_CHECK = `status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (${STATUS_VALUES}))`;
const REVISION_STATUS_CHECK = `status TEXT NOT NULL CHECK (status IN (${STATUS_VALUES}))`;

// sqlite INTEGER affinity only converts a well-formed integer literal; an ISO string or a float
// stores as-is otherwise, so the "timestamps are integer ms" decision needs its own CHECK.
const tsRequired = (col: string) => `${col} INTEGER NOT NULL CHECK (typeof(${col}) = 'integer')`;
const tsNullable = (col: string) => `${col} INTEGER CHECK (${col} IS NULL OR typeof(${col}) = 'integer')`;

/**
 * `docs/mcp-contract.md` "entry schema" and "identity key" own these columns; do not add,
 * rename, or drop a field here without updating that frozen doc first.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "init",
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        ${tsRequired("created_at")}
      );

      CREATE TABLE entries (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id),
        batch_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        file TEXT NOT NULL,
        anchor_text TEXT NOT NULL,
        anchor_before TEXT NOT NULL,
        anchor_after TEXT NOT NULL,
        anchor_hash TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        agent_draft TEXT,
        human_text TEXT,
        ${STATUS_CHECK},
        context TEXT NOT NULL,
        constraints TEXT NOT NULL,
        filed_by TEXT,
        stale_note TEXT,
        ${tsRequired("created_at")},
        ${tsRequired("updated_at")},
        ${tsNullable("applied_at")},
        ${tsNullable("archived_at")},
        UNIQUE (project_id, repo, file, anchor_hash)
      );

      -- entry_id keeps a plain NO ACTION foreign key: a sweep that archives an entry without
      -- first moving its revisions must fail loudly rather than orphan or destroy them
      -- (cloudy, 2026-08-15; mcp-contract "three more tables").
      CREATE TABLE entry_revisions (
        id TEXT PRIMARY KEY NOT NULL,
        entry_id TEXT NOT NULL REFERENCES entries(id),
        human_text TEXT NOT NULL,
        ${REVISION_STATUS_CHECK},
        ${tsRequired("created_at")}
      );

      -- entry_revisions has exactly one access path (by entry_id, task 12's history pane) and no
      -- autoindex covers it.
      CREATE INDEX entry_revisions_entry_id_idx ON entry_revisions(entry_id);

      CREATE TABLE entries_archive (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id),
        batch_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        file TEXT NOT NULL,
        anchor_text TEXT NOT NULL,
        anchor_before TEXT NOT NULL,
        anchor_after TEXT NOT NULL,
        anchor_hash TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        agent_draft TEXT,
        human_text TEXT,
        ${STATUS_CHECK},
        context TEXT NOT NULL,
        constraints TEXT NOT NULL,
        filed_by TEXT,
        stale_note TEXT,
        ${tsRequired("created_at")},
        ${tsRequired("updated_at")},
        ${tsNullable("applied_at")},
        ${tsRequired("archived_at")}
      );

      -- Mirrors entry_revisions plus archived_at; a sweep moves an entry's revisions here in the
      -- same transaction as the entry's own move, so the history has no expiry
      -- (cloudy, 2026-08-15; docs/design.md "revisions").
      CREATE TABLE entry_revisions_archive (
        id TEXT PRIMARY KEY NOT NULL,
        entry_id TEXT NOT NULL REFERENCES entries_archive(id),
        human_text TEXT NOT NULL,
        ${REVISION_STATUS_CHECK},
        ${tsRequired("created_at")},
        ${tsRequired("archived_at")}
      );
    `,
  },
  {
    version: 2,
    name: "style-guides",
    sql: `
      -- One global row (project_id NULL, inherited by every project) plus one row per project;
      -- the merge that serves both lives in src/db/style-guide.ts. The json columns are validated
      -- at write time (the editor's boundary), so the read path must tolerate any stored string
      -- instead of trusting the defaults.
      CREATE TABLE style_guides (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT REFERENCES projects(id),
        markdown TEXT NOT NULL DEFAULT '',
        banned_words TEXT NOT NULL DEFAULT '[]',
        glossary TEXT NOT NULL DEFAULT '{}',
        ${tsRequired("created_at")},
        ${tsRequired("updated_at")},
        UNIQUE (project_id)
      );

      -- sqlite's UNIQUE lets any number of NULL project_id rows through, and its unique indexes
      -- treat NULLs as distinct from each other too, so the partial index cannot key on the bare
      -- column: ON style_guides(project_id) WHERE project_id IS NULL would still admit unlimited
      -- global rows (measured on a bare sqlite). Keying the partial index on the constant boolean
      -- expression instead makes every global row share one index key, so the UNIQUE pins at most
      -- one. Project rows never enter this index; UNIQUE(project_id) owns them.
      CREATE UNIQUE INDEX style_guides_global_idx ON style_guides(project_id IS NULL) WHERE project_id IS NULL;
    `,
  },
  {
    version: 3,
    name: "mark-applied",
    sql: `
      -- mark_applied stores the hash of the text the agent applied; the contract's param table
      -- listed applied_hash a day before the entry schema had a column to hold it (cloudy,
      -- 2026-08-16), so the column lands now, with the doc edit in the same round.
      ALTER TABLE entries ADD COLUMN applied_hash TEXT;
      -- entries_archive mirrors entries column-for-column: the retention sweep copies applied
      -- rows over whole, so it must not lose the new column.
      ALTER TABLE entries_archive ADD COLUMN applied_hash TEXT;
    `,
  },
  {
    version: 4,
    name: "entry-title",
    sql: `
      -- An optional human-readable label the dashboard shows in place of the file basename, so a
      -- row reads as what it changes rather than where it lives (cloudy, 2026-08-20). Nullable:
      -- an entry without one falls back to its anchor text at render. The archive mirrors entries
      -- column-for-column, so it gains the column too.
      ALTER TABLE entries ADD COLUMN title TEXT;
      ALTER TABLE entries_archive ADD COLUMN title TEXT;
    `,
  },
  {
    version: 5,
    name: "entry-images",
    sql: `
      -- Screenshots and links attached to an entry, filed by agents and appended to by the human
      -- on the dashboard. A json array of strings, each a data:image/ data url or an http(s) url;
      -- the wire boundary enforces the shape (max 8, max 5 MiB each). NOT NULL with an empty
      -- array default: an entry without images stores [] like the other json columns. The archive
      -- mirrors entries column-for-column, so it gains the column too.
      ALTER TABLE entries ADD COLUMN images TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE entries_archive ADD COLUMN images TEXT NOT NULL DEFAULT '[]';
    `,
  },
];

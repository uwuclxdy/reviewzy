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
];
